// Web coverage of hot stories (DeepSeek Search, paid per request). Every six hours the leading hot
// candidates and the stories of the last three days that scored 50 or more (selected or not: a story
// one source of ours reports can be covered widely elsewhere) are searched by their Chinese title and,
// when a report has one, its original title. Rules drop what cannot be coverage (no date, older than
// the story, the paper's own scholarly pages, abstract mirrors and bots, copies of our own WeChat or
// Xiaohongshu report, outlets already counted); one model call per story then keeps only
// pages that report or discuss this very study or event. Each kept page is stored as a hot_signal
// article of the external source web-story-lookup and recorded as a signal of the story; its site is
// the participant, so a site counts once however many of its pages appear, and a story reprinted by
// several sites (one wire story, one press release) counts once too.
import { z } from "zod";
import { sql } from "../db.ts";
import { settleNonEditorial } from "../jobs/content.ts";
import { upsertMaterial } from "../content/materials.ts";
import { modelFor } from "../editorial/models.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { chatJson } from "../providers/llm.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { deepseekSearch, deepseekToolsKey, type WebSearchResult } from "../providers/deepseek-tools.ts";
import { recordSignal } from "./group.ts";
import { hotCandidates } from "./hot.ts";

export const WEB_LOOKUP_SOURCE = "web-story-lookup";
const STORIES_PER_RUN = 30;
const MIN_SCORE = 50;
const BUCKET_HOURS = 12;
const MAX_LOOKUPS = 2;
const MAX_JUDGED = 10;
const MAX_KEPT = 5;
const BEFORE_FIRST_REPORT_MS = 3 * 24 * 3600 * 1000;
const MIN_TITLE_OVERLAP = 0.3;
// Pages whose summaries are this close carry the same text: one wire story or press release reprinted
// under other headlines (measured on the evaluation copy: reprints 0.71–0.85, separate reports 0.4–0.6).
const SAME_TEXT = 0.7;
const SUMMARY_CHARS = 200;

// The paper itself (journals, preprint servers, indexes, library proxies) is not coverage of it.
const SCHOLARLY = /(^|\.)(ncbi\.nlm\.nih\.gov|europepmc\.org|semanticscholar\.org|researchgate\.net|academia\.edu|mendeley\.com|ouci\.dntb\.gov\.ua|biorxiv\.org|medrxiv\.org|arxiv\.org|psyarxiv\.com|osf\.io|doi\.org|crossref\.org|openalex\.org|sciencedirect\.com|link\.springer\.com|onlinelibrary\.wiley\.com|tandfonline\.com|journals\.sagepub\.com|academic\.oup\.com|frontiersin\.org|science\.gov|scholar\.archive\.org|cnki\.net|x\.com|twitter\.com|xiaohongshu\.com|psyhot\.cn)$/i;
const PROXIED = /webvpn|ezproxy|^https-/i;
// Not anyone discussing the story: machine-translated abstract mirrors, journal-prediction pages, bots.
const MIRRORS = /(^|\.)(ebiotrade\.com|scilit\.com|epiforecasts\.io|jove\.com|guidelinecentral\.com)$/i;
const FEDIVERSE_POST = /^\/@/;
const TWO_LEVEL = /\.(com|net|org|gov|edu|ac|co)\.(cn|uk|au|jp|hk|tw|nz|in|sg)$/i;

/** The site behind a URL: its registrable domain (m.163.com and www.163.com are both 163.com). */
export function siteOf(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.split(".");
  return labels.slice(TWO_LEVEL.test(host) ? -3 : -2).join(".");
}

/** Who a page counts as: a WeChat article's account, else its site. */
export function webParticipant(url: string): string | null {
  const biz = /[?&]__biz=([^&#]+)/.exec(url)?.[1];
  if (biz && /(^|\.)mp\.weixin\.qq\.com$/i.test(safeHost(url))) return `wechat:${decodeURIComponent(biz)}`;
  const site = siteOf(url);
  return site ? `web:${site}` : null;
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[\p{P}\p{S}\s_]+/gu, "");
function bigrams(s: string): Set<string> {
  const t = norm(s);
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
/** Character-bigram overlap (Dice) of two titles, 0..1; a loose first cut, the model decides. */
export function titleOverlap(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const x of A) if (B.has(x)) shared += 1;
  return (2 * shared) / (A.size + B.size);
}

/** Pages the judge kept, one per text: a reprint joins the first (best-ranked) page of its text. */
export function distinctTexts(kept: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  const text = (c: Candidate) => (c.summary || c.snippet).slice(0, SUMMARY_CHARS);
  for (const c of kept) if (!out.some((o) => titleOverlap(text(o), text(c)) >= SAME_TEXT)) out.push(c);
  return out;
}

export interface LookupStory {
  id: number;
  title: string;
  firstReportAt: Date;
  titles: string[];
  originalTitle: string | null;
  countedSites: Set<string>;
  /** Titles of the story's WeChat and Xiaohongshu reports, normalised: their copies elsewhere (网易号, 搜狐号) are the same author. */
  platformTitles: string[];
}

export interface Candidate extends WebSearchResult {
  participant: string;
  query: string;
}

/** The rules: a dated page from the story's time, not the paper's own pages, from a site not yet counted. */
export function screen(story: LookupStory, found: Array<{ query: string; results: WebSearchResult[] }>, now = new Date()): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const { query, results } of found) {
    for (const r of results) {
      if (!r.date || r.date.getTime() < story.firstReportAt.getTime() - BEFORE_FIRST_REPORT_MS || r.date.getTime() > now.getTime() + 3600_000) continue;
      const host = safeHost(r.url);
      const site = siteOf(r.url);
      const participant = webParticipant(r.url);
      if (!host || !site || !participant || SCHOLARLY.test(host) || PROXIED.test(host) || MIRRORS.test(host) || story.countedSites.has(site)) continue;
      if (FEDIVERSE_POST.test(safePath(r.url)) || story.platformTitles.some((t) => norm(r.title).includes(t))) continue;
      if (Math.max(...story.titles.map((t) => titleOverlap(r.title, t))) < MIN_TITLE_OVERLAP) continue;
      const held = best.get(participant);
      if (!held || (r.rerankScore ?? 0) > (held.rerankScore ?? 0)) best.set(participant, { ...r, participant, query });
    }
  }
  return [...best.values()].sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0)).slice(0, MAX_JUDGED);
}

const CoverageSchema = z.object({
  decisions: z.array(z.object({ id: z.string(), coverage: z.boolean().catch(false) })).catch([]),
});

function coverageUser(story: LookupStory, cands: Candidate[]): string {
  const lines = [`事件：${story.title}`, ...story.titles.slice(1, 4).map((t) => `报道标题：${t}`), "", "候选网页："];
  cands.forEach((c, i) => {
    lines.push(`W${i + 1}｜${c.siteName ?? siteOf(c.url)}｜${c.date!.toISOString().slice(0, 10)}｜${c.title}`);
    const text = (c.summary || c.snippet).replace(/\s+/g, " ").slice(0, 300);
    if (text) lines.push(`  ${text}`);
  });
  return lines.join("\n");
}

async function stories(now: Date): Promise<LookupStory[]> {
  const hot = (await hotCandidates(now)).slice(0, STORIES_PER_RUN).map((r) => Number(r.story_id));
  const recent = await sql<{ id: number }[]>`
    SELECT p.story_id::int AS id, max(p.score) AS score FROM publications p JOIN stories st ON st.id = p.story_id
    WHERE (p.selected OR p.score >= ${MIN_SCORE}) AND p.visibility = 'public' AND st.merged_into IS NULL
      AND coalesce(p.published_at, p.discovered_at) > ${now}::timestamptz - interval '3 days'
      AND (SELECT count(DISTINCT x.bucket) FROM (SELECT r.request->>'bucket' AS bucket FROM receipts r
             WHERE r.service = 'deepseek-tools' AND r.purpose = 'web_story_lookup' AND r.subject = 'story:' || p.story_id) x) < ${MAX_LOOKUPS}
    GROUP BY p.story_id ORDER BY score DESC NULLS LAST LIMIT ${STORIES_PER_RUN}`;
  return loadStories([...new Set([...recent.map((r) => r.id), ...hot])]);
}

/** What a lookup needs of each story: its titles, when it was first reported, the sites already counted. */
export async function loadStories(ids: number[]): Promise<LookupStory[]> {
  if (!ids.length) return [];
  const rows = await sql<{ id: number; title: string; first_report_at: Date | null; created_at: Date; reports: Array<{ title: string; original_title: string | null; url: string; at: string; platform: boolean }> | null; signal_urls: string[] | null }[]>`
    SELECT st.id::int AS id, st.title, st.first_report_at, st.created_at,
      (SELECT json_agg(json_build_object('title', p.title, 'original_title', p.original_title, 'url', p.url, 'at', coalesce(p.published_at, p.discovered_at),
                 'platform', s.kind = 'mp_account' OR coalesce(s.config->>'adapter', '') LIKE 'everyinfra_xhs%' OR p.url LIKE '%mp.weixin.qq.com%' OR p.url LIKE '%xiaohongshu.com%')
               ORDER BY coalesce(p.published_at, p.discovered_at))
         FROM publications p JOIN sources s ON s.id = p.source_id WHERE p.story_id = st.id AND p.visibility = 'public') AS reports,
      (SELECT array_agg(a.url) FROM story_signals ss JOIN articles a ON a.id = ss.article_id WHERE ss.story_id = st.id) AS signal_urls
    FROM stories st WHERE st.id = ANY(${ids}::bigint[]) AND st.merged_into IS NULL`;
  return rows.map((r) => {
    const reports = r.reports ?? [];
    const titles = [r.title, ...reports.flatMap((p) => [p.title, p.original_title ?? ""])].filter((t, i, all) => t && all.indexOf(t) === i);
    const sites = [...reports.map((p) => p.url), ...(r.signal_urls ?? [])].map(siteOf).filter((s): s is string => !!s);
    return {
      id: r.id, title: r.title, firstReportAt: r.first_report_at ?? r.created_at, titles,
      originalTitle: reports.find((p) => p.original_title && p.original_title !== p.title)?.original_title ?? null,
      countedSites: new Set(sites),
      platformTitles: reports.filter((p) => p.platform).flatMap((p) => [p.title, p.original_title ?? ""]).map(norm).filter((t) => t.length >= 8),
    };
  });
}

/** Lookups already made for a story: one per twelve-hour bucket that has a search receipt. */
async function lookupsMade(storyId: number): Promise<{ count: number; thisBucket: boolean; bucket: string }> {
  const bucket = String(Math.floor(Date.now() / (BUCKET_HOURS * 3600_000)));
  const [row] = await sql<{ buckets: string[] | null }[]>`
    SELECT array_agg(DISTINCT request->>'bucket') AS buckets FROM receipts
    WHERE service = 'deepseek-tools' AND purpose = 'web_story_lookup' AND subject = ${`story:${storyId}`}`;
  const buckets = (row?.buckets ?? []).filter(Boolean);
  return { count: buckets.length, thisBucket: buckets.includes(bucket), bucket };
}

async function keep(story: LookupStory, c: Candidate, now: Date): Promise<boolean> {
  const identity = identityKeyForUrl(c.url);
  const [existing] = identity ? await sql<{ id: string; source_id: string }[]>`SELECT id, source_id FROM articles WHERE identity_key = ${identity} AND duplicate_of IS NULL LIMIT 1` : [];
  // A page some source already collected is that source's evidence, counted through its own grouping.
  if (existing && existing.source_id !== WEB_LOOKUP_SOURCE) return false;
  let articleId = existing?.id;
  if (!articleId) {
    const made = await upsertMaterial({
      sourceId: WEB_LOOKUP_SOURCE, url: c.url, title: c.title, publishedAt: c.date, excerpt: (c.snippet || c.summary).slice(0, 500) || null,
      bodyStatus: "none", via: "fetch",
      raw: { participant: c.participant, site: c.siteName, lookup: { storyId: story.id, query: c.query, rerankScore: c.rerankScore, authority: c.authority } },
    });
    articleId = made.articleId;
    await settleNonEditorial(articleId);
  }
  const observed = new Date(Math.min(Math.max(c.date!.getTime(), story.firstReportAt.getTime()), now.getTime()));
  await recordSignal(sql, story.id, articleId, { id: WEB_LOOKUP_SOURCE, signal_group_id: null }, "signal", observed);
  return true;
}

export interface WebLookupResult {
  stories: number;
  looked: number;
  searches: number;
  judged: number;
  kept: number;
  skipped?: string;
}

export async function lookupStoryCoverage(now = new Date()): Promise<WebLookupResult> {
  const out: WebLookupResult = { stories: 0, looked: 0, searches: 0, judged: 0, kept: 0 };
  if (process.env.WEB_STORY_LOOKUP_ENABLED === "false") return { ...out, skipped: "WEB_STORY_LOOKUP_ENABLED=false" };
  if (!deepseekToolsKey()) return { ...out, skipped: "no DeepSeek key" };
  const list = await stories(now);
  out.stories = list.length;
  for (const story of list) {
    const made = await lookupsMade(story.id);
    if (out.looked >= STORIES_PER_RUN) break;
    if (made.thisBucket || made.count >= MAX_LOOKUPS) continue;
    out.looked += 1;
    const got = await lookupStory(story, made.bucket, now);
    out.searches += got.searches;
    out.judged += got.judged.length;
    out.kept += got.kept.length;
  }
  return out;
}

/** One story's lookup: its searches, the candidates the rules let through, and the pages kept as signals. */
export async function lookupStory(story: LookupStory, bucket: string, now = new Date()): Promise<{ searches: number; judged: Candidate[]; kept: Candidate[] }> {
  const queries = [story.title, story.originalTitle].filter((q): q is string => !!q);
  const found: Array<{ query: string; results: WebSearchResult[] }> = [];
  const receipts: number[] = [];
  for (const query of queries) {
    const res = await deepseekSearch(query, { purpose: "web_story_lookup", subject: `story:${story.id}`, window: bucket });
    receipts.push(res.receiptId);
    found.push({ query, results: res.results });
  }
  // The bucket is stored on the receipt so the next run knows this story was looked up.
  await sql`UPDATE receipts SET request = request || ${sql.json({ bucket })} WHERE id = ANY(${receipts}::bigint[])`;
  const judged = screen(story, found, now);
  const kept: Candidate[] = [];
  if (judged.length) {
    const res = await chatJson({
      model: await modelFor("group"), purpose: "web_coverage", subject: `story:${story.id}`, promptVersion: promptVersion("web-coverage"),
      system: promptText("web-coverage"), user: coverageUser(story, judged), schema: CoverageSchema, temperature: 0, maxTokens: 120 + 30 * judged.length,
    });
    const yes = new Set(res.data.decisions.filter((d) => d.coverage).map((d) => d.id));
    for (const c of distinctTexts(judged.filter((_, i) => yes.has(`W${i + 1}`))).slice(0, MAX_KEPT)) if (await keep(story, c, now)) kept.push(c);
    await completeReceipt(sql, res.receiptId);
  }
  for (const id of receipts) await completeReceipt(sql, id);
  return { searches: queries.length, judged, kept };
}
