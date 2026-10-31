// Scheduled checks revalidate the cursor before any paid call and leave budget waiting to reconcile.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { fetchNow } from "@aihot/backend/admin/sources";
import { deferBudgetJob, enqueue, getBoss, QUEUES, runBudgetAware, stopBoss } from "@aihot/backend/jobs/queue";
import { BudgetExceededError, paidRequest } from "@aihot/backend/providers/receipts";
import { everyInfraCall, everyInfraMpArticle, everyInfraMpHistory, everyInfraXhsNote } from "@aihot/backend/providers/everyinfra";
import { checkMpAccount, mpDue, scheduleMpReconcile } from "@aihot/backend/sources/mp";

const provider = await stub(() => ({ results: [] }));
process.env.EVERYINFRA_BASE_URL = provider.url;
process.env.EVERYINFRA_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

const sourceIds: string[] = [];
const jobIds: string[] = [];
const services: string[] = [];
let saved: Array<{ service: string; per_minute: number; per_hour: number; per_day: number }> = [];
before(async () => {
  saved = await sql`SELECT service, per_minute, per_hour, per_day FROM budgets WHERE service LIKE 'everyinfra%'`;
  await sql`UPDATE budgets SET per_minute = 100000, per_hour = 100000, per_day = 100000 WHERE service LIKE 'everyinfra%'`;
});
after(async () => {
  for (const b of saved) await sql`UPDATE budgets SET per_minute = ${b.per_minute}, per_hour = ${b.per_hour}, per_day = ${b.per_day} WHERE service = ${b.service}`;
  await sql`DELETE FROM pgboss.job WHERE data->>'sourceId' IN ${sql(sourceIds)} OR id IN ${sql(jobIds)}`;
  await sql`DELETE FROM receipts WHERE subject IN ${sql(sourceIds)} OR service IN ${sql(services)}`;
  await sql`DELETE FROM sources WHERE id IN ${sql(sourceIds)}`;
  await sql`DELETE FROM budgets WHERE service IN ${sql(services)}`;
  await provider.close();
  await stopBoss();
  await closeDb();
});

async function source(cursor: Record<string, unknown> | null = null) {
  const id = `mp-schedule-${tag()}`;
  sourceIds.push(id);
  await sql`INSERT INTO sources (id, name, kind, config, interval_minutes, cursor, next_fetch_at)
    VALUES (${id}, ${id}, 'mp_account', ${sql.json({ ghid: `gh_${id}` })}, 1440,
            ${cursor ? sql.json(cursor as never) : null}, '2100-01-01')`;
  return id;
}

async function job(sourceId: string, reason: string | null | undefined, state = "created", queue: string = QUEUES.mpCheck) {
  const id = await enqueue(queue, { sourceId, ...(reason === undefined ? {} : { reason }) },
    { singletonKey: `mp:${sourceId}`, startAfter: "2100-01-01", expireInSeconds: 900 });
  assert.ok(id);
  jobIds.push(id);
  if (state !== "created") await sql`UPDATE pgboss.job SET state = ${state} WHERE id = ${id}`;
  return id;
}

test("mpDue keeps the interval boundary and retry boundary used by reconcile", () => {
  const now = Date.parse("2026-10-30T00:00:00Z");
  const intervalMinutes = 1440;
  assert.equal(mpDue(null, intervalMinutes, now), true);
  assert.equal(mpDue({}, intervalMinutes, now), true);
  assert.equal(mpDue({ lastCheckedAt: new Date(now - 86400_000).toISOString() }, intervalMinutes, now), false);
  assert.equal(mpDue({ lastCheckedAt: new Date(now - 86400_001).toISOString() }, intervalMinutes, now), true);
  assert.equal(mpDue({ retryAt: new Date(now + 1).toISOString() }, intervalMinutes, now), false);
  assert.equal(mpDue({ retryAt: new Date(now).toISOString() }, intervalMinutes, now), true);
  assert.equal(mpDue({ lastCheckedAt: "invalid", retryAt: "invalid" }, intervalMinutes, now), true);
});

test("mpDue uses only retryAt for nonempty pending, regardless of the listing interval", () => {
  const now = Date.parse("2026-10-31T00:00:00Z");
  const cursor = { lastCheckedAt: new Date(now).toISOString(), pending: [{ url: "https://mp.weixin.qq.com/s/test", title: "待续", postedAt: null }] };
  assert.equal(mpDue(cursor, 10080, now), true);
  assert.equal(mpDue({ ...cursor, retryAt: new Date(now - 1).toISOString() }, 10080, now), true);
  assert.equal(mpDue({ ...cursor, retryAt: new Date(now).toISOString() }, 10080, now), true);
  assert.equal(mpDue({ ...cursor, retryAt: new Date(now + 1).toISOString() }, 0, now), false);
  assert.equal(mpDue({ ...cursor, pending: [] }, 10080, now), false);
});

test("a scheduled check that is not due buys nothing and creates no run, while manual forces a listing", async () => {
  const id = await source({ lastCheckedAt: new Date(Date.now() - 3600_000).toISOString() });
  const hits = provider.hits();
  assert.deepEqual(await checkMpAccount(id, "schedule"), { sourceId: id, status: "not-due" });
  assert.equal(provider.hits(), hits);
  const runs = await sql`SELECT id FROM fetch_runs WHERE source_id = ${id}`;
  assert.equal(runs.length, 0);
  assert.equal((await checkMpAccount(id, "manual")).status, "ok");
  assert.equal(provider.hits(), hits + 1);
});

test("a future retryAt stops both execution and reconcile, even on an account never checked", async () => {
  const id = await source({ retryAt: new Date(Date.now() + 3600_000).toISOString() });
  const hits = provider.hits();
  assert.deepEqual(await checkMpAccount(id, "schedule"), { sourceId: id, status: "not-due" });
  await scheduleMpReconcile();
  assert.equal((await sql`SELECT id FROM pgboss.job WHERE name = ${QUEUES.mpCheck} AND singleton_key = ${`mp:${id}`}`).length, 0);
  assert.equal((await sql`SELECT id FROM fetch_runs WHERE source_id = ${id}`).length, 0);
  assert.equal(provider.hits(), hits);
  assert.equal((await checkMpAccount(id, "manual")).status, "ok", "manual ignores the retry mark as well");
  assert.equal(provider.hits(), hits + 1);
});

test("budget waiting completes a scheduled job, persists a stable stagger, and still throws for manual", async () => {
  const id = await source();
  const jobId = await job(id, "schedule", "active");
  const service = `mp-budget-${tag()}`;
  services.push(service);
  const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts (logical_key, service, purpose, subject, status)
    VALUES (${service}, ${service}, 'test', ${id}, 'received') RETURNING id`;
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, pool, status, started_at)
    VALUES (${receipt!.id}, 1, 'everyinfra', 'everyinfra:wechat_oa', 'received', now() - interval '20 hours')`;
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts
    WHERE pool = 'everyinfra:wechat_oa' AND origin = 'live' AND started_at > now() - interval '1 day'`;
  const [budget] = await sql<{ per_day: number }[]>`SELECT per_day FROM budgets WHERE service = 'everyinfra:wechat_oa'`;
  await sql`UPDATE budgets SET per_day = ${count!.n} WHERE service = 'everyinfra:wechat_oa'`;
  await sql`UPDATE sources SET fail_count = 2, health = 'degraded' WHERE id = ${id}`;
  const hits = provider.hits();
  try {
    const result = await runBudgetAware({ id: jobId, name: QUEUES.mpCheck }, () => checkMpAccount(id, "schedule"));
    assert.equal(result?.status, "deferred");
    const [row] = await sql<{ cursor: { retryAt: string }; fail_count: number; health: string; last_error: string }[]>`
      SELECT cursor, fail_count, health, last_error FROM sources WHERE id = ${id}`;
    const retryAt = Date.parse(row!.cursor.retryAt);
    assert.ok(retryAt > Date.now());
    assert.equal(row!.fail_count, 2);
    assert.equal(row!.health, "degraded");
    assert.match(row!.last_error, /Budget/);
    assert.equal((result as { retryAt: string }).retryAt, row!.cursor.retryAt);
    await (await getBoss()).complete(QUEUES.mpCheck, jobId);
    const [finished] = await sql<{ state: string }[]>`SELECT state FROM pgboss.job WHERE id = ${jobId}`;
    assert.equal(finished!.state, "completed", "the wrapper did not turn the job into retry");
    await scheduleMpReconcile();
    assert.equal((await sql`SELECT id FROM pgboss.job WHERE singleton_key = ${`mp:${id}`}`).length, 1);

    const started = Date.now();
    let wait = 0;
    await assert.rejects(checkMpAccount(id, "manual"), (error: unknown) => {
      assert.ok(error instanceof BudgetExceededError);
      assert.equal(error.service, "everyinfra:wechat_oa");
      assert.equal(error.period, "day");
      wait = error.retryAfterSeconds;
      return true;
    });
    const stagger = retryAt - started - wait * 1000;
    assert.ok(stagger >= -3000 && stagger <= 15 * 60_000 + 3000, `stagger ${stagger}ms`);
    const [manual] = await sql<{ retry_at: string }[]>`SELECT cursor->>'retryAt' AS retry_at FROM sources WHERE id = ${id}`;
    assert.ok(Math.abs(Date.parse(manual!.retry_at) - retryAt) < 3000, "the same account keeps the same stagger");
    assert.equal(provider.hits(), hits);
    const runs = await sql<{ status: string; finished_at: Date }[]>`SELECT status, finished_at FROM fetch_runs WHERE source_id = ${id}`;
    assert.equal(runs.length, 2);
    assert.ok(runs.every((r) => r.status === "failed" && r.finished_at));
  } finally {
    await sql`UPDATE budgets SET per_day = ${budget!.per_day} WHERE service = 'everyinfra:wechat_oa'`;
  }
});

test("reconcile skips created, retry and active account jobs, and sends due accounts with a 900s expiry", async () => {
  for (const state of ["created", "retry", "active"]) {
    const id = await source();
    const jobId = await job(id, "schedule", state === "retry" ? "active" : state);
    if (state === "retry") await deferBudgetJob({ id: jobId, name: QUEUES.mpCheck }, new BudgetExceededError(`test-${tag()}`, "day", 3600));
    await scheduleMpReconcile();
    const jobs = await sql<{ id: string; state: string }[]>`SELECT id, state FROM pgboss.job WHERE name = ${QUEUES.mpCheck} AND singleton_key = ${`mp:${id}`}`;
    assert.deepEqual(jobs.map((j) => ({ id: j.id, state: j.state })), [{ id: jobId, state }]);
  }
  const due = await source();
  await job(due, "schedule", "completed");
  await scheduleMpReconcile();
  const [created] = await sql<{ expire_seconds: number; data: { reason: string } }[]>`
    SELECT expire_seconds, data FROM pgboss.job WHERE name = ${QUEUES.mpCheck} AND singleton_key = ${`mp:${due}`} AND state = 'created'`;
  assert.ok(created);
  assert.equal(created.expire_seconds, 900);
  assert.equal(created.data.reason, "schedule");
});

test("reconcile enqueues the three most overdue accounts, then the remaining two on the next run", async () => {
  const enabled = await sql<{ id: string }[]>`SELECT id FROM sources WHERE kind = 'mp_account' AND enabled`;
  if (enabled.length) await sql`UPDATE sources SET enabled = false WHERE id IN ${sql(enabled.map((s) => s.id))}`;
  const now = new Date();
  const ago = (hours: number) => new Date(now.getTime() - hours * 3600_000).toISOString();
  try {
    const recent = await source({ lastCheckedAt: ago(25) });
    const deferred = await source({ lastCheckedAt: ago(240), retryAt: ago(2) });
    const pending = await source({ lastCheckedAt: ago(1), retryAt: ago(5), pendingSince: ago(1),
      pending: [{ url: "https://mp.weixin.qq.com/s/test", title: "待续", postedAt: null }] });
    const overdue = await source({ lastCheckedAt: ago(100) });
    await sql`UPDATE sources SET interval_minutes = 2880 WHERE id = ${overdue}`;
    const never = await source();
    const ids = [recent, deferred, pending, overdue, never];
    const queued = () => sql<{ source_id: string }[]>`SELECT data->>'sourceId' AS source_id FROM pgboss.job
      WHERE name = ${QUEUES.mpCheck} AND state = 'created' AND data->>'sourceId' IN ${sql(ids)} ORDER BY created_on, id`;
    assert.deepEqual(await scheduleMpReconcile(now), { enqueued: 3 });
    assert.deepEqual((await queued()).map((j) => j.source_id), [never, overdue, pending]);
    assert.deepEqual(await scheduleMpReconcile(now), { enqueued: 2 });
    assert.deepEqual((await queued()).map((j) => j.source_id), [never, overdue, pending, deferred, recent]);
  } finally {
    if (enabled.length) await sql`UPDATE sources SET enabled = true WHERE id IN ${sql(enabled.map((s) => s.id))}`;
  }
});

test("manual checks use a 900s send expiry and keep the explicit force reason", async () => {
  const id = await source({ retryAt: new Date(Date.now() + 3600_000).toISOString() });
  const result = await fetchNow(id, `test-${tag()}`);
  assert.ok(result?.jobId);
  const [sent] = await sql<{ expire_seconds: number; data: { reason: string } }[]>`
    SELECT expire_seconds, data FROM pgboss.job WHERE id = ${result.jobId}`;
  assert.equal(sent!.expire_seconds, 900);
  assert.equal(sent!.data.reason, "manual");
});

test("only the WeChat listing gets 120s; bodies, XHS and X keep 60s, and explicit timeouts work", async (t) => {
  const id = await source();
  const deadlines: number[] = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms: number) => { deadlines.push(ms); return timeout(ms); });
  await everyInfraMpHistory(`gh_${tag()}`, { subject: id, window: tag() });
  await everyInfraMpArticle(`https://mp.weixin.qq.com/s/${tag()}`, { subject: id, identity: tag() });
  await everyInfraXhsNote(`https://www.xiaohongshu.com/explore/${tag()}`, { subject: id, identity: tag() });
  await everyInfraCall({ platform: "twitter", action: "search", subject: id, purpose: "test", window: tag() });
  await everyInfraCall({ platform: "twitter", action: "search", subject: id, purpose: "test", window: tag(), timeoutMs: 2500 });
  assert.deepEqual(deadlines, [120_000, 60_000, 60_000, 60_000, 2500]);
});

test("stale job selection includes only schedule created/retry jobs, including the default reason", async () => {
  const { staleMpJobs } = await import("../scripts/cancel-stale-mp-jobs.ts");
  const fixtures: Array<[string | null | undefined, string, boolean, string]> = [
    ["schedule", "created", true, QUEUES.mpCheck],
    ["schedule", "retry", true, QUEUES.mpCheck],
    [undefined, "created", true, QUEUES.mpCheck],
    [null, "retry", true, QUEUES.mpCheck],
    ["manual", "created", false, QUEUES.mpCheck],
    ["manual", "retry", false, QUEUES.mpCheck],
    ["schedule", "active", false, QUEUES.mpCheck],
    [undefined, "active", false, QUEUES.mpCheck],
    ["schedule", "completed", false, QUEUES.mpCheck],
    ["schedule", "cancelled", false, QUEUES.mpCheck],
    ["schedule", "created", false, QUEUES.fetchSource],
  ];
  const ids = new Set<string>();
  const expected: string[] = [];
  for (const [reason, state, selected, queue] of fixtures) {
    const id = await job(`mp-cleanup-${tag()}`, reason, state, queue);
    ids.add(id);
    if (selected) expected.push(id);
  }
  const selected = (await staleMpJobs()).filter((j) => ids.has(j.id));
  assert.deepEqual(selected.map((j) => j.id).sort(), expected.sort());
  for (const row of selected) {
    assert.deepEqual(Object.keys(row).sort(), ["id", "singleton_key", "state", "created_on", "start_after", "retry_count", "data"].sort());
    assert.ok(row.created_on instanceof Date);
    assert.ok(row.start_after instanceof Date);
    assert.equal(typeof row.retry_count, "number");
    assert.ok(row.data);
  }
});

for (const column of ["service", "pool"] as const) {
  for (const [period, seconds] of [["minute", 60], ["hour", 3600], ["day", 86400]] as const) {
    test(`${column} ${period} budget waits for enough live attempts to leave its rolling window`, async () => {
      const service = `window-${tag()}`;
      const pool = `${service}:pool`;
      services.push(service, pool);
      const name = column === "service" ? service : pool;
      await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day)
        VALUES (${name}, ${period === "minute" ? 2 : 1000}, ${period === "hour" ? 2 : 1000}, ${period === "day" ? 2 : 1000})`;
      const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts (logical_key, service, purpose, status)
        VALUES (${service}, ${service}, 'test', 'received') RETURNING id`;
      const started = [0.9, 0.7, 0.3, 2, 0.05, 0.05].map((fraction) => new Date(Date.now() - seconds * fraction * 1000));
      for (let i = 0; i < started.length; i++) {
        await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, pool, status, started_at, origin)
          VALUES (${receipt!.id}, ${i + 1}, ${service}, ${pool}, 'received', ${started[i]!}, ${i === 4 ? "replay" : i === 5 ? "imported" : "live"})`;
      }
      let sent = 0;
      const req = { service, pool, purpose: "test", identity: tag() };
      const call = async () => { sent++; return { response: {} }; };
      for (const limit of [2, 3]) {
        await sql`UPDATE budgets SET ${sql({ [`per_${period}`]: limit })} WHERE service = ${name}`;
        await assert.rejects(paidRequest(req, call), (error: unknown) => {
          assert.ok(error instanceof BudgetExceededError);
          assert.equal(error.service, name);
          assert.equal(error.period, period);
          const expected = (started[3 - limit]!.getTime() + seconds * 1000 - Date.now()) / 1000;
          assert.ok(Math.abs(error.retryAfterSeconds - expected) < 3, `expected ~${expected}s, got ${error.retryAfterSeconds}s`);
          return true;
        });
      }
      assert.equal(sent, 0);
    });
  }
}
