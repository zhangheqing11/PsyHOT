// Abstracts for journal items whose feed and page give none (ScienceDirect behind a robot check, Taylor &
// Francis feeds with an empty summary). The article is looked up in open scholarly metadata, OpenAlex
// first (same-day records), then Europe PMC, then Crossref: by DOI when there is one (in the link, or a
// ScienceDirect PII turned into a DOI through Crossref), otherwise by an exact title match. A found
// abstract becomes the article's excerpt in a new revision, so the item is analysed again in full and
// scored. Indexes lag, so a miss is retried on a widening schedule and given up after the last try.
// These are free public APIs: no receipts, no keys; they run only while collection is on.
import { sql } from "../db.ts";
import { thinText } from "../editorial/writing.ts";
import { queueProcessing } from "../jobs/content.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { contentHash } from "./materials.ts";

/** Hours to the next try after each miss; the item is given up after the last. */
const RETRY_HOURS = [6, 24, 72, 168, 336];
/** Only recent items are looked up: older ones would arrive as history anyway. */
const LOOKBACK_DAYS = 45;
/** Fewer characters is a fragment, not an abstract. */
const MIN_ABSTRACT_CHARS = 200;
const MAX_ABSTRACT_CHARS = 6000;

const apis = () => ({
  openalex: process.env.OPENALEX_API_URL ?? "https://api.openalex.org",
  crossref: process.env.CROSSREF_API_URL ?? "https://api.crossref.org",
  europepmc: process.env.EUROPEPMC_API_URL ?? "https://www.ebi.ac.uk/europepmc/webservices/rest",
});

export interface FoundAbstract {
  provider: "openalex" | "europepmc" | "crossref";
  doi: string | null;
  text: string;
}

/** The DOI in an article link (Taylor & Francis, Wiley, SAGE and others put it in the path). */
export function doiFromUrl(url: string): string | null {
  let s = url;
  try {
    s = decodeURIComponent(url);
  } catch {
    // keep the raw link
  }
  const m = /\b(10\.\d{4,9}\/[^\s?#&"<>]+)/.exec(s);
  return m ? m[1]!.replace(/[.,;)]+$/, "").toLowerCase() : null;
}

/** ScienceDirect's article id (PII) in a link such as /science/article/pii/S0272735826001121. */
export function piiFromUrl(url: string): string | null {
  return /\/pii\/(S?[0-9X]{16,17})\b/i.exec(url)?.[1]?.toUpperCase() ?? null;
}

const normTitle = (t: string) => stripTags(t).normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The same title once markup, case and punctuation are set aside (or one is the other plus a short tail). */
export function sameTitle(a: string, b: string): boolean {
  const x = normTitle(a);
  const y = normTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return long.startsWith(short) && short.length / long.length >= 0.8;
}

/** OpenAlex keeps abstracts as word → positions. */
export function invertedToText(index: Record<string, number[]> | null | undefined): string {
  if (!index) return "";
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words.push([p, word]);
  return words.sort((a, b) => a[0] - b[0]).map(([, w]) => w).join(" ");
}

/** Markup (JATS, HTML) and a leading "Abstract" label removed; null when too short to be one. */
export function cleanAbstract(raw: string | null | undefined): string | null {
  const text = collapseWhitespace(stripTags(raw ?? "").replace(/^\s*abstract\s*[:.]?\s*/i, ""));
  return text.length >= MIN_ABSTRACT_CHARS ? text.slice(0, MAX_ABSTRACT_CHARS) : null;
}

async function getJson(url: string): Promise<any | null> {
  const res = await guardedFetch(url, { timeoutMs: 20_000, headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  return JSON.parse(res.text());
}

/** Title search terms: the filter and query syntaxes take commas, colons and pipes as operators. */
const searchTerms = (title: string) => normTitle(title).slice(0, 200);

async function doiForPii(pii: string): Promise<string | null> {
  const data = await getJson(`${apis().crossref}/works?filter=alternative-id:${encodeURIComponent(pii)}&rows=1&select=DOI`);
  const doi = data?.message?.items?.[0]?.DOI;
  return typeof doi === "string" ? doi.toLowerCase() : null;
}

async function fromOpenAlex(doi: string | null, title: string): Promise<string | null> {
  const base = apis().openalex;
  const select = "select=doi,title,abstract_inverted_index";
  if (doi) {
    const work = await getJson(`${base}/works/doi:${encodeURI(doi)}?${select}`);
    return cleanAbstract(invertedToText(work?.abstract_inverted_index));
  }
  const data = await getJson(`${base}/works?filter=title.search:${encodeURIComponent(searchTerms(title))}&per-page=5&${select}`);
  const work = (data?.results ?? []).find((w: { title?: string }) => w.title && sameTitle(w.title, title));
  return cleanAbstract(invertedToText(work?.abstract_inverted_index));
}

async function fromEuropePmc(doi: string | null, title: string): Promise<string | null> {
  const query = doi ? `DOI:"${doi}"` : `TITLE:"${searchTerms(title)}"`;
  const data = await getJson(`${apis().europepmc}/search?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=3`);
  const hits: Array<{ title?: string; doi?: string; abstractText?: string }> = data?.resultList?.result ?? [];
  const hit = hits.find((r) => (doi ? r.doi?.toLowerCase() === doi : !!r.title && sameTitle(r.title, title)));
  return cleanAbstract(hit?.abstractText);
}

async function fromCrossref(doi: string | null, title: string): Promise<string | null> {
  const base = apis().crossref;
  if (doi) return cleanAbstract((await getJson(`${base}/works/${encodeURI(doi)}`))?.message?.abstract);
  const data = await getJson(`${base}/works?query.bibliographic=${encodeURIComponent(searchTerms(title))}&rows=3&select=DOI,title,abstract`);
  const item = (data?.message?.items ?? []).find((i: { title?: string[] }) => i.title?.[0] && sameTitle(i.title[0], title));
  return cleanAbstract(item?.abstract);
}

/** The abstract of an article from the first open source that has it; errors of one source do not stop the next. */
export async function findAbstract(a: { title: string; url: string }): Promise<{ found: FoundAbstract | null; errors: string[] }> {
  const errors: string[] = [];
  let doi = doiFromUrl(a.url);
  const pii = doi ? null : piiFromUrl(a.url);
  if (pii) {
    try {
      doi = await doiForPii(pii);
    } catch (error) {
      errors.push(`crossref pii: ${(error as Error).message}`);
    }
  }
  const sources = [["openalex", fromOpenAlex], ["europepmc", fromEuropePmc], ["crossref", fromCrossref]] as const;
  for (const [provider, lookup] of sources) {
    try {
      const text = await lookup(doi, a.title);
      if (text) return { found: { provider, doi, text }, errors };
    } catch (error) {
      errors.push(`${provider}: ${(error as Error).message}`);
    }
  }
  return { found: null, errors };
}

/** The abstract as the article's excerpt in a new revision, unless a body or an abstract got there first. */
async function saveAbstract(articleId: string, text: string): Promise<boolean> {
  const saved = await sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; body_text: string | null; excerpt: string | null }[]>`
      SELECT title, body_text, excerpt FROM articles WHERE id = ${articleId} FOR UPDATE`;
    if (!row || row.body_text?.trim() || !thinText(row.excerpt)) return false;
    const hash = contentHash({ title: row.title, bodyText: row.body_text, excerpt: text });
    const [r] = await tx<{ revision: number }[]>`
      UPDATE articles SET excerpt = ${text}, revision = revision + 1, content_hash = ${hash}, processing_state = 'new', updated_at = now()
      WHERE id = ${articleId} RETURNING revision`;
    await tx`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
             VALUES (${articleId}, ${r!.revision}, ${hash}, ${row.title}, ${null})`;
    return true;
  });
  if (saved) await queueProcessing(articleId);
  return saved;
}

/**
 * Looks up abstracts for recent editorial items that have only a title (thinText), due by their retry
 * schedule. Returns how many were tried and found.
 */
export async function enrichThinAbstracts(limit = 30): Promise<{ tried: number; found: number }> {
  const rows = await sql<{ id: string; title: string; url: string; excerpt: string | null; attempts: number | null }[]>`
    SELECT a.id, a.title, a.url, a.excerpt, l.attempts
    FROM articles a JOIN sources s ON s.id = a.source_id
    LEFT JOIN abstract_lookups l ON l.article_id = a.id
    WHERE s.participation_mode = 'editorial' AND s.enabled AND a.x_post IS NULL
      AND coalesce(a.body_text, '') = '' AND a.body_status NOT IN ('ok', 'pending')
      AND a.discovered_at > now() - make_interval(days => ${LOOKBACK_DAYS})
      AND (l.article_id IS NULL OR (l.found_at IS NULL AND l.attempts <= ${RETRY_HOURS.length} AND l.next_try_at <= now()))
    ORDER BY a.discovered_at DESC
    LIMIT ${limit * 3}`;
  let tried = 0;
  let found = 0;
  for (const row of rows) {
    if (tried >= limit) break;
    if (!thinText(row.excerpt)) continue;
    tried += 1;
    const attempts = (row.attempts ?? 0) + 1;
    const { found: hit, errors } = await findAbstract(row);
    const saved = hit ? await saveAbstract(row.id, hit.text) : false;
    if (saved) found += 1;
    const waitHours = RETRY_HOURS[Math.min(attempts - 1, RETRY_HOURS.length - 1)]!;
    await sql`
      INSERT INTO abstract_lookups (article_id, attempts, next_try_at, found_at, provider, doi, last_error, updated_at)
      VALUES (${row.id}, ${attempts}, now() + make_interval(hours => ${waitHours}), ${saved ? new Date() : null},
              ${hit?.provider ?? null}, ${hit?.doi ?? null}, ${errors.join("; ").slice(0, 500) || null}, now())
      ON CONFLICT (article_id) DO UPDATE SET attempts = EXCLUDED.attempts, next_try_at = EXCLUDED.next_try_at,
        found_at = EXCLUDED.found_at, provider = EXCLUDED.provider, doi = coalesce(EXCLUDED.doi, abstract_lookups.doi),
        last_error = EXCLUDED.last_error, updated_at = now()`;
  }
  return { tried, found };
}
