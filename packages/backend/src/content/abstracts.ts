// Recover missing journal abstracts from identified stored/publisher HTML, then open scholarly metadata
// (ScienceDirect behind a robot check, Taylor & Francis feeds with an empty summary). Metadata uses
// OpenAlex first (same-day records), then Europe PMC, then Crossref: by DOI when there is one (in the link, or a
// ScienceDirect PII turned into a DOI through Crossref), otherwise by an exact title match. A found
// abstract becomes the article's excerpt in a new revision, so the item is analysed again in full and
// scored. Indexes lag, so a miss is retried on a widening schedule and given up after the last try.
// These are free public APIs: no receipts, no keys; they run only while collection is on. The site's
// contact address (SITE.contactEmail) goes with Crossref and OpenAlex requests, as both ask.
import { SITE } from "@aihot/industry/site";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { thinText } from "../editorial/writing.ts";
import { queueProcessing } from "../jobs/content.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { doiFromUrl } from "../lib/url.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { contentHash } from "./materials.ts";
import { pageFetchable } from "./extract.ts";
import { journalAbstractFromHtml, journalAbstractIssue, journalAbstractUnavailable } from "./journal-abstract.ts";

/** Hours to the next try after each miss; the item is given up after the last. */
const RETRY_HOURS = [6, 24, 72, 168, 336];
/** Preserve the existing metadata-only lookback for body-less preprints. Journals use the reading window. */
const LOOKBACK_DAYS = 45;
/** Fewer characters is a fragment, not an abstract. */
const MIN_ABSTRACT_CHARS = 200;
const MAX_ABSTRACT_CHARS = 6000;
/** Existing lookups predate publisher/quality recovery; admit one pass without resetting their retry budget. */
const JOURNAL_QUALITY_PASS = "journal-abstract-quality-v1:";

const apis = () => ({
  openalex: process.env.OPENALEX_API_URL ?? "https://api.openalex.org",
  crossref: process.env.CROSSREF_API_URL ?? "https://api.crossref.org",
  europepmc: process.env.EUROPEPMC_API_URL ?? "https://www.ebi.ac.uk/europepmc/webservices/rest",
});

export { doiFromUrl };

export interface FoundAbstract {
  provider: "openalex" | "europepmc" | "crossref" | "stored_html" | "publisher_html";
  doi: string | null;
  text: string;
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

function cleanJournalAbstract(raw: string | null | undefined): string | null {
  const text = collapseWhitespace(stripTags(raw ?? "").replace(/^\s*abstract\s*[:.]?\s*/i, ""));
  return journalAbstractIssue(text, { identified: true }) ? null : text;
}

/** Crossref and OpenAlex serve requests that carry a contact address from a less throttled pool. */
const polite = (url: string) => (SITE.contactEmail ? `${url}${url.includes("?") ? "&" : "?"}mailto=${encodeURIComponent(SITE.contactEmail)}` : url);

async function getJson(url: string): Promise<any | null> {
  const res = await guardedFetch(url, { timeoutMs: 20_000, headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  return JSON.parse(res.text());
}

/** Title search terms: the filter and query syntaxes take commas, colons and pipes as operators. */
const searchTerms = (title: string) => normTitle(title).slice(0, 200);

async function doiForPii(pii: string): Promise<string | null> {
  const data = await getJson(polite(`${apis().crossref}/works?filter=alternative-id:${encodeURIComponent(pii)}&rows=1&select=DOI`));
  const doi = data?.message?.items?.[0]?.DOI;
  return typeof doi === "string" ? doi.toLowerCase() : null;
}

async function fromOpenAlex(doi: string | null, title: string, clean = cleanAbstract): Promise<string | null> {
  const base = apis().openalex;
  const select = "select=doi,title,abstract_inverted_index";
  if (doi) {
    const work = await getJson(polite(`${base}/works/doi:${encodeURI(doi)}?${select}`));
    return clean(invertedToText(work?.abstract_inverted_index));
  }
  const data = await getJson(polite(`${base}/works?filter=title.search:${encodeURIComponent(searchTerms(title))}&per-page=5&${select}`));
  const work = (data?.results ?? []).find((w: { title?: string }) => w.title && sameTitle(w.title, title));
  return clean(invertedToText(work?.abstract_inverted_index));
}

async function fromEuropePmc(doi: string | null, title: string, clean = cleanAbstract): Promise<string | null> {
  const query = doi ? `DOI:"${doi}"` : `TITLE:"${searchTerms(title)}"`;
  const data = await getJson(`${apis().europepmc}/search?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=3`);
  const hits: Array<{ title?: string; doi?: string; abstractText?: string }> = data?.resultList?.result ?? [];
  const hit = hits.find((r) => (doi ? r.doi?.toLowerCase() === doi : !!r.title && sameTitle(r.title, title)));
  return clean(hit?.abstractText);
}

async function fromCrossref(doi: string | null, title: string, clean = cleanAbstract): Promise<string | null> {
  const base = apis().crossref;
  if (doi) return clean((await getJson(polite(`${base}/works/${encodeURI(doi)}`)))?.message?.abstract);
  const data = await getJson(polite(`${base}/works?query.bibliographic=${encodeURIComponent(searchTerms(title))}&rows=3&select=DOI,title,abstract`));
  const item = (data?.message?.items ?? []).find((i: { title?: string[] }) => i.title?.[0] && sameTitle(i.title[0], title));
  return clean(item?.abstract);
}

/** The abstract of an article from the first open source that has it; errors of one source do not stop the next. */
export async function findAbstract(a: { title: string; url: string }, opts: { journal?: boolean } = {}): Promise<{ found: FoundAbstract | null; errors: string[] }> {
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
      const text = await lookup(doi, a.title, opts.journal ? cleanJournalAbstract : cleanAbstract);
      if (text) return { found: { provider, doi, text }, errors };
    } catch (error) {
      errors.push(`${provider}: ${(error as Error).message}`);
    }
  }
  return { found: null, errors };
}

/** Store the result against its input revision; a verified excerpt and its lookup commit together. */
async function saveRecovery(expected: RecoveryRow, result: RecoveryResult): Promise<boolean> {
  const saved = await sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; body_text: string | null; excerpt: string | null; revision: number; journal: boolean; identified: boolean }[]>`
      SELECT a.title, a.body_text, a.excerpt, a.revision, (s.tags @> ARRAY['期刊']::text[]) AS journal,
        EXISTS (SELECT 1 FROM abstract_lookups l WHERE l.article_id = a.id AND l.found_at IS NOT NULL) AS identified
      FROM articles a JOIN sources s ON s.id = a.source_id
      WHERE a.id = ${expected.id} AND a.duplicate_of IS NULL AND a.x_post IS NULL
        AND s.enabled AND s.participation_mode = 'editorial' AND s.kind NOT IN ('mp_account', 'x_search')
        AND a.body_status <> 'pending'
        AND ((s.tags @> ARRAY['期刊']::text[] AND a.discovered_at >= now() - make_interval(days => ${Math.max(1, config.abstractTranslationDays)}))
          OR (NOT s.tags @> ARRAY['期刊']::text[] AND s.tags @> ARRAY['预印本']::text[]
            AND coalesce(a.body_text, '') = '' AND a.body_status <> 'ok'
            AND a.discovered_at > now() - make_interval(days => ${LOOKBACK_DAYS})))
      FOR UPDATE OF a`;
    // A slower lookup must never clear a newer success or mark a different revision unavailable.
    if (!row || row.revision !== expected.revision || (row.journal ? !journalAbstractIssue(row.excerpt, { identified: row.identified }) : !thinText(row.excerpt))) return false;
    const hit = result.found;
    if (hit) {
      const hash = contentHash({ title: row.title, bodyText: row.body_text, excerpt: hit.text });
      const [r] = await tx<{ revision: number }[]>`
        UPDATE articles SET excerpt = ${hit.text}, revision = revision + 1, content_hash = ${hash}, processing_state = 'new', updated_at = now()
        WHERE id = ${expected.id} RETURNING revision`;
      await tx`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
               VALUES (${expected.id}, ${r!.revision}, ${hash}, ${row.title}, ${row.body_text})`;
    }
    const attempts = (expected.attempts ?? 0) + 1;
    const waitHours = RETRY_HOURS[Math.min(attempts - 1, RETRY_HOURS.length - 1)]!;
    const lastError = `${row.journal ? JOURNAL_QUALITY_PASS : ""}${result.errors.join("; ")}`.slice(0, 500) || null;
    await tx`
      INSERT INTO abstract_lookups (article_id, attempts, next_try_at, found_at, provider, doi, last_error, updated_at)
      VALUES (${expected.id}, ${attempts}, now() + make_interval(hours => ${waitHours}), ${hit ? new Date() : null},
              ${result.unavailable ? "publisher_no_abstract" : hit?.provider ?? null}, ${hit?.doi ?? null}, ${lastError}, now())
      ON CONFLICT (article_id) DO UPDATE SET attempts = EXCLUDED.attempts, next_try_at = EXCLUDED.next_try_at,
        found_at = EXCLUDED.found_at, provider = EXCLUDED.provider, doi = coalesce(EXCLUDED.doi, abstract_lookups.doi),
        last_error = EXCLUDED.last_error, updated_at = now()`;
    return !!hit;
  });
  if (saved) await queueProcessing(expected.id);
  return saved;
}

interface RecoveryRow {
  id: string; title: string; url: string; excerpt: string | null; body_html: string | null;
  revision: number; journal: boolean; source_kind: string; attempts: number | null; cursor_discovered_at: string;
  identified: boolean;
}

interface RecoveryResult { found: FoundAbstract | null; errors: string[]; unavailable?: boolean }

async function recoverAbstract(row: RecoveryRow): Promise<RecoveryResult> {
  const errors: string[] = [];
  let unavailable = false;
  if (row.journal) {
    const stored = journalAbstractFromHtml(row.body_html, { storedBody: true, url: row.url });
    if (stored) return { found: { text: stored, provider: "stored_html", doi: doiFromUrl(row.url) }, errors };
    try {
      // A raw publisher page may contain an explicit abstract that Readability omitted. No browser
      // rendering or paid fallback is used here; a blocked page proceeds to public metadata.
      const res = await guardedFetch(row.url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024 });
      if (res.status === 200 && /html/i.test(res.headers.get("content-type") ?? "")) {
        const html = res.text();
        const text = journalAbstractFromHtml(html);
        if (text) return { found: { text, provider: "publisher_html", doi: doiFromUrl(row.url) }, errors };
        unavailable = journalAbstractUnavailable(html);
      } else if (res.status !== 200) errors.push(`publisher: HTTP ${res.status}`);
    } catch (error) {
      errors.push(`publisher: ${(error as Error).message}`);
    }
  }
  const result = await findAbstract(row, { journal: row.journal });
  return { found: result.found, errors: [...errors, ...result.errors], unavailable: unavailable && !result.found };
}

/** Recover recent journal abstracts independently of full bodies; retain preprints' metadata path. */
export async function enrichThinAbstracts(limit = 30): Promise<{ tried: number; found: number }> {
  let tried = 0;
  let found = 0;
  let cursor: { id: string; discoveredAt: string } | null = null;
  const pageSize = Math.max(1, limit * 3);
  while (tried < limit) {
    const rows: RecoveryRow[] = await sql<RecoveryRow[]>`
      SELECT a.id, a.title, a.url, a.excerpt, a.body_html, a.revision, l.attempts, s.kind AS source_kind,
        (s.tags @> ARRAY['期刊']::text[]) AS journal, (l.found_at IS NOT NULL) AS identified,
        a.discovered_at::text AS cursor_discovered_at
      FROM articles a JOIN sources s ON s.id = a.source_id
      LEFT JOIN abstract_lookups l ON l.article_id = a.id
      WHERE s.participation_mode = 'editorial' AND s.enabled AND s.kind NOT IN ('mp_account', 'x_search')
        AND a.x_post IS NULL AND a.duplicate_of IS NULL AND a.body_status <> 'pending'
        AND ((s.tags @> ARRAY['期刊']::text[] AND a.discovered_at >= now() - make_interval(days => ${Math.max(1, config.abstractTranslationDays)}))
          OR (NOT s.tags @> ARRAY['期刊']::text[] AND s.tags @> ARRAY['预印本']::text[]
            AND coalesce(a.body_text, '') = '' AND a.body_status <> 'ok'
            AND a.discovered_at > now() - make_interval(days => ${LOOKBACK_DAYS})))
        AND (l.article_id IS NULL
          OR (l.found_at IS NULL AND l.provider IS DISTINCT FROM 'publisher_no_abstract'
            AND l.attempts <= ${RETRY_HOURS.length} AND l.next_try_at <= now())
          OR (s.tags @> ARRAY['期刊']::text[] AND coalesce(l.last_error, '') NOT LIKE ${`${JOURNAL_QUALITY_PASS}%`}))
        AND (${cursor?.id ?? null}::text IS NULL OR (a.discovered_at, a.id) < (${cursor?.discoveredAt ?? null}::timestamptz, ${cursor?.id ?? null}::text))
      ORDER BY a.discovered_at DESC, a.id DESC
      LIMIT ${pageSize}`;
    for (const row of rows) {
      if (tried >= limit) break;
      const needsRecovery = row.journal ? !!journalAbstractIssue(row.excerpt, { identified: row.identified }) : thinText(row.excerpt);
      if (!needsRecovery || !pageFetchable(row.url, row.source_kind)) continue;
      tried += 1;
      const saved = await saveRecovery(row, await recoverAbstract(row));
      if (saved) found += 1;
    }
    if (rows.length < pageSize) break;
    const last = rows[rows.length - 1]!;
    // Keep PostgreSQL's timestamp precision so equal-millisecond rows cannot fall between pages.
    cursor = { id: last.id, discoveredAt: last.cursor_discovered_at };
  }
  return { tried, found };
}
