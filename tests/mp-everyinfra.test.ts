// Fixed WeChat accounts through EveryInfra against a local stub: only the configured account's own
// recent articles get a paid body, a listing of another account stops the source instead of buying
// anything, and a body that failed for a passing reason is fetched on the next check.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { BudgetExceededError } from "@aihot/backend/providers/receipts";
import { checkMpAccount, postsToTake } from "@aihot/backend/sources/mp";

const T = tag();
const BIZ = Buffer.from(`own-${T}`).toString("base64");
const OTHER = Buffer.from(`other-${T}`).toString("base64");
const link = (biz: string, mid: number) => `http://mp.weixin.qq.com/s?__biz=${encodeURIComponent(biz)}&mid=${mid}&idx=1&sn=sn${mid}&chksm=c${mid}&scene=126`;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

let listing: Array<Record<string, unknown>> = [];
const bodies: string[] = [];
let failNextBody = false;
let failListing = false;
let listings = 0;
const provider = await stub((_hit, req) => {
  const call = JSON.parse(req.body) as { action: string; params: { url?: string } };
  if (call.action === "account_articles") {
    listings++;
    if (failListing) return new Reply(503, { error: "busy" });
    return { id: `l-${T}`, billing: { charged_usd: 0.005556 }, results: listing };
  }
  bodies.push(call.params.url!);
  if (failNextBody) { failNextBody = false; return new Reply(503, { error: "busy" }); }
  return { id: `b-${T}-${bodies.length}`, billing: { charged_usd: 0.0055 },
    results: { content_html: `<p>正文 ${T}</p><p>第二段</p>`, author: "作者", digest: "摘要" } };
});
process.env.EVERYINFRA_BASE_URL = provider.url;
process.env.EVERYINFRA_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

let saved: Array<{ service: string; per_minute: number; per_hour: number; per_day: number }> = [];
before(async () => {
  saved = await sql`SELECT service, per_minute, per_hour, per_day FROM budgets WHERE service LIKE 'everyinfra%'`;
  await sql`UPDATE budgets SET per_minute = 10000, per_hour = 10000, per_day = 10000 WHERE service LIKE 'everyinfra%'`;
});
after(async () => {
  for (const b of saved) await sql`UPDATE budgets SET per_minute = ${b.per_minute}, per_hour = ${b.per_hour}, per_day = ${b.per_day} WHERE service = ${b.service}`;
  await provider.close();
  await stopBoss();
  await closeDb();
});

const source = async (id: string, cursor: Record<string, unknown> | null, filter?: Record<string, string[]>) => {
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, cursor, next_fetch_at)
    VALUES (${id}, ${id}, 'mp_account', ${sql.json({ ghid: `gh_${id}`, wechatBiz: BIZ, ...(filter ? { ingestNoiseFilter: filter } : {}) })},
            'T1', 'editorial', 1440, ${cursor ? sql.json(cursor as never) : null}, '2100-01-01')`;
  return id;
};

async function account(id: string) {
  const [row] = await sql<{
    cursor: { lastCheckedAt?: string; retryAt?: string; pendingSince?: string; unavailableCount?: number;
      pending?: Array<{ url: string; title: string; postedAt: string | null }> };
    last_fetch_at: Date | null; last_ok_at: Date | null; next_fetch_at: Date; fail_count: number; health: string;
  }[]>`SELECT cursor, last_fetch_at, last_ok_at, next_fetch_at, fail_count, health FROM sources WHERE id = ${id}`;
  assert.ok(row);
  return row;
}

async function allowCalls(calls: number) {
  const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts
    WHERE pool = 'everyinfra:wechat_oa' AND origin = 'live' AND started_at > now() - interval '1 day'`;
  await sql`UPDATE budgets SET per_day = ${count!.n + calls} WHERE service = 'everyinfra:wechat_oa'`;
}

test("which posts a check takes: the account's own, since the last check, never older than ten days, none on the first", () => {
  const post = (biz: string, mid: number, h: number) => ({ url: link(biz, mid), title: `t${mid}`, postedAt: new Date(Date.now() - h * 3600_000), ghid: null });
  const posts = [post(BIZ, 1, 2), post(BIZ, 2, 60), post(BIZ, 3, 100), post(OTHER, 4, 1), post(BIZ, 5, 400)];
  assert.deepEqual(postsToTake(posts, BIZ, null).take, [], "the first check only sets the mark");
  assert.deepEqual(postsToTake(posts, BIZ, { lastCheckedAt: hoursAgo(72) }).take.map((p) => p.title), ["t1", "t2", "t3"], "since the last check, with a margin");
  assert.deepEqual(postsToTake(posts, BIZ, { lastCheckedAt: hoursAgo(24 * 60) }).take.map((p) => p.title), ["t1", "t2", "t3"], "ten days at most");
  assert.equal(postsToTake([post(OTHER, 6, 1)], BIZ, null).mismatch, true);
  assert.equal(postsToTake([], BIZ, null).mismatch, false, "an empty listing is no mismatch");
});

test("only the account's own new articles are bought, and a passing body failure is fetched next time", async () => {
  const id = await source(`mp-ei-${T}`, { lastCheckedAt: hoursAgo(24) }, { dropMarkers: ["招聘"] });
  listing = [
    { url: link(BIZ, 1), title: `新研究 ${T}`, posted_at: hoursAgo(3), account_ghid: `gh_${T}` },
    { url: link(BIZ, 2), title: `招聘启事 ${T}`, posted_at: hoursAgo(4), account_ghid: `gh_${T}` },
    { url: link(BIZ, 3), title: `旧文 ${T}`, posted_at: hoursAgo(24 * 30), account_ghid: `gh_${T}` },
    { url: link(OTHER, 4), title: `别的号 ${T}`, posted_at: hoursAgo(2), account_ghid: "gh_other" },
  ];
  failNextBody = true;
  const first = await checkMpAccount(id, "manual");
  assert.equal(first.status, "ok");
  assert.deepEqual(bodies, [link(BIZ, 1)], "one body call: not the filtered, the old or the other account's article");
  const article = async () => (await sql<{ body_status: string; revision: number; body_text: string | null }[]>`
    SELECT body_status, revision, body_text FROM articles WHERE source_id = ${id}`)[0]!;
  assert.equal((await article()).body_status, "none");
  await sql`UPDATE sources SET cursor = jsonb_set(cursor, '{lastCheckedAt}', ${sql.json(hoursAgo(24))}) WHERE id = ${id}`;
  await checkMpAccount(id, "manual");
  assert.equal(bodies.length, 2, "the body is asked for once more");
  const after = await article();
  assert.equal(after.body_status, "ok");
  assert.match(after.body_text ?? "", /正文/);
  assert.equal(after.revision, 2, "the body arrives as a new revision");
  await checkMpAccount(id, "manual");
  assert.equal(bodies.length, 2, "a stored article is not bought again");
});

test("a listing of another account stops the source for a week without buying a body", async () => {
  const id = await source(`mp-ei-wrong-${T}`, null);
  listing = [{ url: link(OTHER, 7), title: `别的号 ${T}`, posted_at: hoursAgo(1), account_ghid: "gh_other" }];
  const before = bodies.length;
  const result = await checkMpAccount(id, "manual");
  assert.equal(result.status, "failed");
  assert.equal(bodies.length, before);
  const [row] = await sql<{ health: string; last_error: string; retry: string }[]>`SELECT health, last_error, cursor->>'retryAt' AS retry FROM sources WHERE id = ${id}`;
  assert.equal(row!.health, "failing");
  assert.match(row!.last_error, /身份不符/);
  assert.ok(Date.parse(row!.retry) > Date.now() + 6 * 86400_000);
});

test("a scheduled body budget pause saves the paid listing and resumes only its two remaining bodies", async () => {
  const id = await source(`mp-ei-resume-${T}`, { lastCheckedAt: hoursAgo(48), unavailableCount: 2 });
  const lastOk = new Date(Date.now() - 48 * 3600_000);
  await sql`UPDATE sources SET fail_count = 2, health = 'degraded', last_ok_at = ${lastOk} WHERE id = ${id}`;
  listing = [1, 2, 3].map((n) => ({ url: link(BIZ, 100 + n), title: `待续研究 ${n} ${T}`, posted_at: hoursAgo(n), account_ghid: `gh_${T}` }));
  const before = { listings, bodies: bodies.length, time: Date.now() };
  await allowCalls(2); // One listing and the first body; the second body is stopped before sending.
  try {
    const paused = await checkMpAccount(id, "schedule");
    assert.equal(paused.status, "deferred");
    const row = await account(id);
    assert.ok(Date.parse(row.cursor.lastCheckedAt!) >= before.time);
    assert.equal(row.cursor.pendingSince, row.cursor.lastCheckedAt);
    assert.deepEqual(row.cursor.pending, listing.slice(1).map((p) => ({ url: p.url, title: p.title, postedAt: p.posted_at })));
    assert.ok(Date.parse(row.cursor.retryAt!) > Date.now());
    assert.equal(row.cursor.unavailableCount, undefined, "a successful listing resets account unavailability even when bodies pause");
    assert.equal(row.last_ok_at!.getTime(), lastOk.getTime());
    assert.equal(row.health, "degraded");
    assert.equal(row.fail_count, 2);
    assert.equal(listings, before.listings + 1);
    assert.deepEqual(bodies.slice(before.bodies), [link(BIZ, 101)]);
    const [run] = await sql<{ status: string; error: string; found_count: number; new_count: number }[]>`
      SELECT status, error, found_count, new_count FROM fetch_runs WHERE source_id = ${id} ORDER BY id DESC LIMIT 1`;
    assert.equal(run!.status, "failed");
    assert.match(run!.error, /正文因额度暂停，2 篇待续/);
    assert.equal(run!.found_count, 3);
    assert.equal(run!.new_count, 1);

    await allowCalls(2);
    await sql`UPDATE sources SET cursor = jsonb_set(cursor, '{retryAt}', ${sql.json(hoursAgo(1))}) WHERE id = ${id}`;
    const resumedAt = Date.now();
    const resumed = await checkMpAccount(id, "schedule");
    assert.equal(resumed.status, "ok");
    const done = await account(id);
    assert.equal(listings, before.listings + 1, "resuming must not buy or replay a listing");
    assert.deepEqual(bodies.slice(before.bodies), [101, 102, 103].map((mid) => link(BIZ, mid)));
    assert.equal(done.cursor.pending, undefined);
    assert.equal(done.cursor.pendingSince, undefined);
    assert.equal(done.cursor.retryAt, undefined);
    assert.equal(done.cursor.lastCheckedAt, row.cursor.lastCheckedAt);
    assert.ok(done.last_ok_at!.getTime() >= resumedAt);
    assert.ok(done.last_fetch_at!.getTime() >= resumedAt);
    assert.ok(done.next_fetch_at.getTime() >= resumedAt + 1440 * 60_000);
    assert.equal(done.health, "ok");
    assert.equal(done.fail_count, 0);
    const queued = await sql`SELECT j.id FROM pgboss.job j JOIN articles a ON j.singleton_key = a.id::text
      WHERE j.name = 'content.analyze' AND a.source_id = ${id}`;
    assert.equal(queued.length, 3, "all ingested bodies are queued for processing");
  } finally {
    await sql`UPDATE budgets SET per_day = 10000 WHERE service = 'everyinfra:wechat_oa'`;
  }
});

test("manual body budget pauses still throw and repeated pauses keep the original window and eight-body allowance", async () => {
  const id = await source(`mp-ei-resume-again-${T}`, { lastCheckedAt: hoursAgo(48) }, { dropMarkers: ["招聘"] });
  listing = Array.from({ length: 11 }, (_, i) => ({ url: link(BIZ, 200 + i), title: `${i === 2 ? "招聘" : "研究"} ${i} ${T}`,
    posted_at: hoursAgo(i + 1), account_ghid: `gh_${T}` }));
  const before = { listings, bodies: bodies.length };
  await allowCalls(2);
  try {
    await assert.rejects(checkMpAccount(id, "manual"), BudgetExceededError);
    const first = await account(id);
    const expected = [201, 203, 204, 205, 206, 207, 208].map((mid) => link(BIZ, mid));
    assert.deepEqual(first.cursor.pending?.map((p) => p.url), expected, "filtered titles do not consume the remaining allowance");
    await allowCalls(1);
    await sql`UPDATE sources SET cursor = jsonb_set(cursor, '{retryAt}', ${sql.json(hoursAgo(1))}) WHERE id = ${id}`;
    assert.equal((await checkMpAccount(id, "schedule")).status, "deferred");
    const second = await account(id);
    assert.deepEqual(second.cursor.pending?.map((p) => p.url), expected.slice(1));
    assert.equal(second.cursor.pendingSince, first.cursor.pendingSince);
    assert.equal(second.cursor.lastCheckedAt, first.cursor.lastCheckedAt);
    await allowCalls(6);
    await sql`UPDATE sources SET cursor = jsonb_set(cursor, '{retryAt}', ${sql.json(hoursAgo(1))}) WHERE id = ${id}`;
    assert.equal((await checkMpAccount(id, "schedule")).status, "ok");
    assert.equal(listings, before.listings + 1);
    assert.equal(bodies.length - before.bodies, 8, "resumption does not expand the original check's eight-body limit");
  } finally {
    await sql`UPDATE budgets SET per_day = 10000 WHERE service = 'everyinfra:wechat_oa'`;
  }
});

test("pending older than three days is discarded before applying the normal listing interval", async () => {
  const pending = [{ url: link(BIZ, 301), title: `过期待续 ${T}`, postedAt: hoursAgo(80) }];
  listing = [{ url: link(BIZ, 302), title: `重新列表 ${T}`, posted_at: hoursAgo(1), account_ghid: `gh_${T}` }];
  const before = { listings, bodies: bodies.length };
  const id = await source(`mp-ei-expired-${T}`, { lastCheckedAt: hoursAgo(80), pendingSince: hoursAgo(80), pending, retryAt: hoursAgo(1) });
  assert.equal((await checkMpAccount(id, "schedule")).status, "ok");
  const done = await account(id);
  assert.equal(listings, before.listings + 1);
  assert.deepEqual(bodies.slice(before.bodies), [link(BIZ, 302)]);
  assert.equal(done.cursor.pending, undefined);
  assert.equal(done.cursor.pendingSince, undefined);
  assert.ok(Date.parse(done.cursor.lastCheckedAt!) > Date.now() - 5000);

  const recent = await source(`mp-ei-expired-not-due-${T}`, { lastCheckedAt: hoursAgo(1), pendingSince: hoursAgo(80), pending });
  assert.equal((await checkMpAccount(recent, "schedule")).status, "not-due", "expired work does not force a new listing early");
  assert.equal((await account(recent)).cursor.pending, undefined);
  assert.equal((await account(recent)).cursor.pendingSince, undefined);
  assert.equal(listings, before.listings + 1);
});

test("listing 503s back off per account for 1, 2, 4, 8 then at most 12 hours, and success resets the count", async () => {
  const id = await source(`mp-ei-unavailable-${T}`, { lastCheckedAt: hoursAgo(48) });
  await sql`UPDATE sources SET fail_count = 2, health = 'degraded' WHERE id = ${id}`;
  failListing = true;
  try {
    for (const [i, hours] of [1, 2, 4, 8, 12, 12].entries()) {
      const started = Date.now();
      assert.equal((await checkMpAccount(id, "schedule")).status, "failed");
      const row = await account(id);
      assert.equal(row.cursor.unavailableCount, i + 1);
      const wait = Date.parse(row.cursor.retryAt!) - started;
      assert.ok(wait >= hours * 3600_000 - 3000 && wait <= hours * 3600_000 + 15 * 60_000 + 3000, `wait ${wait}ms for ${hours}h`);
      assert.equal(row.fail_count, 2);
      assert.equal(row.health, "degraded");
      assert.equal((await checkMpAccount(id, "schedule")).status, "not-due");
      await sql`UPDATE sources SET cursor = jsonb_set(cursor, '{retryAt}', ${sql.json(hoursAgo(1))}) WHERE id = ${id}`;
    }
    failListing = false;
    listing = [];
    assert.equal((await checkMpAccount(id, "schedule")).status, "ok");
    const done = await account(id);
    assert.equal(done.cursor.unavailableCount, undefined);
    assert.equal(done.cursor.retryAt, undefined);
    assert.equal(done.fail_count, 0);
    assert.equal(done.health, "ok");
  } finally {
    failListing = false;
  }
});
