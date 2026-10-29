// RSS 2.0 / Atom / RDF feeds.
import { XMLParser } from "fast-xml-parser";
import { DEFAULT_UA, guardedFetch } from "../lib/http-fetch.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { sanitizeBody } from "../content/sanitize.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";
import { journalAbstractIssue } from "../content/journal-abstract.ts";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  // XHTML is mixed content: keep its markup and text order for stripTags/sanitizeBody below.
  // Only XHTML stops parsing; escaped HTML and CDATA retain their existing entity handling.
  stopNodes: ["feed.entry.title[type=xhtml]", "feed.entry.summary[type=xhtml]", "feed.entry.content[type=xhtml]"],
});

// Some feeds escape their CDATA wrapper (&lt;![CDATA[…]]&gt;, Psychiatric Times): decoding the entities gives a
// literal wrapper, which stripTags would take for one tag and drop with the whole title inside.
const ESCAPED_CDATA = /^<!\[CDATA\[([\s\S]*)\]\]>$/;

function text(v: unknown, nestedElements = false): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number") return String(v).replace(ESCAPED_CDATA, "$1");
  if (Array.isArray(v)) return text(v[0], nestedElements);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("#cdata" in o) return text(o["#cdata"], nestedElements);
    if ("#text" in o) return text(o["#text"], nestedElements);
    // Some RSS titles wrap their text in an element (Fierce Healthcare uses <a>).
    if (nestedElements) return Object.entries(o).filter(([key]) => !key.startsWith("@")).map(([, child]) => text(child, true)).join(" ");
  }
  return "";
}

function arr<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function parseDate(v: string): Date | null {
  if (!v) return null;
  // Date.parse silently rolls 30 February into March. Validate a recognizable calendar date before
  // accepting the timestamp, while retaining RFC 822 and ISO timezone handling below.
  const iso = /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/.exec(v);
  const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const named = /\b(\d{1,2})\s+([a-z]+)\s+(\d{4})\b/i.exec(v);
  const namedToken = named?.[2]?.toLowerCase() ?? "";
  const namedMonth = named && namedToken.length >= 3 ? monthNames.findIndex((name) => name.startsWith(namedToken)) + 1 : 0;
  const calendar = iso
    ? { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }
    : named
      ? { year: Number(named[3]), month: namedMonth, day: Number(named[1]) }
      : null;
  if (calendar && (calendar.month < 1 || calendar.month > 12 || calendar.year < 1000 || calendar.year > 9999)) return null;
  if (calendar) {
    const check = new Date(Date.UTC(calendar.year, calendar.month - 1, calendar.day));
    if (check.getUTCFullYear() !== calendar.year || check.getUTCMonth() !== calendar.month - 1 || check.getUTCDate() !== calendar.day) return null;
  }
  // Some feeds omit the space before am/pm (Fierce Healthcare: "Oct 28, 2026 5:37pm").
  const normalized = v.replace(/(\d:\d{2})(am|pm)\b/gi, "$1 $2");
  const t = Date.parse(normalized);
  if (Number.isFinite(t)) return new Date(t);
  // RFC 822 variants with Chinese weekday or odd zones
  const cleaned = normalized.replace(/星期[一二三四五六日天]/, "").replace(/\s+/g, " ").trim();
  const t2 = Date.parse(cleaned);
  return Number.isFinite(t2) ? new Date(t2) : null;
}

// Some journal feeds omit pubDate but put a complete publication day in the description. Keep this
// deliberately narrow: accepted/updated dates, month-only labels and arbitrary prose are not publication
// evidence, and a standard feed date always wins over this fallback.
function descriptionPublicationDate(description: string): Date | null {
  const plain = stripTags(description);
  if (!/^Publication date:/i.test(plain)) return null;
  // An online date may follow an issue date, but only before author/abstract text. This avoids taking a
  // date mentioned by the article's own prose as its publication time.
  const header = plain.split(/\b(?:Author\(s\)|Abstract):/i)[0]!;
  const online = /\bAvailable online\s+(\d{1,2})\s+([a-z]+)\s+(\d{4})\b/i.exec(header);
  const issue = /^Publication date:\s*(?:Available online\s+)?(\d{1,2})\s+([a-z]+)\s+(\d{4})\b/i.exec(plain);
  return calendarDay(online) ?? calendarDay(issue);
}

function calendarDay(m: RegExpExecArray | null): Date | null {
  if (!m) return null;
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const month = months.indexOf(m[2]!.toLowerCase());
  if (month < 0) return null;
  const day = Number(m[1]), year = Number(m[3]);
  if (year < 1000 || year > 9999) return null;
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? date : null;
}

function atomLink(links: unknown): string {
  const list = arr(links as Record<string, string> | Array<Record<string, string>>);
  const alt = list.find((l) => typeof l === "object" && (!l["@rel"] || l["@rel"] === "alternate"));
  if (alt && typeof alt === "object") return alt["@href"] ?? "";
  const first = list[0];
  return typeof first === "string" ? first : first?.["@href"] ?? "";
}

function imagesFrom(html: string, base: string): Array<{ kind: "image"; url: string }> {
  const out: Array<{ kind: "image"; url: string }> = [];
  for (const m of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)) {
    try {
      out.push({ kind: "image", url: new URL(m[1]!, base).toString() });
    } catch {
      // ignore bad urls
    }
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Feed text of an editorial source that only teases the article: short and ending in a "read more"
 * mark (The Verge's "Read the full story at The Verge."). Treated as a summary, so extraction fetches
 * the page before the article is judged.
 */
const TEASER_BELOW = 1200;
const TEASER_MARKS = [
  /\bappeared first on\b/i,
  /\bread (?:the )?full (?:story|article)\b/i,
  /\bcontinue reading\b/i,
  /\bread more\b/i,
  /…\s*$/,
  /\[\s*(?:…|\.\.\.)\s*\]\s*$/,
];

export function isTeaser(text: string): boolean {
  const t = text.trim();
  return t.length < TEASER_BELOW && TEASER_MARKS.some((m) => m.test(t));
}

/**
 * The body and excerpt of a feed entry: its text when it is the article, else no body (a summary, or
 * a teaser that stands in as the excerpt when the entry has none).
 */
function feedText(bodyHtml: string | null, summaryHtml: string, source: SourceRow): Pick<Candidate, "excerpt" | "bodyHtml" | "bodyText" | "bodyStatus"> {
  const bodyText = bodyHtml ? stripTags(bodyHtml) : null;
  const teaser = !!bodyText && source.participation_mode === "editorial" && isTeaser(bodyText);
  const summary = summaryHtml ? collapseWhitespace(stripTags(summaryHtml)) : teaser ? collapseWhitespace(bodyText!) : null;
  const journal = source.kind !== "mp_account" && source.tags?.includes("期刊");
  const excerpt = journal ? journalAbstractIssue(summary) ? null : summary : summary?.slice(0, 2000) ?? null;
  return bodyText && bodyText.length > 280 && !teaser
    ? { excerpt, bodyHtml, bodyText, bodyStatus: "ok" }
    : { excerpt, bodyHtml: null, bodyText: null, bodyStatus: "pending" };
}

interface RssValidator {
  configHash: string;
  responseUrl: string;
  etag: string | null;
  lastModified: string | null;
}

export interface RssRead {
  candidates: Candidate[];
  validator: RssValidator;
  notModified: boolean;
}

export async function fetchRss(source: SourceRow, opts: { force?: boolean } = {}): Promise<RssRead> {
  const url = String(source.config.feedUrl ?? "");
  if (!url) throw new FetchError("feedUrl missing");
  // Config changes can alter parsing/filtering even when the upstream bytes did not change.
  const configHash = sha256(stableJson(source.config));
  const previous = !opts.force && source.cursor?.rss?.configHash === configHash ? source.cursor.rss as RssValidator : null;
  // A few official feeds reject the default UA's contact URL while allowing the same transparent
  // crawler name. Keep the override source-local; never impersonate a browser or another crawler.
  const userAgent = typeof source.config.userAgent === "string" && source.config.userAgent.trim() ? source.config.userAgent.trim() : DEFAULT_UA;
  const headers: Record<string, string> = { "user-agent": userAgent, accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8" };
  if (previous?.etag) headers["if-none-match"] = previous.etag;
  if (previous?.lastModified) headers["if-modified-since"] = previous.lastModified;
  let res = await guardedFetch(url, { headers, timeoutMs: 25_000 });
  // A redirect may have changed destinations, whose ETag namespace is unrelated to the old one.
  if (res.status === 304 && previous && res.url !== previous.responseUrl) {
    res = await guardedFetch(url, { headers: { "user-agent": userAgent, accept: headers.accept! }, timeoutMs: 25_000 });
  }
  const validator: RssValidator = {
    configHash, responseUrl: res.url,
    etag: res.headers.get("etag") ?? (res.status === 304 ? previous?.etag ?? null : null),
    lastModified: res.headers.get("last-modified") ?? (res.status === 304 ? previous?.lastModified ?? null : null),
  };
  if (res.status === 304 && previous && (previous.etag || previous.lastModified) && res.url === previous.responseUrl) {
    return { candidates: [], validator, notModified: true };
  }
  if (res.status !== 200) throw new FetchError(`HTTP ${res.status}`, res.status);
  return { candidates: parseRss(res.text(), source, url), validator, notModified: false };
}

/** Shared parser for public feeds. It performs no network or database work and is safe for fixtures. */
export function parseRss(xml: string, source: SourceRow, url: string): Candidate[] {
  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml);
  } catch (e) {
    throw new FetchError(`feed parse error: ${String(e).slice(0, 200)}`);
  }
  const summaryIsBody = source.config.summaryIsBody === true;
  // Entries that are sections of one page (#september-24-2026 …) keep their fragment as identity.
  const identity = (link: string) =>
    source.config.preserveUrlFragment === true ? { identityKey: identityKeyForUrl(link, { keepFragment: true }) ?? undefined } : {};
  const out: Candidate[] = [];

  const channel = doc.rss?.channel ?? doc["rdf:RDF"];
  if (channel) {
    const items = arr(doc.rss?.channel?.item ?? doc["rdf:RDF"]?.item);
    for (const it of items) {
      const link = text(it.link) || text(it.guid);
      const title = collapseWhitespace(stripTags(text(it.title, true)));
      if (!link || !title) continue;
      const contentEncoded = text(it["content:encoded"]);
      const description = text(it.description);
      const bodyHtmlRaw = contentEncoded || (summaryIsBody ? description : "");
      const bodyHtml = bodyHtmlRaw ? sanitizeBody(bodyHtmlRaw, link) : null;
      const enclosure = arr(it.enclosure as Record<string, string> | Array<Record<string, string>>).find((e) => /^image\//.test(e?.["@type"] ?? ""));
      const media = [
        ...(enclosure ? [{ kind: "image" as const, url: enclosure["@url"]! }] : []),
        ...(bodyHtmlRaw ? imagesFrom(bodyHtmlRaw, link) : []),
      ];
      out.push({
        url: link,
        ...identity(link),
        title,
        author: text(it["dc:creator"]) || text(it.author) || null,
        publishedAt: parseDate(text(it.pubDate) || text(it["dc:date"]) || text(it.published)) ?? descriptionPublicationDate(description),
        ...feedText(bodyHtml, description, source),
        media: media.slice(0, 6),
        // RDF 1.0 feeds often publish their taxonomy as dc:subject rather than RSS <category>.
        // Keep both forms so source-level category allowlists see the publisher's real sections.
        categories: [...arr(it.category), ...arr(it["dc:subject"])].map((c) => text(c)).filter(Boolean),
        raw: { guid: text(it.guid) || null },
      });
    }
    return out;
  }

  const feed = doc.feed;
  if (feed) {
    for (const e of arr(feed.entry)) {
      const link = atomLink(e.link);
      const title = collapseWhitespace(stripTags(text(e.title, true)));
      if (!link || !title) continue;
      const content = text(e.content);
      const summary = text(e.summary);
      const bodyHtml = content ? sanitizeBody(content, link) : null;
      const entryUrl = new URL(link, url).toString();
      out.push({
        url: entryUrl,
        ...identity(entryUrl),
        title,
        author: text(arr(e.author)[0]?.name) || null,
        publishedAt: parseDate(text(e.published) || text(e.updated)),
        sourceUpdatedAt: parseDate(text(e.updated)),
        ...feedText(bodyHtml, summary, source),
        media: content ? imagesFrom(content, link) : [],
        categories: arr(e.category).map((c: any) => c?.["@term"] ?? text(c)).filter(Boolean),
        raw: { id: text(e.id) || null },
      });
    }
    return out;
  }
  throw new FetchError("not an RSS/Atom document");
}
