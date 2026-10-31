// X discussion of hot stories (EveryInfra, paid per request). Every six hours the leading hot candidates
// and the stories of the last three days that scored 50 or more (selected or not) are searched once on
// X by an exact phrase of an English report title; a story whose reports have no such title is not
// searched. Rules alone judge the answer (events/x-story-query.ts: the post must contain the whole
// phrase, be under a week old, one per tweet, the best five); no model is called. Each kept post is
// stored as a hot_signal article of the external source x-story-lookup and recorded as a signal of the
// story; its account is the participant, so an account counts once however many of its posts appear.
import { credential } from "../config.ts";
import { sql } from "../db.ts";
import { settleNonEditorial } from "../jobs/content.ts";
import { upsertMaterial } from "../content/materials.ts";
import { everyInfraCall } from "../providers/everyinfra.ts";
import { BudgetExceededError, completeReceipt, ReceiptBusyError, ReceiptUnknownError } from "../providers/receipts.ts";
import type { Candidate } from "../sources/types.ts";
import { recordSignal } from "./group.ts";
import { hotCandidates } from "./hot.ts";
import { lookupQuery, matchingXPosts, type StoryQuery } from "./x-story-query.ts";

export const X_LOOKUP_SOURCE = "x-story-lookup";
const STORIES_PER_RUN = 3;
// Stories read from each candidate list: more than a run searches, since some have no phrase to search.
const CANDIDATES = 100;
const MIN_SCORE = 50;
const BUCKET_HOURS = 12;
const MAX_LOOKUPS = 2;
// Cap X accounts so international stories do not overwhelm domestic stories absent from X.
const MAX_PARTICIPANTS = 3;
// An empty search takes 50-70 seconds (and is not billed); the default 60 would turn it into "unknown".
export const TIMEOUT_MS = 150_000;

export interface XLookupStory {
  id: number;
  firstReportAt: Date;
  query: StoryQuery;
}

// Both candidate paths use the same receipt count and second-lookup condition (st is the story).
const lookupEligible = sql`(
  SELECT made.n < ${MAX_LOOKUPS}
  AND (SELECT count(DISTINCT participant_key) FROM story_signals WHERE story_id = st.id AND source_id = ${X_LOOKUP_SOURCE}) < ${MAX_PARTICIPANTS}
  AND (
    made.n = 0
    OR EXISTS (SELECT 1 FROM story_signals ss WHERE ss.story_id = st.id AND ss.source_id = ${X_LOOKUP_SOURCE})
    OR EXISTS (SELECT 1 FROM story_signals ss WHERE ss.story_id = st.id AND ss.source_id <> ${X_LOOKUP_SOURCE} AND ss.observed_at > made.first_at)
  ) FROM (
    SELECT count(DISTINCT r.request->>'bucket') AS n, min(r.created_at) AS first_at FROM receipts r
    WHERE r.service = 'everyinfra' AND r.purpose = 'x_story_lookup' AND r.subject = 'story:' || st.id
  ) made
)`;

/** The candidate stories that have a phrase to search, hottest first. */
async function stories(now: Date): Promise<XLookupStory[]> {
  const hot = (await hotCandidates(now)).map((r) => Number(r.story_id));
  const recent = await sql<{ id: number }[]>`
    SELECT p.story_id::int AS id, max(p.score) AS score FROM publications p JOIN stories st ON st.id = p.story_id
    WHERE (p.selected OR p.score >= ${MIN_SCORE}) AND p.visibility = 'public' AND st.merged_into IS NULL
      AND coalesce(p.published_at, p.discovered_at) > ${now}::timestamptz - interval '3 days'
      AND ${lookupEligible}
    GROUP BY p.story_id ORDER BY score DESC NULLS LAST LIMIT ${CANDIDATES}`;
  const eligibleHot = hot.length ? await sql<{ id: number }[]>`
    SELECT st.id::int AS id FROM stories st WHERE st.id = ANY(${hot}::bigint[]) AND ${lookupEligible}
    ORDER BY array_position(${hot}::bigint[], st.id) LIMIT ${CANDIDATES}` : [];
  const ids = [...new Set([...recent.map((r) => r.id), ...eligibleHot.map((r) => r.id)])];
  if (!ids.length) return [];
  const rows = await sql<{ id: number; first_report_at: Date | null; created_at: Date }[]>`
    SELECT id::int AS id, first_report_at, created_at FROM stories WHERE id = ANY(${ids}::bigint[]) AND merged_into IS NULL`;
  const reports = await sql<{ story_id: number; id: string; url: string; title: string }[]>`
    SELECT DISTINCT f.story_id::int AS story_id, a.id, a.url, a.title, src.first_party
    FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN articles a ON a.id = fa.article_id
    JOIN sources src ON src.id = a.source_id JOIN publications p ON p.article_id = a.id
    WHERE f.story_id = ANY(${ids}::bigint[]) AND a.duplicate_of IS NULL AND src.participation_mode = 'editorial'
      AND p.visibility = 'public' AND p.eligible AND (NOT p.selected OR p.visible_after <= ${now})
    ORDER BY story_id, src.first_party DESC, a.id`;
  const out: XLookupStory[] = [];
  for (const id of ids) {
    const story = rows.find((r) => r.id === id);
    const query = story && lookupQuery(reports.filter((r) => r.story_id === id).map(({ id, url, title }) => ({ id, url, title, body: null })), now);
    if (story && query) out.push({ id, firstReportAt: story.first_report_at ?? story.created_at, query });
  }
  return out;
}

/** Lookups already made for a story: one per twelve-hour bucket that has a search receipt. */
async function lookupsMade(storyId: number, now: Date): Promise<{ count: number; thisBucket: boolean; bucket: string }> {
  const bucket = String(Math.floor(now.getTime() / (BUCKET_HOURS * 3600_000)));
  const [row] = await sql<{ buckets: string[] | null }[]>`
    SELECT array_agg(DISTINCT request->>'bucket') AS buckets FROM receipts
    WHERE service = 'everyinfra' AND purpose = 'x_story_lookup' AND subject = ${`story:${storyId}`}`;
  const buckets = (row?.buckets ?? []).filter(Boolean);
  return { count: buckets.length, thisBucket: buckets.includes(bucket), bucket };
}

async function keep(story: XLookupStory, post: Candidate, now: Date): Promise<boolean> {
  const [existing] = await sql<{ id: string; source_id: string }[]>`SELECT id, source_id FROM articles WHERE identity_key = ${post.identityKey!} AND duplicate_of IS NULL LIMIT 1`;
  // A post some source already collected is that source's evidence, counted through its own grouping.
  if (existing && existing.source_id !== X_LOOKUP_SOURCE) return false;
  let articleId = existing?.id;
  if (!articleId) {
    const made = await upsertMaterial({
      sourceId: X_LOOKUP_SOURCE, url: post.url, identityKey: post.identityKey!, title: post.title, author: post.author, publishedAt: post.publishedAt,
      excerpt: post.bodyText?.slice(0, 500) ?? null, xPost: post.xPost, bodyStatus: "none", via: "fetch",
      raw: { ...(post.raw as Record<string, unknown>), lookup: { storyId: story.id, query: story.query.keyword } },
    });
    articleId = made.articleId;
    await settleNonEditorial(articleId);
  }
  const observed = new Date(Math.min(Math.max(post.publishedAt!.getTime(), story.firstReportAt.getTime()), now.getTime()));
  await recordSignal(sql, story.id, articleId, { id: X_LOOKUP_SOURCE, signal_group_id: null }, "signal", observed);
  return true;
}

export interface XLookupResult {
  stories: number;
  looked: number;
  searches: number;
  matched: number;
  kept: number;
  /** Searches skipped: timed out, refused, unknown or in flight. */
  failed: number;
  skipped?: string;
}

export async function lookupStoryX(now = new Date()): Promise<XLookupResult> {
  const out: XLookupResult = { stories: 0, looked: 0, searches: 0, matched: 0, kept: 0, failed: 0 };
  if (process.env.X_STORY_LOOKUP_ENABLED === "false") return { ...out, skipped: "X_STORY_LOOKUP_ENABLED=false" };
  if (!credential("collectors", "EVERYINFRA_API_KEY")) return { ...out, skipped: "no EveryInfra key" };
  const list = await stories(now);
  out.stories = list.length;
  // Requests sent this run, answered or not: a run of refusals must not spend the day's share.
  let sent = 0;
  for (const story of list) {
    if (sent >= STORIES_PER_RUN) break;
    const made = await lookupsMade(story.id, now);
    if (made.thisBucket || made.count >= MAX_LOOKUPS) continue;
    let call;
    try {
      call = await everyInfraCall<unknown[]>({
        platform: "twitter", action: "search", params: { keyword: story.query.keyword },
        subject: `story:${story.id}`, purpose: "x_story_lookup", window: made.bucket, pool: "everyinfra:twitter", timeoutMs: TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof BudgetExceededError) break;
      // A timeout, a network error, a refusal or a request unknown or in flight: the receipt records it and
      // the request is not sent again (ops.recover releases an unknown one later). The next story goes on.
      out.failed += 1;
      if (!(error instanceof ReceiptUnknownError || error instanceof ReceiptBusyError)) sent += 1;
      continue;
    }
    sent += 1;
    // The bucket is stored on the receipt so the next run knows this story was looked up.
    await sql`UPDATE receipts SET request = request || ${sql.json({ bucket: made.bucket })} WHERE id = ${call.receiptId}`;
    const posts = matchingXPosts(Array.isArray(call.results) ? call.results : [], story.query, now);
    out.looked += 1;
    out.searches += 1;
    out.matched += posts.length;
    const existing = await sql<{ participant_key: string }[]>`
      SELECT DISTINCT participant_key FROM story_signals WHERE story_id = ${story.id} AND source_id = ${X_LOOKUP_SOURCE}`;
    const participants = new Set(existing.map((r) => r.participant_key));
    for (const post of posts) {
      if (participants.size >= MAX_PARTICIPANTS) break;
      const participant = (post.raw as { participant?: string } | undefined)?.participant;
      if (!participant || participants.has(participant)) continue;
      if (await keep(story, post, now)) {
        participants.add(participant);
        out.kept += 1;
      }
    }
    await completeReceipt(sql, call.receiptId);
  }
  return out;
}
