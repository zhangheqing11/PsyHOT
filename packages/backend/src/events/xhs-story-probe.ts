// Operator-run experiment only: no material writes, grouping, models or scheduler registration.
import type { Db } from "../db.ts";
import { xhsNoteIdFromUrl } from "../lib/url.ts";
import { BudgetExceededError } from "../providers/receipts.ts";
import { engagementOf } from "../sources/json-list.ts";
import { lookupQuery, titleOverlap } from "./web-lookup.ts";

export interface XhsProbeReport { id: string; title: string; url: string; language: string | null }
export interface XhsProbeStory {
  storyId: number;
  title: string;
  maxScore: number | null;
  /** Count of existing story_signals rows whose source_id starts with xhs-, not distinct authors. */
  xhsParticipants: number;
  reports: XhsProbeReport[];
  keyword: string;
}
export interface XhsProbeCall { results: unknown; receiptId: number; reused: boolean; costUsd: number | null }
export interface XhsProbeSample {
  id: string;
  url: string;
  title: string;
  text: string;
  authorName: string | null;
  authorId: string | null;
  postedAt: string | number | null;
  likes: number | null;
  collects: number | null;
  comments: number | null;
  isGoodsNote: boolean | null;
  ruleMatch: boolean;
  review: null;
}
export interface XhsProbeResult {
  storyId: number;
  title: string;
  keyword: string;
  receiptId: number;
  reused: boolean;
  receiptCostUsd: number | null;
  newCostUsd: number | null;
  received: number;
  samples: XhsProbeSample[];
}

const hasHan = (s: string) => /\p{Script=Han}/u.test(s);

/** Frozen inputs, one keyword per event. Never translate or invent a missing Chinese title. */
export function xhsStoryKeyword(story: { title: string; reports: XhsProbeReport[] }): string {
  const title = hasHan(story.title) ? story.title : story.reports.find((r) => r.language === "zh" || hasHan(r.title))?.title ?? "";
  return [...lookupQuery(title).trim()].slice(0, 20).join("");
}

/** Only used while building a plan, inside a read-only snapshot. No ranking or signal writes. */
export async function selectXhsProbeStories(db: Db, at: Date): Promise<XhsProbeStory[]> {
  const rows = await db<Omit<XhsProbeStory, "keyword">[]>`
    WITH reports AS (
      SELECT DISTINCT st.id AS story_id, st.title AS story_title, a.id, a.title, a.url, a.language, p.score, p.selected,
        (src.participation_mode = 'editorial' AND p.visibility = 'public' AND p.eligible AND (NOT p.selected OR p.visible_after <= ${at})) AS is_public
      FROM stories st JOIN facts f ON f.story_id = st.id JOIN fact_articles fa ON fa.fact_id = f.id
      JOIN articles a ON a.id = fa.article_id JOIN sources src ON src.id = a.source_id
      LEFT JOIN publications p ON p.article_id = a.id
      WHERE st.merged_into IS NULL AND st.latest_at > ${new Date(at.getTime() - 7 * 86400_000)} AND st.latest_at <= ${at}
        AND a.duplicate_of IS NULL
    ), picked AS (
      SELECT story_id, story_title, max(score) FILTER (WHERE is_public) AS max_score FROM reports GROUP BY story_id, story_title
      HAVING bool_or(is_public AND (score >= 50 OR selected)) AND bool_or(language = 'zh' OR title ~ '[㐀-䶿一-鿿豈-﫿𠀀-𲎯]')
      ORDER BY max_score DESC NULLS LAST, story_id LIMIT 15
    )
    SELECT picked.story_id AS "storyId", picked.story_title AS title, picked.max_score AS "maxScore",
      (SELECT count(*)::int FROM story_signals ss WHERE ss.story_id = picked.story_id AND ss.source_id LIKE 'xhs-%') AS "xhsParticipants",
      (SELECT jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'url', r.url, 'language', r.language) ORDER BY r.id)
       FROM reports r WHERE r.story_id = picked.story_id) AS reports
    FROM picked ORDER BY picked.max_score DESC NULLS LAST, picked.story_id`;
  return rows.map((row) => ({ ...row, keyword: xhsStoryKeyword(row) }));
}

// Remove whole generic terms before splitting, so 心理学 does not leave a spurious 理学 fragment.
const GENERIC = /心理健康|精神健康|心理学|心理|健康|科学|最新|新研究|研究|发现|新闻|论文|结果|表明|表示|相关|关于|我们|可以|一个|一种|这个|什么|如何|为什么|影响/gu;

/** Reference only: two distinct, non-overlapping Han fragments, or report-title bigram Dice >= 0.3. */
export function xhsRuleMatch(keyword: string, reports: Array<{ title: string }>, title: string, body: string): boolean {
  if (reports.some((r) => titleOverlap(title, r.title) >= 0.3)) return true;
  const text = `${title}\n${body}`.normalize("NFKC");
  const query = keyword.normalize("NFKC").replace(GENERIC, " ");
  const fragments: Array<{ value: string; start: number }> = [];
  for (const run of query.matchAll(/\p{Script=Han}{2,}/gu)) {
    const chars = [...run[0]];
    let start = run.index;
    for (let i = 0; i + 1 < chars.length; i++) {
      fragments.push({ value: chars[i] + chars[i + 1], start });
      start += chars[i].length;
    }
  }
  for (let i = 0; i < fragments.length; i++) for (let j = i + 1; j < fragments.length; j++) {
    const a = fragments[i], b = fragments[j];
    if (a.value === b.value || a.start + a.value.length > b.start) continue;
    const firstA = text.indexOf(a.value), firstB = text.indexOf(b.value);
    if (firstA >= 0 && firstB >= 0 && (firstA + a.value.length <= text.lastIndexOf(b.value) || firstB + b.value.length <= text.lastIndexOf(a.value))) return true;
  }
  return false;
}

function sampleOf(row: unknown, story: XhsProbeStory): XhsProbeSample | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = typeof r.url === "string" ? xhsNoteIdFromUrl(r.url) : null;
  if (!id || (typeof r.id === "string" && r.id.toLowerCase() !== id)) return null;
  const title = typeof r.title === "string" ? r.title : "";
  const text = typeof r.text === "string" ? r.text : "";
  const engagement = engagementOf(row);
  return { id, url: `https://www.xiaohongshu.com/explore/${id}`, title, text: [...text].slice(0, 200).join(""),
    authorName: typeof r.author_name === "string" ? r.author_name : null,
    authorId: typeof r.author_id === "string" ? r.author_id : null,
    postedAt: typeof r.posted_at === "string" || (typeof r.posted_at === "number" && Number.isFinite(r.posted_at)) ? r.posted_at : null,
    likes: engagement.like_count ?? null, collects: engagement.collect_count ?? null, comments: engagement.comment_count ?? null,
    isGoodsNote: typeof r.is_goods_note === "boolean" ? r.is_goods_note : null,
    ruleMatch: xhsRuleMatch(story.keyword, story.reports, title, text), review: null };
}

export async function runXhsProbe(stories: XhsProbeStory[],
  request: (story: XhsProbeStory) => Promise<XhsProbeCall>,
  record: (result: XhsProbeResult) => Promise<void>): Promise<{ completed: number; stopped: "budget" | null }> {
  if (stories.length > 15 || new Set(stories.map((s) => s.storyId)).size !== stories.length ||
      stories.some((s) => !Number.isSafeInteger(s.storyId) || s.storyId < 1)) throw new Error("Probe needs at most 15 unique positive story ids");
  if (stories.some((s) => typeof s.keyword !== "string" || !s.keyword.trim() || [...s.keyword].length > 20)) throw new Error("Invalid XHS probe keyword");
  let completed = 0;
  for (const story of stories) {
    let call: XhsProbeCall;
    try { call = await request(story); }
    catch (error) {
      if (error instanceof BudgetExceededError) return { completed, stopped: "budget" };
      throw error; // Unknown outcomes and other errors stop immediately, without retrying.
    }
    if (!Array.isArray(call.results)) throw new Error(`Receipt ${call.receiptId}: XHS results is not an array`);
    const samples: XhsProbeSample[] = [];
    for (const row of call.results) {
      const sample = sampleOf(row, story);
      if (sample) samples.push(sample);
      if (samples.length === 20) break;
    }
    await record({ storyId: story.storyId, title: story.title, keyword: story.keyword, receiptId: call.receiptId, reused: call.reused,
      receiptCostUsd: call.costUsd, newCostUsd: call.reused ? 0 : call.costUsd, received: call.results.length, samples });
    completed++;
  }
  return { completed, stopped: null };
}
