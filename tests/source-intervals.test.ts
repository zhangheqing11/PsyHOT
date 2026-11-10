import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSource, listSources, sourceDetail, updateSource } from "@aihot/backend/admin/sources";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { adaptIntervals } from "@aihot/backend/sources/collect";

const T = tag();
after(async () => { await stopBoss(); await closeDb(); });

test("interval adaptation respects the configured floor and keeps legacy, shard and EveryInfra cadences", async () => {
  const floor = `floor-rss-${T}`;
  const legacy = `legacy-rss-${T}`;
  const shard = `floor-shard-${T}`;
  const paid = `floor-everyinfra-${T}`;
  for (const [id, minimum] of [[floor, 360], [legacy, null]] as const) {
    await sql`INSERT INTO sources (id, name, kind, interval_minutes, min_interval_minutes, next_fetch_at)
      VALUES (${id}, ${id}, 'rss', 60, ${minimum}, '2100-01-01')`;
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, backfill)
      SELECT ${id} || '-' || n, ${id}, ${id} || '-' || n, 'https://example.org/' || ${id} || '/' || n, 'A study', now(), now(), false
      FROM generate_series(1, 700) n`;
  }
  await sql`INSERT INTO sources (id, name, kind, config, cursor, interval_minutes, min_interval_minutes, next_fetch_at)
    VALUES (${shard}, ${shard}, 'x_search', ${sql.json({ query: "from:flooracct -filter:replies" })},
      ${sql.json({ initializedAt: new Date().toISOString(), lastTweetId: "123" })}, 360, 360, '2100-01-01'),
      (${paid}, ${paid}, 'json_list', ${sql.json({ adapter: "everyinfra_xhs" })}, null, 1440, 2880, '2100-01-01')`;
  await adaptIntervals();
  const rows = await sql`SELECT id, interval_minutes, min_interval_minutes, next_fetch_at FROM sources
    WHERE id IN ${sql([floor, legacy, shard, paid])}`;
  const actual = Object.fromEntries(rows.map((r) => [r.id, r.interval_minutes]));
  assert.deepEqual(actual, { [floor]: 360, [legacy]: 15, [shard]: 30, [paid]: 1440 });
  for (const r of rows) assert.equal(r.next_fetch_at.toISOString(), "2100-01-01T00:00:00.000Z");
});

test("admin creation and interval edits save the minimum, expose it, and audit both values", async () => {
  const id = `admin-interval-${T}`;
  const created = await createSource({ id, name: id, kind: "rss", config: { feedUrl: `https://example.org/${id}.xml` }, interval_minutes: 360 }, "test");
  assert.equal(created.created, true);
  assert.equal(created.created && created.source.min_interval_minutes, 360);
  const [before] = await sql`SELECT updated_at, next_fetch_at FROM sources WHERE id = ${id}`;
  const saved = await updateSource(id, { patch: { interval_minutes: 720 }, version: before!.updated_at.toISOString(), reason: "interval regression" }, "test");
  assert.deepEqual([saved!.interval_minutes, saved!.min_interval_minutes], [720, 720]);
  assert.equal(saved!.next_fetch_at.toISOString(), before!.next_fetch_at.toISOString());
  const listing = await listSources({ q: id });
  assert.equal(listing.rows.find((r) => r.id === id)?.min_interval_minutes, 720);
  assert.equal((await sourceDetail(id))!.source.min_interval_minutes, 720);
  const [audit] = await sql`SELECT before, after FROM audit_log WHERE subject = ${`source:${id}`} AND action = 'source.update' ORDER BY id DESC LIMIT 1`;
  assert.deepEqual(audit!.before, { interval_minutes: 360, min_interval_minutes: 360 });
  assert.deepEqual(audit!.after, { interval_minutes: 720, min_interval_minutes: 720 });
});

test("applying source intervals is read-only by default, audited on apply and preserves staggered due times", async () => {
  const { applySourceIntervals } = await import("../scripts/apply-source-intervals.ts");
  const ids = ["raise", "slower", "unlisted"].map((name) => `apply-interval-${name}-${T}`);
  for (const [i, id] of ids.entries()) {
    await sql`INSERT INTO sources (id, name, kind, interval_minutes, next_fetch_at)
      VALUES (${id}, ${id}, 'rss', ${i === 1 ? 1440 : 60}, ${new Date(Date.UTC(2100, 0, 1, 0, i * 10))})`;
  }
  const wanted = [{ id: ids[0]!, interval_minutes: 360 }, { id: ids[1]!, interval_minutes: 360 }, { id: `missing-${T}`, interval_minutes: 360 }];
  const rows = () => sql`SELECT id, interval_minutes, min_interval_minutes, next_fetch_at, updated_at FROM sources WHERE id IN ${sql(ids)} ORDER BY id`;
  const before = await rows();
  const messages: string[] = [];
  assert.equal(await applySourceIntervals(wanted, { report: (line) => messages.push(line) }), 2);
  assert.deepEqual(await rows(), before, "preview changes no rows or versions");
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject IN ${sql(ids.map((id) => `source:${id}`))}`).length, 0);
  assert.ok(messages.some((line) => line.includes(ids[0]!) && line.includes("60") && line.includes("360")));
  assert.equal(await applySourceIntervals(wanted, { apply: true, report: () => {} }), 2);
  const after = await rows();
  for (const r of after) {
    const old = before.find((b) => b.id === r.id)!;
    assert.equal(r.next_fetch_at.toISOString(), old.next_fetch_at.toISOString(), r.id);
    assert.equal(r.interval_minutes, r.id === ids[0] ? 360 : old.interval_minutes);
    assert.equal(r.min_interval_minutes, r.id === ids[2] ? null : 360);
  }
  const audits = await sql`SELECT subject, before, after FROM audit_log WHERE subject IN ${sql(ids.map((id) => `source:${id}`))}`;
  assert.equal(audits.length, 2);
  assert.deepEqual(audits.find((a) => a.subject === `source:${ids[1]}`)!.after, { interval_minutes: 1440, min_interval_minutes: 360 });
  assert.equal(await applySourceIntervals(wanted, { apply: true, report: () => {} }), 0, "reapplying is a no-op");
});

test("applying source intervals leaves EveryInfra and other manually scheduled sources unchanged", async () => {
  const { applySourceIntervals } = await import("../scripts/apply-source-intervals.ts");
  const ids: string[] = [];
  for (const [label, kind, config, cursor, interval, minimum] of [
    ["everyinfra", "json_list", { adapter: "everyinfra_xhs" }, null, 1440, 720],
    ["shard", "x_search", { query: "from:manualfloor -filter:replies" }, { lastTweetId: "123" }, 30, 360],
    ["wechat", "mp_account", {}, null, 1440, null],
    ["external", "external", {}, null, 360, null],
  ] as const) {
    const id = `manual-interval-${label}-${T}`;
    ids.push(id);
    await sql`INSERT INTO sources (id, name, kind, config, cursor, interval_minutes, min_interval_minutes, next_fetch_at)
      VALUES (${id}, ${id}, ${kind}, ${sql.json(config)}, ${cursor ? sql.json(cursor) : null}, ${interval}, ${minimum}, '2100-01-01')`;
  }
  const rows = () => sql`SELECT id, interval_minutes, min_interval_minutes, next_fetch_at, updated_at FROM sources WHERE id IN ${sql(ids)} ORDER BY id`;
  const before = await rows();
  const messages: string[] = [];
  const wanted = ids.map((id) => ({ id, interval_minutes: 2880 }));
  await applySourceIntervals(wanted, { report: (line) => messages.push(line) });
  assert.deepEqual(await rows(), before);
  const changed = await applySourceIntervals(wanted, { apply: true, report: () => {} });
  assert.deepEqual(await rows(), before, "EveryInfra and other manual intervals and floors survive --apply");
  assert.equal(changed, 0);
  assert.equal(messages.at(-1), "跳过 4 个由站长手动设定间隔的源");
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject IN ${sql(ids.map((id) => `source:${id}`))}`).length, 0);
});

test("applying source intervals includes disabled adaptive sources and unsharded X searches", async () => {
  const { applySourceIntervals } = await import("../scripts/apply-source-intervals.ts");
  const ids = ["disabled", "unsharded"].map((label) => `adaptive-interval-${label}-${T}`);
  await sql`INSERT INTO sources (id, name, kind, config, enabled, interval_minutes, next_fetch_at)
    VALUES (${ids[0]}, ${ids[0]}, 'rss', '{}', false, 60, '2100-01-01'),
      (${ids[1]}, ${ids[1]}, 'x_search', ${sql.json({ query: "psychology -filter:replies" })}, true, 60, '2100-01-01')`;
  assert.equal(await applySourceIntervals(ids.map((id) => ({ id, interval_minutes: 360 })), { apply: true, report: () => {} }), 2);
  const rows = await sql`SELECT interval_minutes, min_interval_minutes, next_fetch_at FROM sources WHERE id IN ${sql(ids)}`;
  for (const r of rows) {
    assert.deepEqual([r.interval_minutes, r.min_interval_minutes], [360, 360]);
    assert.equal(r.next_fetch_at.toISOString(), "2100-01-01T00:00:00.000Z");
  }
});
