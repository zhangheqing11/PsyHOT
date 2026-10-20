// Fixed WeChat accounts read their cached WeRSS feed. Discovery is a separate, explicit paid action.
import { sql } from "../db.ts";
import { upsertMaterial } from "../content/materials.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { queueProcessing } from "../jobs/content.ts";
import { readWeRss } from "../providers/werss.ts";
import { noiseFiltered } from "./collect.ts";
import type { SourceRow } from "./types.ts";

export async function checkMpAccount(sourceId: string, reason: "schedule" | "manual") {
  const [source] = await sql<SourceRow[]>`SELECT * FROM sources WHERE id = ${sourceId} AND kind = 'mp_account'`;
  if (!source) return { sourceId, status: "missing" as const };
  if (!source.enabled) return { sourceId, status: "paused" as const };
  const [run] = await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id, detail)
    VALUES (${sourceId}, ${sql.json({ reason, collector: "werss" })}) RETURNING id`;
  let created = 0, revised = 0;
  try {
    const candidates = await readWeRss(source);
    const first = !source.cursor?.werssInitialized;
    for (const c of candidates.filter((c) => !noiseFiltered(c, source)).slice(0, 60)) {
      const result = await upsertMaterial({ ...c, sourceId, language: "zh", via: "fetch", backfill: first ? "werss-first-import" : null });
      created += Number(result.created);
      revised += Number(result.revised);
      if (result.created || result.revised) await queueProcessing(result.articleId);
    }
    const cursor: Record<string, unknown> = { ...source.cursor, werssInitialized: true, lastCheckedAt: new Date().toISOString() };
    delete cursor.retryAt;
    await sql`UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = NULL,
      health = 'ok', cursor = ${sql.json(cursor as never)}, next_fetch_at = now() + make_interval(mins => interval_minutes), updated_at = now()
      WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${candidates.length}, new_count = ${created} WHERE id = ${run!.id}`;
    return { sourceId, status: "ok" as const, found: candidates.length, created, revised };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 500);
    const retryAt = new Date(Date.now() + 60 * 60_000).toISOString();
    await sql`UPDATE sources SET last_fetch_at = now(), last_error = ${message}, fail_count = fail_count + 1,
      health = CASE WHEN fail_count + 1 >= 3 THEN 'failing' ELSE 'degraded' END,
      cursor = coalesce(cursor, '{}'::jsonb) || ${sql.json({ retryAt })}, updated_at = now() WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), new_count = ${created}, error = ${message} WHERE id = ${run!.id}`;
    return { sourceId, status: "failed" as const, error: message };
  }
}

/** Polling WeRSS's cached feed does not contact WeChat or a paid collection provider. */
export async function scheduleMpReconcile(now = new Date()) {
  const rows = await sql<{ id: string; last: string | null; retry: string | null; interval_minutes: number }[]>`
    SELECT id, cursor->>'lastCheckedAt' AS last, cursor->>'retryAt' AS retry, interval_minutes
    FROM sources WHERE kind = 'mp_account' AND enabled`;
  let enqueued = 0;
  for (const s of rows) {
    if (s.retry && Date.parse(s.retry) > now.getTime()) continue;
    const since = s.last ? now.getTime() - Date.parse(s.last) : Infinity;
    if (since <= s.interval_minutes * 60_000) continue;
    await enqueue(QUEUES.mpCheck, { sourceId: s.id, reason: "schedule" }, { singletonKey: `mp:${s.id}` });
    enqueued += 1;
  }
  return { enqueued };
}
