// Shared, deterministic query/evidence rules. Search syntax is provisional until the live probe is reviewed.
import { doiFromUrl, identityKeyForUrl } from "../lib/url.ts";
import { everyInfraXCandidate } from "../sources/everyinfra-x.ts";
import type { Candidate } from "../sources/types.ts";

export interface StoryReport { id: string; url: string; title: string; body: string | null }
export interface StoryQuery {
  format: "doi" | "url" | "phrase";
  needle: string;
  keyword: string;
  articleId: string;
}
const GENERIC = new Set("a an the new study studies research researchers findings reveals reveal shows show how why what and or of in to for with".split(" "));
const words = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function phrase(title: string): string | null {
  if (/[^\p{Script=Latin}\p{N}\p{P}\p{Z}\s]/u.test(title)) return null;
  const tokens = [...title.matchAll(/[a-z]+(?:['’][a-z]+)?/gi)];
  for (let size = 8; size >= 6; size--) for (let i = 0; i + size <= tokens.length; i++) {
    const slice = tokens.slice(i, i + size);
    if (GENERIC.has(slice[0][0].toLowerCase()) || GENERIC.has(slice.at(-1)![0].toLowerCase())) continue;
    if (slice.filter((t) => !GENERIC.has(t[0].toLowerCase())).length < 4) continue;
    return title.slice(slice[0].index, slice.at(-1)!.index! + slice.at(-1)![0].length).replace(/\s+/g, " ");
  }
  return null;
}

function linkToken(input: string): string | null {
  const identity = identityKeyForUrl(input);
  if (!identity?.startsWith("url:")) return null;
  const url = new URL(identity.slice(4));
  if (url.username || url.password || url.pathname === "/" || (url.hostname === "mp.weixin.qq.com" && url.pathname === "/s")) return null;
  // Query-only identities cannot distinguish papers once the query is removed.
  if (/^\/(?:article|view|index)\.(?:php|aspx?)$/i.test(url.pathname) && url.search) return null;
  try {
    const path = decodeURIComponent(url.pathname);
    return /[\s"'?#<>]/.test(path) ? null : `${url.host}${path}`;
  } catch { return null; }
}

/** All three probe formats, rather than the eventual production fallback order. Missing formats stay absent. */
export function probeQueries(reports: StoryReport[], at: Date): StoryQuery[] {
  const found: Array<Omit<StoryQuery, "keyword">> = [];
  const doiReport = reports.find((r) => doiFromUrl(r.url)) ?? reports.find((r) => doiFromUrl(r.body ?? ""));
  if (doiReport) found.push({ format: "doi", needle: (doiFromUrl(doiReport.url) ?? doiFromUrl(doiReport.body ?? ""))!, articleId: doiReport.id });
  const urlReport = reports.find((r) => linkToken(r.url));
  if (urlReport) found.push({ format: "url", needle: linkToken(urlReport.url)!, articleId: urlReport.id });
  const titleReport = reports.find((r) => phrase(r.title));
  if (titleReport) found.push({ format: "phrase", needle: phrase(titleReport.title)!, articleId: titleReport.id });
  return found.map((q) => ({ ...q, keyword: keywordFor(q, at) }));
}

function keywordFor(q: Omit<StoryQuery, "keyword">, at: Date): string {
  const since = new Date(at.getTime() - 7 * 86400_000).toISOString().slice(0, 10);
  return `${q.format === "url" ? `url:${q.needle}` : q.format === "phrase" ? `"${q.needle.replace(/["“”]/g, "")}"` : q.needle} since:${since} -filter:replies`;
}

/** The one query production runs for a story: the phrase of its first report with an English title. Null when none has one. */
export function lookupQuery(reports: StoryReport[], at: Date): StoryQuery | null {
  const report = reports.find((r) => phrase(r.title));
  if (!report) return null;
  const query = { format: "phrase" as const, needle: phrase(report.title)!, articleId: report.id };
  return { ...query, keyword: keywordFor(query, at) };
}

/** Read explicit link fields, never arbitrary metadata (e.g. an author's bio). Do not fetch short links. */
function postLinks(row: Record<string, unknown>): string[] {
  const entities = row.entities && typeof row.entities === "object" ? row.entities as Record<string, unknown> : {};
  return [row.urls, row.links, entities.urls].flatMap((list) => Array.isArray(list) ? list.flatMap((item): string[] => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object") return [];
    return [item.expanded_url, item.url].filter((v): v is string => typeof v === "string");
  }) : []);
}

function matches(row: Record<string, unknown>, query: StoryQuery): boolean {
  const text = typeof row.text === "string" ? row.text : "";
  if (query.format === "phrase") return ` ${words(text)} `.includes(` ${words(query.needle)} `);
  const content = [text, ...postLinks(row)];
  if (query.format === "doi") return content.some((s) => [...s.matchAll(/\b10\.\d{4,9}\/[^\s?#&"<>]+/gi)]
    .some((m) => doiFromUrl(m[0]) === query.needle.toLowerCase()));
  return content.some((s) => [...s.matchAll(/(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/[^\s<>"']+/gi)]
    .some((m) => {
      // Reject a target nested in another address or an email address.
      if (m.index! > 0 && /[\w./@-]/.test(s[m.index! - 1])) return false;
      const token = m[0].replace(/[.,;)\]]+$/, "");
      return linkToken(/^https?:\/\//i.test(token) ? token : `https://${token}`) === query.needle;
    }));
}

export function xPostEngagement(post: Candidate): number {
  const raw = post.raw as Record<string, unknown>;
  return Number(raw.like_count ?? 0) + 2 * Number(raw.share_count ?? 0) + Number(raw.comment_count ?? 0);
}

/** Fresh posts with exact evidence, unique by tweet identity, best five. No model or writes. */
export function matchingXPost(row: unknown, query: StoryQuery, at: Date): Candidate | null {
  const post = everyInfraXCandidate(row);
  if (!post?.publishedAt || post.publishedAt > at || post.publishedAt.getTime() <= at.getTime() - 7 * 86400_000) return null;
  return matches(row as Record<string, unknown>, query) ? post : null;
}

export function matchingXPosts(results: unknown[], query: StoryQuery, at: Date): Candidate[] {
  const unique = new Map<string, Candidate>();
  for (const row of results) {
    const post = matchingXPost(row, query, at);
    if (!post) continue;
    const previous = unique.get(post.identityKey!);
    if (!previous || xPostEngagement(post) > xPostEngagement(previous)) unique.set(post.identityKey!, post);
  }
  return [...unique.values()].sort((a, b) => xPostEngagement(b) - xPostEngagement(a) || a.identityKey!.localeCompare(b.identityKey!)).slice(0, 5);
}
