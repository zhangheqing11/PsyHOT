// JSON sources: plain JSON APIs, JSON embedded in HTML (script tags, window variables).
import { credential } from "../config.ts";
import { DEFAULT_UA, guardedFetch } from "../lib/http-fetch.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { blueskyCandidate, type FeedItem } from "./bluesky.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";
import { everyInfraXCandidate } from "./everyinfra-x.ts";
import { everyInfraCall } from "../providers/everyinfra.ts";
import { journalAbstractIssue } from "../content/journal-abstract.ts";

export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

function firstString(obj: unknown, paths: string[] | undefined): string | null {
  for (const p of paths ?? []) {
    const v = getPath(obj, p);
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/** "{path}" → encoded value, "{raw:path}" → raw value. Returns null when a referenced value is missing. */
export function renderTemplate(template: string, item: unknown): string | null {
  let missing = false;
  const out = template.replace(/\{(raw:)?([^}]+)\}/g, (_m, raw: string | undefined, path: string) => {
    const v = getPath(item, path);
    if (v === undefined || v === null || v === "") {
      missing = true;
      return "";
    }
    return raw ? String(v) : encodeURIComponent(String(v)).replace(/%2F/g, "/");
  });
  return missing ? null : out;
}

/** Parse a source supplied timestamp without allowing JavaScript's date rollover. */
function toDate(v: unknown, unit: string | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  // Crossref date-parts: missing month/day mean the start of the given year/month, always UTC.
  if (Array.isArray(v)) {
    if (v.length < 1 || v.length > 3 || !v.every((n) => typeof n === "number" && Number.isInteger(n))) return null;
    const [year, month = 1, day = 1] = v as number[];
    if (year! < 1000 || year! > 9999) return null;
    const date = new Date(Date.UTC(year!, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
  }
  if (unit === "epoch_ms" || unit === "epoch_s") {
    const date = new Date(Number(v) * (unit === "epoch_s" ? 1000 : 1));
    return Number.isFinite(date.getTime()) ? date : null;
  }
  // 20260922: a calendar day at UTC midnight (some list APIs give dates as yyyymmdd).
  if (unit === "yyyymmdd") {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(v).trim());
    const d = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`) : null;
    return d && Number.isFinite(d.getTime()) && d.toISOString().startsWith(`${m![1]}-${m![2]}-${m![3]}`) ? d : null;
  }
  // A bare number has host-specific Date.parse semantics (for example, "0" is year 2000). Require an
  // explicit epoch or calendar unit instead of silently assigning a misleading publication date.
  if (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v.trim()))) return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t) : null;
}

function findKey(obj: unknown, key: string, depth = 0): unknown {
  if (depth > 12 || obj === null || typeof obj !== "object") return undefined;
  if (!Array.isArray(obj) && key in (obj as Record<string, unknown>)) {
    const v = (obj as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v;
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const found = findKey(v, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function embeddedJson(html: string, source: SourceRow): unknown {
  const mode = source.config.mode;
  if (mode === "html_window_var") {
    const name = String(source.config.windowVar);
    const re = new RegExp(`(?:window\\.)?${name.replace(/[$]/g, "\\$")}\\s*=\\s*`);
    const m = re.exec(html);
    if (!m) throw new FetchError(`window.${name} not found`);
    const start = m.index + m[0].length;
    // Balanced-brace scan to find the object literal's end.
    let depth = 0, inStr: string | null = null, esc = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return JSON.parse(html.slice(start, i + 1));
      }
    }
    throw new FetchError(`window.${name} not terminated`);
  }
  // html_json_key: scan JSON script blocks (e.g. __NEXT_DATA__) for the key.
  const key = String(source.config.jsonKey);
  for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1]!.trim();
    // Flight payloads carry the key escaped inside a string (\"items\").
    if (!body.includes(`"${key}"`) && !body.includes(`\\"${key}\\"`)) continue;
    const candidates = [body, body.replace(/^[^{[]*/, "").replace(/;?\s*$/, "")];
    for (const c of candidates) {
      try {
        const parsed = JSON.parse(c);
        const found = findKey(parsed, key);
        if (found) return { [key]: found };
      } catch {
        // Next.js flight payloads: self.__next_f.push([1,"..."])
      }
    }
    const flight = /"((?:[^"\\]|\\.)*)"\]\)\s*$/.exec(body);
    if (flight) {
      try {
        const decoded = JSON.parse(`"${flight[1]}"`) as string;
        const idx = decoded.indexOf(`"${key}"`);
        if (idx >= 0) {
          const objStart = decoded.lastIndexOf("{", idx);
          const parsed = JSON.parse(decoded.slice(objStart, decoded.indexOf("]", idx) + 1) + "}");
          const found = findKey(parsed, key);
          if (found) return { [key]: found };
        }
      } catch {
        // keep scanning
      }
    }
  }
  throw new FetchError(`embedded key ${key} not found`);
}

/** Search APIs mark the matched words (中国政府网: 健全社会<em>心理</em>服务体系); the marks are no word breaks. */
function unmark(s: string): string {
  return s.replace(/<\/?em>/gi, "");
}

const ENGAGEMENT_KEYS = ["like_count", "collect_count", "comment_count", "share_count"] as const;
function engagementOf(item: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ENGAGEMENT_KEYS) {
    const v = getPath(item, k);
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function xhsParticipant(item: unknown): { participant?: string } {
  const id = getPath(item, "author_id");
  return typeof id === "string" && /^[0-9a-z]{6,40}$/i.test(id) ? { participant: `xhs-author:${id.toLowerCase()}` } : {};
}

export async function fetchJsonList(source: SourceRow): Promise<Candidate[]> {
  return (await fetchJsonListWithDiagnostics(source)).candidates;
}

/** Fetch and map a JSON listing while retaining why records were excluded for run diagnostics. */
export async function fetchJsonListWithDiagnostics(source: SourceRow): Promise<JsonListParseResult> {
  const c = source.config;
  let everyInfraData: unknown = null;
  if (c.adapter === "everyinfra_xhs" || c.adapter === "everyinfra_x") {
    const params = { ...(c.everyinfraParams && typeof c.everyinfraParams === "object" ? c.everyinfraParams : {}) };
    if (c.adapter === "everyinfra_x" && (c.everyinfraAction ?? "search") === "search") {
      const days = Number(c.everyinfraLookbackDays ?? 7);
      if (!Number.isInteger(days) || days < 1 || days > 30) throw new FetchError("X discovery lookback must be 1–30 days");
      if (typeof params.keyword !== "string" || !params.keyword.trim()) throw new FetchError("X discovery keyword required");
      const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
      params.keyword += ` since:${since}`;
    }
    const call = await everyInfraCall<unknown[]>({
      platform: c.adapter === "everyinfra_x" ? "twitter" : "xiaohongshu",
      action: String(c.everyinfraAction ?? "search"),
      params: params as Record<string, unknown>,
      subject: source.id,
      purpose: c.adapter === "everyinfra_x" ? "x_discovery" : "xhs_listing",
      window: String(Math.floor(Date.now() / 600_000)),
    });
    everyInfraData = call.response;
  }
  const url = String(c.url ?? "");
  const headers: Record<string, string> = { accept: "application/json, text/html;q=0.9", ...(c.headers ?? {}) };
  if (typeof c.userAgent === "string" && c.userAgent.trim()) headers["user-agent"] = c.userAgent.trim();
  else if (!Object.keys(headers).some((key) => key.toLowerCase() === "user-agent")) headers["user-agent"] = DEFAULT_UA;
  if (/^https:\/\/api\.github\.com\//.test(url)) {
    const token = credential("collectors", "GITHUB_TOKEN");
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const res = everyInfraData ? null : await guardedFetch(url, {
    method: c.method ?? "GET",
    headers: c.bodyJson ? { ...headers, "content-type": "application/json" } : headers,
    body: c.bodyJson ? JSON.stringify(c.bodyJson) : undefined,
    timeoutMs: 25_000,
  });
  if (res && res.status !== 200) throw new FetchError(`HTTP ${res.status}`, res.status);
  let data: unknown;
  if (everyInfraData) data = everyInfraData;
  else if (c.mode === "html_json_key" || c.mode === "html_window_var") data = embeddedJson(res!.text(), source);
  else {
    try {
      data = JSON.parse(res!.text());
    } catch {
      throw new FetchError("response is not JSON");
    }
  }
  return parseJsonListDetailed(data, source);
}

export interface JsonListExclusion {
  index: number;
  reason: string;
  path?: string;
}

export interface JsonListParseResult {
  candidates: Candidate[];
  exclusions: JsonListExclusion[];
}

/** Map a listing independently of fetching it (also used by offline fixtures). */
export function parseJsonList(data: unknown, source: SourceRow): Candidate[] {
  return parseJsonListDetailed(data, source).candidates;
}

/**
 * Pure JSON-list mapping with explicit exclusion evidence. The fetcher remains a thin HTTP/provider
 * wrapper, so source fixtures can exercise mapping, date fallback and filters without network calls.
 */
export function parseJsonListDetailed(data: unknown, source: SourceRow): JsonListParseResult {
  const c = source.config;
  const bluesky = c.adapter === "bluesky_feed";
  let items = c.itemsPath ? getPath(data, c.itemsPath) : c.jsonKey ? getPath(data, c.jsonKey) : c.adapter?.startsWith("everyinfra_") ? getPath(data, "results") : bluesky ? getPath(data, "feed") : data;
  if (c.itemsObjectValues && items && typeof items === "object" && !Array.isArray(items)) items = Object.values(items);
  if (!Array.isArray(items)) throw new FetchError("items path did not resolve to an array");
  if (c.adapter === "everyinfra_x") return { candidates: items.map(everyInfraXCandidate).filter((x): x is Candidate => !!x), exclusions: [] };
  if (bluesky) return { candidates: items.map((i) => blueskyCandidate(i as FeedItem)).filter((x): x is Candidate => !!x), exclusions: [] };

  if (c.excludePatterns !== undefined && (!c.excludePatterns || typeof c.excludePatterns !== "object" || Array.isArray(c.excludePatterns))) {
    throw new FetchError("excludePatterns must map field paths to regular-expression strings");
  }
  const exclusions = Object.entries(c.excludePatterns ?? {}).map(([path, pattern]) => {
    if (typeof path !== "string" || !path || typeof pattern !== "string") throw new FetchError("excludePatterns must map field paths to regular-expression strings");
    try {
      return [path, new RegExp(pattern, "i")] as const;
    } catch (error) {
      throw new FetchError(`invalid regular expression for excludePatterns.${path}: ${String(error).slice(0, 160)}`);
    }
  });
  const datePaths: string[] = c.publishedAtPaths === undefined
    ? (() => {
      const path = c.publishedAtPath ?? (c.adapter === "everyinfra_xhs" ? "posted_at" : "");
      if (typeof path !== "string" || (c.publishedAtPath !== undefined && !path.trim())) throw new FetchError("publishedAtPath must be a non-empty field path");
      return [path];
    })()
    : Array.isArray(c.publishedAtPaths) && c.publishedAtPaths.every((p: unknown) => typeof p === "string" && p.trim())
      ? c.publishedAtPaths
      : (() => { throw new FetchError("publishedAtPaths must be an array of field paths"); })();
  const excluded: JsonListExclusion[] = [];
  const out: Candidate[] = [];
  for (const [index, item] of items.entries()) {
    const matchingPattern = exclusions.find(([path, pattern]) => {
      const value = getPath(item, path);
      return typeof value === "string" && pattern.test(value.trim());
    });
    if (matchingPattern) {
      excluded.push({ index, reason: "exclude-pattern", path: matchingPattern[0] });
      continue;
    }
    if (c.requireBoolean && getPath(item, c.requireBoolean.path) !== c.requireBoolean.equals) {
      excluded.push({ index, reason: "require-boolean", path: String(c.requireBoolean.path) });
      continue;
    }
    if (c.minNumeric && !(Number(getPath(item, c.minNumeric.path)) >= Number(c.minNumeric.min))) {
      excluded.push({ index, reason: "min-numeric", path: String(c.minNumeric.path) });
      continue;
    }
    if (c.adapter === "everyinfra_xhs" && getPath(item, "is_goods_note") === true) {
      excluded.push({ index, reason: "goods-note" });
      continue;
    }
    const title = firstString(item, c.titlePaths ?? (c.adapter === "everyinfra_xhs" ? ["title"] : undefined));
    const url = (c.urlTemplate && renderTemplate(c.urlTemplate, item)) || (c.urlTemplateFallback && renderTemplate(c.urlTemplateFallback, item)) ||
      (c.adapter === "everyinfra_xhs" ? renderTemplate("{raw:url}", item) : null);
    if (!title || !url) {
      excluded.push({ index, reason: !title ? "missing-title" : "missing-url" });
      continue;
    }
    const externalId = c.externalIdPath ? getPath(item, c.externalIdPath) : c.adapter === "everyinfra_xhs" ? getPath(item, "id") : null;
    const summary = firstString(item, c.summaryPaths ?? (c.adapter === "everyinfra_xhs" ? ["text"] : undefined));
    const raw = item && typeof item === "object" ? { ...(item as Record<string, unknown>) } : { value: item };
    for (const k of c.rawDropKeys ?? []) delete (raw as Record<string, unknown>)[k];
    const summaryIsBody = c.summaryIsBody === true && !!summary;
    const summaryText = summary ? collapseWhitespace(stripTags(unmark(summary))) : null;
    const journal = source.kind !== "mp_account" && source.tags?.includes("期刊");
    out.push({
      url,
      title: collapseWhitespace(stripTags(unmark(title))),
      author: firstString(item, c.authorPaths ?? (c.adapter === "everyinfra_xhs" ? ["author_name"] : undefined)),
      publishedAt: datePaths.map((path) => toDate(getPath(item, path), c.publishedAtUnit)).find((date) => date !== null) ?? null,
      excerpt: journal ? journalAbstractIssue(summaryText) ? null : summaryText : summaryText?.slice(0, 2000) ?? null,
      bodyText: summaryIsBody ? stripTags(unmark(summary!)) : null,
      bodyStatus: summaryIsBody ? "ok" : "pending",
      // Xiaohongshu's public counts at listing time: the hot ranking weighs a participant by them.
      // The note's author, not the keyword that found it, is the participant.
      raw: { externalId: externalId ?? null, ...(c.adapter === "everyinfra_xhs" ? { ...engagementOf(item), ...xhsParticipant(item) } : {}) },
    });
  }
  const intentionallyExcluded = excluded.filter((e) => !e.reason.startsWith("missing-")).length;
  if (items.length > intentionallyExcluded && out.length === 0 && !c.requireBoolean && !c.minNumeric) throw new FetchError("no items mapped (check title/url paths)");
  return { candidates: out, exclusions: excluded };
}
