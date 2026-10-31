// Fixed WeChat official accounts through EveryInfra (paid per call): one listing per account per its
// interval, then one body call for each new article that passes the account's filter. The listing
// carries no digest, so a body is what makes an article worth analysing.
import { sql } from "../db.ts";
import { upsertMaterial } from "../content/materials.ts";
import { enqueue, ensureQueue, QUEUES } from "../jobs/queue.ts";
import { queueProcessing } from "../jobs/content.ts";
import { stripTags } from "../lib/text.ts";
import { sanitizeBody } from "../content/sanitize.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { sha256 } from "../lib/ids.ts";
import { everyInfraMpArticle, everyInfraMpHistory, type EveryInfraMpPost } from "../providers/everyinfra.ts";
import { BudgetExceededError, ProviderRejectedError } from "../providers/receipts.ts";
import { noiseFilterReason } from "./collect.ts";
import type { Candidate, SourceRow } from "./types.ts";

const MAX_NEW_PER_CHECK = 8;
/** Later checks take what appeared since the previous one, with this margin for late listings. */
const SINCE_MARGIN_MS = 2 * 86400_000;
/** However long an account was not checked, nothing older than this is bought. */
const MAX_WINDOW_MS = 10 * 86400_000;
/** A body missing for a passing reason is fetched again on later checks: this often, while the post is this recent. */
const BODY_RETRIES = 3;
const BODY_RETRY_WINDOW_MS = 3 * 86400_000;
/** Account-level unavailable retries start at an hour and double to at most twelve hours. */
const UNAVAILABLE_RETRY_MS = 60 * 60_000;
/** Spread accounts released together by the rolling budget window over successive 15-minute reconciles. */
const MAX_ENQUEUE_PER_RECONCILE = 3;
/** A listing of another account than the configured one: the operator has to fix the account id. */
const MISMATCH_RETRY_MS = 7 * 86400_000;

interface MpSource {
  id: string;
  name: string;
  config: { wxid?: string; ghid?: string; nickname?: string; wechatBiz?: string; ingestNoiseFilter?: Record<string, string[]> };
  cursor: Record<string, unknown> | null;
  enabled: boolean;
  participation_mode: string;
  interval_minutes: number;
}

interface PendingPost {
  url: string;
  title: string;
  postedAt: string | null;
}

export function mpDue(cursor: Record<string, unknown> | null, intervalMinutes: number, now = Date.now()): boolean {
  if (typeof cursor?.retryAt === "string" && Date.parse(cursor.retryAt) > now) return false;
  if (Array.isArray(cursor?.pending) && cursor.pending.length) return true;
  return !(typeof cursor?.lastCheckedAt === "string" && now - Date.parse(cursor.lastCheckedAt) <= intervalMinutes * 60_000);
}

function mpRetryOffset(sourceId: string): number {
  return parseInt(sha256(sourceId).slice(0, 8), 16) % (15 * 60_000 + 1);
}

/** The account a WeChat article link belongs to (its __biz), when the link is a real article address. */
export function articleBiz(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname !== "mp.weixin.qq.com" || u.pathname !== "/s" || u.username || u.password) return null;
  return u.searchParams.get("mid") && u.searchParams.get("idx") ? u.searchParams.get("__biz") : null;
}

/**
 * The posts of this check: the configured account's own, newer than the previous check, newest first.
 * The first check only verifies the account and sets the mark: what it lists is history, which
 * would be archived (not news) and is not worth a body each.
 */
export function postsToTake(posts: EveryInfraMpPost[], biz: string | null, cursor: Record<string, unknown> | null, now = Date.now()) {
  const last = typeof cursor?.lastCheckedAt === "string" ? Date.parse(cursor.lastCheckedAt) : NaN;
  const own = biz ? posts.filter((p) => articleBiz(p.url) === biz) : posts.filter((p) => articleBiz(p.url));
  // Every listed article belongs to another account: the account id points at the wrong account.
  const mismatch = posts.length > 0 && own.length === 0;
  if (!Number.isFinite(last)) return { mismatch, take: [] };
  const since = Math.max(last - SINCE_MARGIN_MS, now - MAX_WINDOW_MS);
  return {
    mismatch,
    take: own.filter((p) => p.postedAt && p.postedAt.getTime() >= since && p.postedAt.getTime() <= now + 3600_000)
      .sort((a, b) => b.postedAt!.getTime() - a.postedAt!.getTime()),
  };
}

/** The article body, and when it is missing for a reason that may pass (rate limit, server error, lost answer), that reason. */
async function fetchBody(url: string, sourceId: string, identity: string) {
  try {
    return { body: await everyInfraMpArticle(url, { subject: sourceId, identity }), passing: null };
  } catch (error) {
    if (error instanceof BudgetExceededError) throw error;
    const final = error instanceof ProviderRejectedError && !error.retryable;
    return { body: null, passing: final ? null : String(error instanceof Error ? error.message : error).slice(0, 200) };
  }
}

export async function checkMpAccount(sourceId: string, reason: "schedule" | "manual") {
  const [source] = await sql<MpSource[]>`SELECT id, name, config, cursor, enabled, participation_mode, interval_minutes FROM sources WHERE id = ${sourceId} AND kind = 'mp_account'`;
  if (!source) return { sourceId, status: "missing" as const };
  if (!source.enabled && reason !== "manual") return { sourceId, status: "paused" as const };
  const cursor: Record<string, unknown> = { ...(source.cursor ?? {}) };
  if (Array.isArray(cursor.pending) && cursor.pending.length && typeof cursor.pendingSince === "string"
    && Date.now() - Date.parse(cursor.pendingSince) > BODY_RETRY_WINDOW_MS) {
    delete cursor.pending;
    delete cursor.pendingSince;
    await sql`UPDATE sources SET cursor = ${sql.json(cursor as never)} WHERE id = ${sourceId}`;
  }
  if (reason === "schedule" && !mpDue(cursor, source.interval_minutes)) return { sourceId, status: "not-due" as const };
  const account = source.config.ghid ?? source.config.wxid;
  if (!account) {
    await sql`UPDATE sources SET health = 'failing', last_error = '没有配置公众号 ghid，无法抓取', updated_at = now() WHERE id = ${sourceId}`;
    return { sourceId, status: "unconfigured" as const };
  }
  const [run] = await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id, detail) VALUES (${sourceId}, ${sql.json({ reason, collector: "everyinfra" })}) RETURNING id`;
  let created = 0;
  let found = 0;
  let reused = false;
  const exclusions: Record<string, number> = {};
  try {
    let take: EveryInfraMpPost[];
    if (Array.isArray(cursor.pending) && cursor.pending.length) {
      take = (cursor.pending as PendingPost[]).map((p) => ({ ...p, postedAt: p.postedAt ? new Date(p.postedAt) : null, ghid: source.config.ghid ?? null }));
      found = take.length;
    } else {
      // One paid list call per account per 10-minute window, whoever asks.
      const window = `${reason === "schedule" ? "s" : "m"}:${Math.floor(Date.now() / 600_000)}`;
      const history = await everyInfraMpHistory(account, { subject: sourceId, window });
      const listedAt = new Date().toISOString();
      const posts = postsToTake(history.posts, source.config.wechatBiz ?? null, cursor);
      if (posts.mismatch) {
        const message = `公众号身份不符：列表里的文章不属于配置的账号（__biz ${source.config.wechatBiz}），请核对 ghid`;
        await sql`UPDATE sources SET last_fetch_at = now(), last_error = ${message}, fail_count = fail_count + 1, health = 'failing',
          cursor = coalesce(cursor, '{}'::jsonb) || ${sql.json({ retryAt: new Date(Date.now() + MISMATCH_RETRY_MS).toISOString() })}, updated_at = now()
          WHERE id = ${sourceId}`;
        await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), found_count = ${history.posts.length}, error = ${message} WHERE id = ${run!.id}`;
        return { sourceId, status: "failed" as const, error: message };
      }
      take = posts.take;
      found = history.posts.length;
      reused = history.reused;
      cursor.lastCheckedAt = listedAt;
      delete cursor.retryAt;
      delete cursor.unavailableCount;
    }
    // Fresh listings and saved posts share all filtering, body retry and ingestion rules below.
    let fetched = 0;
    let budgetPause: BudgetExceededError | null = null;
    const pending: EveryInfraMpPost[] = [];
    for (const p of take) {
      if (fetched >= MAX_NEW_PER_CHECK) break;
      // A broad account (a government health account) keeps only what is on topic; the paid body is not fetched for the rest.
      const noiseReason = noiseFilterReason({ title: p.title, excerpt: null, url: p.url } as Candidate, source as unknown as SourceRow);
      if (noiseReason) {
        exclusions[noiseReason] = (exclusions[noiseReason] ?? 0) + 1;
        continue;
      }
      // Same identity rule as every entrance: the long link without tracking parameters. A known post is
      // skipped, unless its body failed for a passing reason: then it is tried again a few times.
      const key = identityKeyForUrl(p.url);
      const [known] = key
        ? await sql<{ id: string; body_status: string; discovered_at: Date; retry: { attempts: number } | null }[]>`
            SELECT id, body_status, discovered_at, raw->'everyinfra'->'bodyRetry' AS retry FROM articles WHERE identity_key = ${key} LIMIT 1`
        : [];
      const retryBody = !!known?.retry && known.body_status === "none" && known.retry.attempts < BODY_RETRIES && Date.now() - known.discovered_at.getTime() < BODY_RETRY_WINDOW_MS;
      if (known && !retryBody) continue;
      fetched += 1;
      if (budgetPause) {
        pending.push(p);
        continue;
      }
      // Without a body the post is listed anyway; analysis works from its title.
      let result: Awaited<ReturnType<typeof fetchBody>>;
      try {
        result = await fetchBody(p.url, sourceId, key ?? p.url);
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) throw error;
        budgetPause = error;
        pending.push(p);
        continue;
      }
      const { body, passing } = result;
      const content = body?.html ?? body?.text ?? null;
      if (known && !content) {
        const retry = passing ? sql`jsonb_set(raw, '{everyinfra,bodyRetry}', ${sql.json({ attempts: known.retry!.attempts + 1, error: passing })})` : sql`raw #- '{everyinfra,bodyRetry}'`;
        await sql`UPDATE articles SET raw = ${retry} WHERE id = ${known.id}`;
        continue;
      }
      const html = body?.html ? sanitizeBody(body.html, p.url) : null;
      const text = body?.html
        ? stripTags(body.html.replace(/<\/p>|<br\s*\/?>/gi, "\n")).replace(/\n{3,}/g, "\n\n").trim()
        : body?.text?.trim() ?? null;
      const res = await upsertMaterial({
        sourceId,
        url: p.url,
        title: p.title,
        author: body?.author ?? source.name,
        language: "zh",
        publishedAt: p.postedAt,
        excerpt: body?.digest ?? null,
        bodyHtml: html,
        bodyText: text || null,
        bodyStatus: text ? "ok" : "none",
        via: "fetch",
        raw: { everyinfra: { ghid: p.ghid, ...(passing ? { bodyRetry: { attempts: 1, error: passing } } : {}) } },
      });
      // A body fetched again arrives as a new revision (analysed again); stop retrying it.
      if (known) await sql`UPDATE articles SET raw = raw #- '{everyinfra,bodyRetry}' WHERE id = ${known.id}`;
      if (res.created || res.revised) {
        created += res.created ? 1 : 0;
        await queueProcessing(res.articleId);
      }
    }
    if (budgetPause) {
      cursor.pending = pending.map((p) => ({ url: p.url, title: p.title, postedAt: p.postedAt?.toISOString() ?? null }));
      cursor.pendingSince ??= cursor.lastCheckedAt;
      throw budgetPause;
    }
    delete cursor.pending;
    delete cursor.pendingSince;
    delete cursor.retryAt;
    await sql`
      UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = NULL, health = 'ok', cursor = ${sql.json(cursor as never)},
        next_fetch_at = now() + make_interval(mins => interval_minutes), updated_at = now()
      WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${found}, new_count = ${created},
      detail = ${sql.json({ reason, ...(Object.keys(exclusions).length ? { exclusions } : {}) } as never)} WHERE id = ${run!.id}`;
    return { sourceId, status: "ok" as const, found, created, reused };
  } catch (error) {
    const message = (error instanceof BudgetExceededError && Array.isArray(cursor.pending) && cursor.pending.length
      ? `正文因额度暂停，${cursor.pending.length} 篇待续：${error.message}`
      : String(error instanceof Error ? error.message : error)).slice(0, 500);
    const soft = error instanceof BudgetExceededError || (error instanceof ProviderRejectedError && error.retryable);
    await sql`
      UPDATE sources SET last_fetch_at = now(), last_error = ${message},
        fail_count = CASE WHEN ${soft} THEN fail_count ELSE fail_count + 1 END,
        health = CASE WHEN ${soft} THEN health WHEN fail_count + 1 >= 3 THEN 'failing' ELSE 'degraded' END, updated_at = now()
      WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), found_count = ${found}, new_count = ${created}, error = ${message} WHERE id = ${run!.id}`;
    if (error instanceof BudgetExceededError) {
      const retryAt = new Date(Date.now() + error.retryAfterSeconds * 1000 + mpRetryOffset(sourceId)).toISOString();
      cursor.retryAt = retryAt;
      await sql`UPDATE sources SET cursor = ${sql.json(cursor as never)} WHERE id = ${sourceId}`;
      // Reconcile owns scheduled budget waits, so the queue does not accumulate old retries.
      if (reason === "schedule") return { sourceId, status: "deferred" as const, retryAt };
      throw error;
    }
    // Some accounts stay unavailable for hours; back off each account and stagger its next attempt.
    if (error instanceof ProviderRejectedError && error.retryable) {
      const unavailableCount = (typeof cursor.unavailableCount === "number" ? cursor.unavailableCount : 0) + 1;
      const wait = Math.min(UNAVAILABLE_RETRY_MS * 2 ** (unavailableCount - 1), 12 * UNAVAILABLE_RETRY_MS);
      await sql`UPDATE sources SET cursor = coalesce(cursor, '{}'::jsonb) || ${sql.json({ unavailableCount,
        retryAt: new Date(Date.now() + wait + mpRetryOffset(sourceId)).toISOString() })} WHERE id = ${sourceId}`;
      return { sourceId, status: "failed" as const, error: message };
    }
    return { sourceId, status: "failed" as const, error: message };
  }
}

/** Every enabled account is checked once per its interval (the paid list call is the cost). */
export async function scheduleMpReconcile(now = new Date()) {
  const rows = await sql<{ id: string; cursor: Record<string, unknown> | null; interval_minutes: number }[]>`
    SELECT id, cursor, interval_minutes FROM sources WHERE kind = 'mp_account' AND enabled`;
  await ensureQueue(QUEUES.mpCheck);
  const pending = await sql<{ singleton_key: string | null }[]>`
    SELECT singleton_key FROM pgboss.job WHERE name = ${QUEUES.mpCheck} AND state IN ('created', 'retry', 'active')`;
  const pendingKeys = new Set(pending.map((j) => j.singleton_key));
  const dueAt = (s: typeof rows[number]) => {
    const last = typeof s.cursor?.lastCheckedAt === "string" ? Date.parse(s.cursor.lastCheckedAt) : NaN;
    if (!Number.isFinite(last)) return -Infinity;
    const retry = typeof s.cursor?.retryAt === "string" ? Date.parse(s.cursor.retryAt) : NaN;
    const retryAt = Number.isFinite(retry) ? retry : -Infinity;
    if (Array.isArray(s.cursor?.pending) && s.cursor.pending.length) return retryAt;
    return Math.max(last + s.interval_minutes * 60_000, retryAt);
  };
  const due = rows.filter((s) => mpDue(s.cursor, s.interval_minutes, now.getTime()) && !pendingKeys.has(`mp:${s.id}`))
    .sort((a, b) => dueAt(a) - dueAt(b));
  let enqueued = 0;
  for (const s of due.slice(0, MAX_ENQUEUE_PER_RECONCILE)) {
    await enqueue(QUEUES.mpCheck, { sourceId: s.id, reason: "schedule" }, { singletonKey: `mp:${s.id}`, expireInSeconds: 900 });
    enqueued += 1;
  }
  return { enqueued };
}
