// Operator-run discovery only: which WeChat accounts also report our recent Chinese events. No source, signal,
// material or model writes and no scheduler registration; the candidate list is reviewed before any account is added.
import type { Db } from "../db.ts";
import { BudgetExceededError } from "../providers/receipts.ts";
import { lookupQuery, titleOverlap } from "./web-lookup.ts";

export const WECHAT_DISCOVERY_MAX_STORIES = 20;
export const WECHAT_DISCOVERY_MAX_KEYWORD = 20;

export interface WechatDiscoveryReport { id: string; title: string; url: string; sourceId: string; language: string | null }
export interface WechatDiscoveryStory {
  storyId: number;
  title: string;
  maxScore: number | null;
  /** Whether a public report comes from a source whose region is domestic. */
  domestic: boolean;
  reports: WechatDiscoveryReport[];
  /** Generated from the Chinese title; the reviewer may rewrite it before --run. */
  keyword: string;
}
export interface WechatDiscoveryCall { results: unknown; receiptId: number; reused: boolean; costUsd: number | null }
/** Every field the provider may omit is null; its documented fields were not all present in practice. */
export interface WechatDiscoveryHit {
  title: string | null;
  summary: string | null;
  accountName: string | null;
  postedAt: string | number | null;
  relativeTime: string | null;
  kind: string | null;
  /** A signed, expiring link: not an identity. */
  url: string | null;
  /** The id of the mp_account source (enabled or not) with exactly this name or nickname. */
  known: string | null;
  ruleMatch: boolean;
  review: boolean | null;
}
export interface WechatDiscoveryResult {
  storyId: number;
  title: string;
  keyword: string;
  receiptId: number;
  reused: boolean;
  receiptCostUsd: number | null;
  newCostUsd: number | null;
  received: number;
  hits: WechatDiscoveryHit[];
}
export interface WechatAccountSummary {
  accountName: string;
  stories: number;
  hits: number;
  known: string | null;
  samples: Array<{ title: string | null; postedAt: string | number | null; storyId: number }>;
}

const hasHan = (s: string) => /\p{Script=Han}/u.test(s);

/** Frozen inputs, one keyword per event. Never translate or invent a missing Chinese title. */
export function wechatStoryKeyword(story: { title: string; reports: Array<{ title: string; language: string | null }> }): string {
  const title = hasHan(story.title) ? story.title : story.reports.find((r) => r.language === "zh" || hasHan(r.title))?.title ?? "";
  return [...lookupQuery(title).trim()].slice(0, 16).join("");
}

/** Only used while building a plan, inside a read-only snapshot. No ranking or signal writes. */
export async function selectWechatDiscoveryStories(db: Db, at: Date, limit = WECHAT_DISCOVERY_MAX_STORIES): Promise<WechatDiscoveryStory[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WECHAT_DISCOVERY_MAX_STORIES) throw new Error(`Limit must be 1-${WECHAT_DISCOVERY_MAX_STORIES}`);
  const rows = await db<Omit<WechatDiscoveryStory, "keyword">[]>`
    WITH reports AS (
      SELECT DISTINCT st.id AS story_id, st.title AS story_title, a.id, a.title, a.url, a.language, a.source_id, p.score, p.selected,
        (src.participation_mode = 'editorial' AND p.visibility = 'public' AND p.eligible AND (NOT p.selected OR p.visible_after <= ${at})) AS is_public,
        src.region
      FROM stories st JOIN facts f ON f.story_id = st.id JOIN fact_articles fa ON fa.fact_id = f.id
      JOIN articles a ON a.id = fa.article_id JOIN sources src ON src.id = a.source_id
      LEFT JOIN publications p ON p.article_id = a.id
      WHERE st.merged_into IS NULL AND st.latest_at > ${new Date(at.getTime() - 7 * 86400_000)} AND st.latest_at <= ${at}
        AND a.duplicate_of IS NULL
    ), picked AS (
      SELECT story_id, story_title, max(score) FILTER (WHERE is_public) AS max_score,
        coalesce(bool_or(is_public AND region = 'domestic'), false) AS domestic
      FROM reports GROUP BY story_id, story_title
      HAVING bool_or(is_public AND (score >= 50 OR selected)) AND bool_or(language = 'zh' OR title ~ '[㐀-䶿一-鿿豈-﫿𠀀-𲎯]')
      ORDER BY domestic DESC, max_score DESC NULLS LAST, story_id LIMIT ${limit}
    )
    SELECT picked.story_id AS "storyId", picked.story_title AS title, picked.max_score AS "maxScore", picked.domestic,
      (SELECT jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'url', r.url, 'sourceId', r.source_id, 'language', r.language) ORDER BY r.id)
       FROM reports r WHERE r.story_id = picked.story_id) AS reports
    FROM picked ORDER BY picked.domestic DESC, picked.max_score DESC NULLS LAST, picked.story_id`;
  return rows.map((row) => ({ ...row, keyword: wechatStoryKeyword(row) }));
}

/** Name or nickname of every mp_account source, enabled or not, to its source id (an enabled source wins a shared name). */
export async function knownWechatAccounts(db: Db): Promise<Map<string, string>> {
  const rows = await db<{ id: string; name: string; nickname: string | null }[]>`
    SELECT id, name, config->>'nickname' AS nickname FROM sources WHERE kind = 'mp_account' ORDER BY enabled DESC, id`;
  const known = new Map<string, string>();
  for (const row of rows) for (const name of [row.name, row.nickname]) if (name && !known.has(name)) known.set(name, row.id);
  return known;
}

/** Reference only: the result title resembles one of our reports, or it contains every Chinese fragment of the keyword. */
export function wechatRuleMatch(keyword: string, reports: Array<{ title: string }>, title: string | null, summary: string | null): boolean {
  if (title && reports.some((r) => titleOverlap(title, r.title) >= 0.3)) return true;
  const text = `${title ?? ""}\n${summary ?? ""}`.normalize("NFKC");
  const fragments = keyword.normalize("NFKC").match(/\p{Script=Han}+/gu) ?? [];
  return fragments.length > 0 && fragments.every((fragment) => text.includes(fragment));
}

const textOf = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

function hitOf(row: unknown, story: WechatDiscoveryStory, known: ReadonlyMap<string, string>): WechatDiscoveryHit | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const title = textOf(r.title), summary = textOf(r.summary), accountName = textOf(r.account_name);
  return { title, summary: summary && [...summary].slice(0, 200).join(""), accountName,
    postedAt: textOf(r.posted_at) ?? (typeof r.posted_at === "number" && Number.isFinite(r.posted_at) ? r.posted_at : null),
    relativeTime: textOf(r.relative_time), kind: textOf(r.kind), url: textOf(r.url),
    known: accountName ? known.get(accountName) ?? null : null,
    ruleMatch: wechatRuleMatch(story.keyword, story.reports, title, summary), review: null };
}

export async function runWechatDiscovery(stories: WechatDiscoveryStory[], known: ReadonlyMap<string, string>,
  request: (story: WechatDiscoveryStory) => Promise<WechatDiscoveryCall>,
  record: (result: WechatDiscoveryResult) => Promise<void>): Promise<{ completed: number; stopped: "budget" | null }> {
  if (stories.length > WECHAT_DISCOVERY_MAX_STORIES || new Set(stories.map((s) => s.storyId)).size !== stories.length ||
      stories.some((s) => !Number.isSafeInteger(s.storyId) || s.storyId < 1)) throw new Error(`Discovery needs at most ${WECHAT_DISCOVERY_MAX_STORIES} unique positive story ids`);
  if (stories.some((s) => typeof s.keyword !== "string" || !s.keyword.trim() || [...s.keyword].length > WECHAT_DISCOVERY_MAX_KEYWORD)) throw new Error("Invalid WeChat discovery keyword");
  let completed = 0;
  for (const story of stories) {
    let call: WechatDiscoveryCall;
    try { call = await request(story); }
    catch (error) {
      if (error instanceof BudgetExceededError) return { completed, stopped: "budget" };
      throw error; // Unknown outcomes and other errors stop immediately, without retrying.
    }
    if (!Array.isArray(call.results)) throw new Error(`Receipt ${call.receiptId}: WeChat results is not an array`);
    const hits: WechatDiscoveryHit[] = [];
    for (const row of call.results) {
      const hit = hitOf(row, story, known);
      if (hit) hits.push(hit);
      if (hits.length === 20) break;
    }
    await record({ storyId: story.storyId, title: story.title, keyword: story.keyword, receiptId: call.receiptId, reused: call.reused,
      receiptCostUsd: call.costUsd, newCostUsd: call.reused ? 0 : call.costUsd, received: call.results.length, hits });
    completed++;
  }
  return { completed, stopped: null };
}

const HIT_FIELDS = ["title", "summary", "accountName", "postedAt", "relativeTime", "kind", "url"] as const;

/** Share of results carrying each field (null while there are no results); the documented fields were not all present in practice. */
export function wechatFieldRates(results: Array<Pick<WechatDiscoveryResult, "hits">>): { hits: number; rates: Record<(typeof HIT_FIELDS)[number], number | null> } {
  const hits = results.flatMap((r) => r.hits);
  const rates = Object.fromEntries(HIT_FIELDS.map((field) => [field,
    hits.length ? Math.round(hits.filter((h) => h[field] !== null).length / hits.length * 1000) / 1000 : null])) as Record<(typeof HIT_FIELDS)[number], number | null>;
  return { hits: hits.length, rates };
}

/** A manual review wins over the rule: false removes a result, true counts it even when the rule missed. */
export const countsAsCoverage = (hit: Pick<WechatDiscoveryHit, "ruleMatch" | "review">) => hit.review ?? hit.ruleMatch;

/** Accounts by the number of our events they reported; results without an account name cannot be attributed. */
export function summarizeAccounts(results: Array<Pick<WechatDiscoveryResult, "storyId" | "hits">>): WechatAccountSummary[] {
  const accounts = new Map<string, WechatAccountSummary & { storyIds: Set<number> }>();
  for (const result of results) for (const hit of result.hits) {
    if (!hit.accountName || !countsAsCoverage(hit)) continue;
    const account = accounts.get(hit.accountName) ?? { accountName: hit.accountName, stories: 0, hits: 0, known: null, samples: [], storyIds: new Set() };
    accounts.set(hit.accountName, account);
    account.storyIds.add(result.storyId);
    account.hits++;
    account.known ??= hit.known;
    if (account.samples.length < 3) account.samples.push({ title: hit.title, postedAt: hit.postedAt, storyId: result.storyId });
  }
  return [...accounts.values()].map(({ storyIds, ...account }) => ({ ...account, stories: storyIds.size }))
    .sort((a, b) => b.stories - a.stories || b.hits - a.hits || (a.accountName < b.accountName ? -1 : a.accountName > b.accountName ? 1 : 0));
}

const cell = (s: string) => s.replace(/\s+/gu, " ").replace(/\|/gu, "\\|");

/** The table the site owner reads: account, events covered, already a source, sample titles. */
export function accountsMarkdown(accounts: WechatAccountSummary[]): string {
  const rows = accounts.map((a) => `| ${cell(a.accountName)} | ${a.stories} | ${a.known ? `是（${cell(a.known)}）` : "否"} | ${
    a.samples.map((s) => cell(s.title ?? "（无标题）")).join("<br>")} |`);
  return ["| 公众号名 | 覆盖事件数 | 是否已是信源 | 样例标题 |", "| --- | --- | --- | --- |", ...rows].join("\n") + "\n";
}
