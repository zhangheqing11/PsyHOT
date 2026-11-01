// The weekly "quiet sources" list reads each source's own delivery rhythm instead of a fixed week: a
// monthly journal is not late ten days after an issue, a daily one is after eight; a whole issue whose
// articles carry spread-out online dates is one delivery, not a daily rhythm; a source with too little
// history stays visible instead of being called fine; and the list has no display cut-off that hides
// a broken source behind thirty quiet ones (production on 2026-11-01: 45 listed, 15 shown).
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { quietSources, rhythmText, sourceHealthWeekly } from "@aihot/backend/operations/reports";

const T = tag();
const now = Date.now();
const day = 86400_000;
const ago = (days: number) => new Date(now - days * day);
process.env.FEISHU_INTERNAL_ENABLED = "false";
after(async () => { await closeDb(); });

async function source(id: string, opts: { mode?: string; created?: Date; health?: string } = {}) {
  id = `${T}-${id}`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,health,created_at,next_fetch_at)
    VALUES(${id},${id},'rss','T1',${opts.mode ?? "editorial"},${opts.health ?? "ok"},${opts.created ?? ago(100)},'2100-01-01')`;
  return id;
}
let seq = 0;
/** One article, delivered (discovered) `deliveredDaysAgo` days ago and published `publishedDaysAgo`. */
async function article(sourceId: string, deliveredDaysAgo: number, publishedDaysAgo = deliveredDaysAgo, backfillReason: string | null = null) {
  const id = `${sourceId}-a${seq++}`;
  const url = `https://example.test/${id}`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,backfill,backfill_reason)
    VALUES(${id},${sourceId},${`url:${url}`},${url},${id},${ago(publishedDaysAgo)},${ago(deliveredDaysAgo)},${ago(publishedDaysAgo)},
      ${backfillReason !== null},${backfillReason})`;
  return id;
}
const deliveries = async (sourceId: string, daysAgo: number[]) => { for (const d of daysAgo) await article(sourceId, d); };
const row = <R extends { id: string }>(rows: R[], id: string) => rows.find((s) => s.id === id);

test("a monthly source ten days after its last delivery is not late, a daily one after eight is", async () => {
  const monthly = await source("monthly");
  const daily = await source("daily");
  await deliveries(monthly, [10, 40, 70, 89]);
  await deliveries(daily, [8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  const q = await quietSources(now);
  assert.equal(row(q.overdue, daily)?.id, daily, "a daily source quiet for eight days is eight times its rhythm");
  assert.equal(rhythmText(row(q.overdue, daily)!), "近 8 天没有新内容，平时约 1 天就有新内容（8 倍）");
  for (const list of [q.overdue, q.unknown, q.never]) assert.equal(row(list, monthly), undefined, "inside its own rhythm: not reported at all");
});

test("an issue delivered at once is one delivery, however spread its articles' publication dates are", async () => {
  // A monthly journal: each issue arrives in one go, its articles published online on ten different days
  // before it. Dated by publication it would look daily and late; by delivery it is a month apart.
  const journal = await source("issue-journal");
  for (const issue of [10, 40, 70, 85]) for (let i = 0; i < 10; i++) await article(journal, issue, issue + i * 2);
  const q = await quietSources(now);
  for (const list of [q.overdue, q.unknown, q.never]) assert.equal(row(list, journal), undefined);
});

test("too little history stays visible, apart from never receiving anything", async () => {
  const thin = await source("thin");
  const never = await source("never");
  const lapsed = await source("lapsed");
  await deliveries(thin, [8, 38]);
  await deliveries(lapsed, [120]);
  const q = await quietSources(now);
  assert.equal(row(q.unknown, thin)?.id, thin, "two delivery days are not a rhythm");
  assert.equal(row(q.unknown, lapsed)?.id, lapsed, "a delivery outside the window is history, not rhythm");
  assert.equal(row(q.unknown, lapsed)?.evidence_days, 0);
  assert.equal(row(q.never, never)?.id, never);
  assert.equal(row(q.unknown, never), undefined);
  for (const id of [thin, never, lapsed]) assert.equal(row(q.overdue, id), undefined);
});

test("a first import is one delivery day, so it can neither fake a rhythm nor hide a silence", async () => {
  const batch = await source("import-batch");
  const spread = await source("import-spread");
  for (const p of [8, 9, 10, 11]) await article(batch, 8, p, "first-import");
  for (const p of [80, 50, 20]) await article(spread, 20, p, "first-import");
  const q = await quietSources(now);
  for (const id of [batch, spread]) {
    assert.equal(row(q.unknown, id)?.evidence_days, 1, id);
    assert.equal(row(q.overdue, id), undefined, id);
  }
});

test("an attributed rediscovery is a delivery for the source that found it", async () => {
  const publisher = await source("publisher");
  const collector = await source("collector");
  const recent = await article(publisher, 3);
  await sql`INSERT INTO article_discoveries(article_id,source_id,via,discovered_at) VALUES(${recent},${collector},'fetch',${ago(2)})`;
  const q = await quietSources(now);
  for (const list of [q.overdue, q.unknown, q.never]) assert.equal(row(list, collector), undefined, "found something two days ago: not quiet");
});

test("the weekly report lists every quiet source, keeps failing and hot-signal ones out of the quiet lists", async () => {
  const many: string[] = [];
  for (let i = 0; i < 18; i++) { const id = await source(`thin-${i}`); await deliveries(id, [20]); many.push(id); }
  const late = await source("late");
  await deliveries(late, [8, 9, 10, 11, 12]);
  const failing = await source("failing", { health: "failing" });
  await deliveries(failing, [8, 9, 10, 11, 12]);
  const account = await source("account", { mode: "hot_signal" });
  await deliveries(account, [8, 9, 10, 11, 12]);
  const fresh = await source("fresh", { created: ago(3) });
  const q = await quietSources(now);
  assert.equal(row(q.hot, account)?.id, account);
  for (const list of [q.overdue, q.unknown, q.never]) {
    assert.equal(row(list, account), undefined, "hot-signal accounts are counted, not listed");
    assert.equal(row(list, failing), undefined, "failing sources have their own section");
    assert.equal(row(list, fresh), undefined, "a source younger than a week is not judged");
  }
  const lines: string[] = [];
  const log = console.log;
  console.log = (value: unknown) => { lines.push(String(value)); };
  let result;
  try { result = await sourceHealthWeekly(now); } finally { console.log = log; }
  const text = (JSON.parse(lines.find((l) => l.includes("信源周报"))!) as { lines: string[] }).lines.join("\n");
  for (const id of many) assert.ok(text.includes(`${id}（最近 `), `${id} is listed, not cut off at a display limit`);
  assert.match(text, new RegExp(`· ${late}：近 8 天没有新内容，平时约 1 天就有新内容（8 倍）`));
  assert.match(text, /超出自身更新节奏/);
  assert.match(text, /热度信号信源 \d+ 个 7 天没有新内容/);
  assert.ok(!text.includes(`· ${account}`) && !text.includes(`${account}（`));
  assert.ok(result!.unknown >= 18 && result!.overdue >= 1 && result!.hot >= 1);
});
