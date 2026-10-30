// Ops alerts reach the site owner: a problem is announced once, repeated no more than its level allows
// (hourly for reader impact), closed with one recovery message; entries from before the levels existed
// close without a message.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { checkAlerts, collectFindings } from "@aihot/backend/operations/alerts";
import { beijingStamp } from "@aihot/backend/notify/feishu";

const T = tag();
const SOURCE = `test-alerts-${T}`;
let saved: { key: string; value: unknown }[] = [];
const ids: string[] = [];
const paidSources: string[] = [];
let enabledPaidSources: Array<{ id: string }> = [];

before(async () => {
  await getBoss(); // collectFindings reads the job tables
  enabledPaidSources = await sql`SELECT id FROM sources WHERE enabled AND (kind = 'mp_account' OR config->>'adapter' LIKE 'everyinfra_%')`;
  if (enabledPaidSources.length) await sql`UPDATE sources SET enabled = false WHERE id IN ${sql(enabledPaidSources.map((s) => s.id))}`;
  saved = await sql`SELECT key, value FROM settings WHERE key IN ('alerts.state', 'heartbeat.worker')`;
  await sql`DELETE FROM settings WHERE key = 'heartbeat.worker'`;
  await sql`INSERT INTO sources (id, name, kind, next_fetch_at) VALUES (${SOURCE}, 'Test alerts', 'rss', '2100-01-01')`;
  // Ten new articles that have waited three hours: new content is stuck, readers see nothing new.
  for (let i = 0; i < 10; i++) {
    const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${T}-${i}`, title: `stuck ${i}`, bodyStatus: "none", via: "fetch" } as never);
    ids.push(articleId);
  }
  await sql`UPDATE articles SET discovered_at = now() - interval '3 hours', processing_state = 'new' WHERE id IN ${sql(ids)}`;
});
after(async () => {
  if (paidSources.length) await sql`DELETE FROM sources WHERE id IN ${sql(paidSources)}`;
  if (enabledPaidSources.length) await sql`UPDATE sources SET enabled = true WHERE id IN ${sql(enabledPaidSources.map((s) => s.id))}`;
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await sql`DELETE FROM settings WHERE key = 'alerts.state'`;
  for (const s of saved) await sql`INSERT INTO settings (key, value, updated_by) VALUES (${s.key}, ${sql.json(s.value as never)}, 'test') ON CONFLICT (key) DO NOTHING`;
  await stopBoss();
  await closeDb();
});

test("an outage is announced once, repeated hourly, and closed with one recovery", async () => {
  process.env.COLLECT_ENABLED = "true";
  process.env.MODEL_CALLS_ENABLED = "true";
  const t0 = Date.now();
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('alerts.state', ${sql.json({ "receipts.unknown": { title: "付费请求结果未知", since: new Date(t0 - 86400_000).toISOString(), sentAt: new Date(t0 - 3600_000).toISOString() } })}, 'test')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  const stuck = (sent: string[]) => sent.filter((k) => k.startsWith("content.process"));

  let r = await checkAlerts(t0);
  assert.deepEqual(stuck(r.sent), ["content.process"]);
  assert.ok(!r.sent.some((k) => k.startsWith("receipts.unknown")), "an entry from before the levels closes silently");
  assert.ok(!r.open.includes("receipts.unknown"));
  r = await checkAlerts(t0 + 50 * 60_000);
  assert.deepEqual(stuck(r.sent), [], "no repeat within the hour");
  r = await checkAlerts(t0 + 61 * 60_000);
  assert.deepEqual(stuck(r.sent), ["content.process"], "hourly reminder while it lasts");

  await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id IN ${sql(ids)}`;
  r = await checkAlerts(t0 + 70 * 60_000);
  assert.deepEqual(stuck(r.sent), ["content.process:recovered"]);
  r = await checkAlerts(t0 + 80 * 60_000);
  assert.deepEqual(stuck(r.sent), []);
});

test("paid sources overdue by two intervals plus six hours, or a day without success, join the digest", async () => {
  const now = Date.now();
  const last = new Date(now - 55 * 3600_000);
  const mp = `${SOURCE}-mp`;
  const xhs = `${SOURCE}-xhs`;
  const never = `${SOURCE}-never`;
  const sources = [mp, xhs, never];
  paidSources.push(...sources);
  try {
    await sql`INSERT INTO sources (id, name, kind, interval_minutes, cursor, last_ok_at)
      VALUES (${mp}, '过期公众号', 'mp_account', 1440, ${sql.json({ lastCheckedAt: last.toISOString() })}, ${new Date(now)})`;
    await sql`INSERT INTO sources (id, name, kind, interval_minutes, config, last_ok_at, cursor)
      VALUES (${xhs}, '过期小红书', 'json_list', 720, '{"adapter":"everyinfra_xhs"}', ${last}, ${sql.json({ lastCheckedAt: new Date(now).toISOString() })})`;
    await sql`INSERT INTO sources (id, name, kind, interval_minutes, created_at)
      VALUES (${never}, '从未成功公众号', 'mp_account', 10080, ${new Date(now - 86400_001)})`;
    for (let i = 0; i < 7; i++) {
      const id = `${SOURCE}-extra-${i}`;
      sources.push(id);
      paidSources.push(id);
      await sql`INSERT INTO sources (id, name, kind, interval_minutes, cursor)
        VALUES (${id}, ${`额外过期${i}`}, 'mp_account', 1440, ${sql.json({ lastCheckedAt: new Date(now - 54 * 3600_000 - 1).toISOString() })})`;
    }
    const finding = (await collectFindings(now)).find((f) => f.key === "sources.paid-stale");
    assert.ok(finding);
    assert.equal(finding.level, "digest");
    assert.match(finding.title, /10/);
    for (const name of ["过期公众号", "过期小红书", "从未成功公众号"]) assert.ok(finding.detail?.includes(name));
    assert.ok(finding.detail?.includes(beijingStamp(last)));
    for (const interval of [1440, 720, 10080]) assert.ok(finding.detail?.includes(`${interval} 分钟`));
    assert.match(finding.detail!, /从未成功/);
    assert.equal(finding.detail!.split("；").length, 8, "count every stale source but list only the first eight");
    assert.ok(!finding.detail!.includes("额外过期6"));
    const checked = await checkAlerts(now);
    assert.ok(!checked.sent.includes(finding.key) && !checked.open.includes(finding.key), "digest findings are not pushed immediately");
  } finally {
    await sql`DELETE FROM sources WHERE id IN ${sql(sources)}`;
  }
});

test("paid source grace boundaries, a new account, disabled sources and free sources do not alert", async () => {
  const now = Date.now();
  const fixtures = [
    { kind: "mp_account", interval: 1440, cursor: { lastCheckedAt: new Date(now - 54 * 3600_000).toISOString() }, last: new Date(now - 100 * 3600_000), config: {}, enabled: true, created: new Date(now - 2 * 86400_000) },
    { kind: "json_list", interval: 720, cursor: null, last: new Date(now - 30 * 3600_000), config: { adapter: "everyinfra_xhs" }, enabled: true, created: new Date(now - 2 * 86400_000) },
    { kind: "mp_account", interval: 1440, cursor: null, last: null, config: {}, enabled: true, created: new Date(now - 86400_000) },
    { kind: "mp_account", interval: 10080, cursor: { lastCheckedAt: new Date(now - 10 * 86400_000).toISOString() }, last: null, config: {}, enabled: true, created: new Date(now - 20 * 86400_000) },
    { kind: "mp_account", interval: 1440, cursor: null, last: null, config: {}, enabled: false, created: new Date(now - 2 * 86400_000) },
    { kind: "rss", interval: 30, cursor: null, last: null, config: {}, enabled: true, created: new Date(now - 2 * 86400_000) },
  ];
  const sources: string[] = [];
  try {
    for (const f of fixtures) {
      const id = `${SOURCE}-${tag()}`;
      sources.push(id);
      paidSources.push(id);
      await sql`INSERT INTO sources (id, name, kind, interval_minutes, cursor, last_ok_at, config, enabled, created_at)
        VALUES (${id}, ${id}, ${f.kind}, ${f.interval}, ${f.cursor ? sql.json(f.cursor) : null}, ${f.last}, ${sql.json(f.config)}, ${f.enabled}, ${f.created})`;
    }
    assert.ok(!(await collectFindings(now)).some((f) => f.key === "sources.paid-stale"));
  } finally {
    await sql`DELETE FROM sources WHERE id IN ${sql(sources)}`;
  }
});

for (const { lists, failed, skipped, alerts } of [
  { lists: 10, failed: 4, skipped: 0, alerts: true },
  { lists: 0, failed: 0, skipped: 201, alerts: true },
  { lists: 9, failed: 4, skipped: 200, alerts: false },
  { lists: 10, failed: 3, skipped: 200, alerts: false },
]) {
  test(`WeChat waste: ${failed}/${lists} failed lists, ${skipped} budget skips ${alerts ? "alert" : "do not alert"}`, async () => {
    // Isolate the rolling window from previous files' provider attempts in a reused database.
    const now = Date.now() + 2 * 86400_000;
    const job = `alerts-waste-${tag()}`;
    try {
      for (const [purpose, n, failures] of [["mp_history", lists, failed], ["mp_article", 2, 0]] as const) {
        const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts (logical_key, service, purpose, subject, status)
          VALUES (${`${job}:${purpose}`}, 'everyinfra', ${purpose}, ${job}, 'completed') RETURNING id`;
        await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, pool, status, started_at)
          SELECT ${receipt!.id}, n, 'everyinfra', 'everyinfra:wechat_oa', CASE WHEN n <= ${failures} THEN 'failed' ELSE 'received' END,
                 ${new Date(now - 3600_000)} FROM generate_series(1, ${n}::int) n`;
      }
      await sql`INSERT INTO job_runs (job, status, detail, started_at)
        SELECT ${job}, 'skipped', '{"service":"everyinfra:wechat_oa"}'::jsonb, ${new Date(now - 3600_000)} FROM generate_series(1, ${skipped}::int)`;
      // Other platforms' list failures, old skips and skips of unrelated services do not count.
      const [other] = await sql<{ id: number }[]>`INSERT INTO receipts (logical_key, service, purpose, subject, status)
        VALUES (${`${job}:other`}, 'everyinfra', 'mp_history', ${job}, 'failed') RETURNING id`;
      await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, pool, status, started_at, origin)
        SELECT ${other!.id}, n, 'everyinfra', CASE WHEN n = 1 THEN 'everyinfra:xiaohongshu' ELSE 'everyinfra:wechat_oa' END,
               'failed', ${new Date(now - 3600_000)}, CASE WHEN n = 1 THEN 'live' ELSE 'replay' END FROM generate_series(1, 10) n`;
      await sql`INSERT INTO job_runs (job, status, detail, started_at) SELECT ${job}, 'skipped', '{"service":"everyinfra"}'::jsonb,
        ${new Date(now - 25 * 3600_000)} FROM generate_series(1, 201)`;
      await sql`INSERT INTO job_runs (job, status, detail, started_at) SELECT ${job}, 'skipped', '{"service":"deepseek-tools"}'::jsonb,
        ${new Date(now - 3600_000)} FROM generate_series(1, 201)`;
      const finding = (await collectFindings(now)).find((f) => f.key === "budget.wechat-waste");
      assert.equal(!!finding, alerts);
      if (finding) {
        assert.equal(finding.level, "digest");
        assert.ok(finding.detail?.includes(`成功列表 ${lists - failed}`));
        assert.ok(finding.detail?.includes(`失败列表 ${failed}`));
        assert.ok(finding.detail?.includes("正文 2"));
        assert.ok(finding.detail?.includes(`预算跳过 ${skipped}`));
        assert.match(finding.detail!, /重复投递.*列表接口变慢/);
      }
    } finally {
      await sql`DELETE FROM receipts WHERE subject = ${job}`;
      await sql`DELETE FROM job_runs WHERE job = ${job}`;
    }
  });
}
