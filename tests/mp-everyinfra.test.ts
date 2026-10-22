// Fixed WeChat accounts through EveryInfra against a local stub: only the configured account's own
// recent articles get a paid body, a listing of another account stops the source instead of buying
// anything, and a body that failed for a passing reason is fetched on the next check.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { checkMpAccount, postsToTake } from "@aihot/backend/sources/mp";

const T = tag();
const BIZ = Buffer.from(`own-${T}`).toString("base64");
const OTHER = Buffer.from(`other-${T}`).toString("base64");
const link = (biz: string, mid: number) => `http://mp.weixin.qq.com/s?__biz=${encodeURIComponent(biz)}&mid=${mid}&idx=1&sn=sn${mid}&chksm=c${mid}&scene=126`;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

let listing: Array<Record<string, unknown>> = [];
const bodies: string[] = [];
let failNextBody = false;
const provider = await stub((_hit, req) => {
  const call = JSON.parse(req.body) as { action: string; params: { url?: string } };
  if (call.action === "account_articles") return { id: `l-${T}`, billing: { charged_usd: 0.005556 }, results: listing };
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
