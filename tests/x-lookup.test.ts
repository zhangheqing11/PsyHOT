// X lookup of hot stories: selection, buckets, receipts and what is kept. All searches go to a local stub.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { hotCandidates } from "@aihot/backend/events/hot";
import * as lookup from "@aihot/backend/events/x-lookup";
import { lookupQuery } from "@aihot/backend/events/x-story-query";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { logicalKeyFor } from "@aihot/backend/providers/receipts";

const T = tag();
const LETTERS = T.replace(/\d/g, (d) => "abcdefghij"[Number(d)]!);
const SOURCE = `test-xlookup-${T}`;
const OTHER = `test-xlookup-other-${T}`;
// Keep older fixtures in a reused test database outside this candidate window.
const now = new Date(Date.now() + 30 * 86400_000);
const firstAt = new Date(now.getTime() - 13 * 3600_000);
const bucketOf = (at: Date) => String(Math.floor(at.getTime() / (12 * 3600_000)));
const requests: string[] = [];
const answers = new Map<string, unknown[]>();
const refuse: string[] = [];
const storyIds: number[] = [];
const articleIds: string[] = [];
let counter = 0;
let tweet = BigInt(Date.now()) * 1000n;
let saved: Array<{ service: string; per_minute: number; per_hour: number; per_day: number }> = [];
const provider = await stub((hit, req) => {
  const { platform, action, params } = JSON.parse(req.body) as { platform: string; action: string; params: { keyword: string } };
  assert.equal(`${platform}/${action}`, "twitter/search");
  requests.push(params.keyword);
  if (refuse.some((title) => params.keyword.toLowerCase().includes(title.toLowerCase()))) return new Reply(503, { error: "busy" });
  const found = [...answers].find(([title]) => params.keyword.toLowerCase().includes(title.toLowerCase()));
  return { id: `xl-${T}-${hit}`, billing: { charged_usd: 0.000556 }, results: found?.[1] ?? [] };
});
process.env.EVERYINFRA_BASE_URL = provider.url;
process.env.EVERYINFRA_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind) VALUES (${SOURCE}, ${SOURCE}, 'rss'), (${OTHER}, ${OTHER}, 'rss')`;
  saved = await sql`SELECT service, per_minute, per_hour, per_day FROM budgets WHERE service IN ('everyinfra', 'everyinfra:twitter')`;
  await sql`UPDATE budgets SET per_minute = 10000, per_hour = 10000, per_day = 10000 WHERE service IN ('everyinfra', 'everyinfra:twitter')`;
});
afterEach(async () => {
  if (storyIds.length) {
    await sql`DELETE FROM receipts WHERE subject IN ${sql(storyIds.map((id) => `story:${id}`))}`;
    await sql`DELETE FROM articles WHERE source_id = ${lookup.X_LOOKUP_SOURCE} AND (raw->'lookup'->>'storyId')::bigint IN ${sql(storyIds)}`;
  }
  if (articleIds.length) await sql`DELETE FROM articles WHERE id IN ${sql(articleIds)}`;
  if (storyIds.length) {
    await sql`DELETE FROM facts WHERE story_id IN ${sql(storyIds)}`;
    await sql`DELETE FROM stories WHERE id IN ${sql(storyIds)}`;
  }
  storyIds.length = 0;
  articleIds.length = 0;
  requests.length = 0;
  answers.clear();
  refuse.length = 0;
});
after(async () => {
  for (const b of saved) await sql`UPDATE budgets SET per_minute = ${b.per_minute}, per_hour = ${b.per_hour}, per_day = ${b.per_day} WHERE service = ${b.service}`;
  await sql`DELETE FROM sources WHERE id IN (${SOURCE}, ${OTHER})`;
  await provider.close();
  await stopBoss();
  await closeDb();
});

async function material(sourceId: string, title: string) {
  const url = `https://example.com/xlookup/${tag()}`;
  const { articleId } = await upsertMaterial({ sourceId, title, url, bodyStatus: "none", via: "fetch" });
  articleIds.push(articleId);
  return { articleId, url };
}

/** A story reported by SOURCE; an English title gives it a phrase to search, a Chinese one does not. */
async function story(name: string, opts: { score?: number; english?: boolean } = {}) {
  const title = opts.english === false ? `睡眠如何改变青少年的情绪记忆 ${name}` : `Adolescent sleep reshapes emotional memory processing circuits ${LETTERS}${"abcdefghij"[counter++]}${name.replace(/[^a-z]/g, "")}`;
  const [st] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at)
    VALUES (${randomUUID()}, ${title}, ${firstAt}, ${now}) RETURNING id`;
  const id = st!.id;
  storyIds.push(id);
  const { articleId, url } = await material(SOURCE, title);
  await sql`INSERT INTO publications (article_id, title, source_id, channel, url, story_id, score, eligible, published_at, discovered_at, timeline_at, sort_at)
    VALUES (${articleId}, ${title}, ${SOURCE}, 'news', ${url}, ${id}, ${opts.score ?? 90}, true, ${now}, ${now}, ${now}, ${now})`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`xl-${tag()}`}, ${id}, ${title}) RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id) VALUES (${fact!.id}, ${articleId})`;
  await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
    VALUES (${id}, ${articleId}, ${`${SOURCE}:${articleId}`}, ${SOURCE}, 'editorial', ${new Date(firstAt.getTime() - 3600_000)})`;
  return { id, title };
}

async function signal(id: number, sourceId: string, at: Date) {
  const { articleId } = await material(sourceId, "Another report");
  await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
    VALUES (${id}, ${articleId}, ${`${sourceId}:${articleId}`}, ${sourceId}, 'signal', ${at})`;
}

/** A tweet in the shape EveryInfra answers with. */
function post(handle: string, text: string, likes = 1) {
  tweet += 1n;
  return { id: String(tweet), url: `https://x.com/${handle}/status/${tweet}`, text, posted_at: new Date(now.getTime() - 3600_000).toISOString(), like_count: likes, retweet_count: 0, reply_count: 0 };
}

const keywordOf = (title: string) => lookupQuery([{ id: "a", url: "https://example.com/", title, body: null }], now)!.keyword;
const kept = (id: number) => sql<{ participant_key: string; source_id: string; kind: string; observed_at: Date; article_id: string }[]>`
  SELECT participant_key, source_id, kind, observed_at, article_id FROM story_signals WHERE story_id = ${id} AND source_id = ${lookup.X_LOOKUP_SOURCE} ORDER BY participant_key, article_id`;

test("only stories with a phrase are searched, one request each, through the Twitter share with the long timeout", async () => {
  const english = await story("english", { score: 80 });
  const chinese = await story("chinese", { score: 99, english: false });
  const out = await lookup.lookupStoryX(now);
  assert.deepEqual(requests, [keywordOf(english.title)]);
  assert.ok(requests[0]!.startsWith(`"${english.title}"`) && requests[0]!.endsWith(" -filter:replies"));
  assert.deepEqual({ stories: out.stories, looked: out.looked, searches: out.searches }, { stories: 1, looked: 1, searches: 1 });
  const [receipt] = await sql<{ id: number; purpose: string; status: string; request: { bucket: string; params: { keyword: string } } }[]>`
    SELECT id, purpose, status, request FROM receipts WHERE service = 'everyinfra' AND subject = ${`story:${english.id}`}`;
  assert.equal(receipt!.purpose, "x_story_lookup");
  assert.equal(receipt!.status, "completed");
  assert.equal(receipt!.request.bucket, bucketOf(now));
  assert.equal(receipt!.request.params.keyword, requests[0]);
  const attempts = await sql`SELECT pool FROM receipt_attempts WHERE receipt_id = ${receipt!.id}`;
  assert.deepEqual(attempts.map((a) => a.pool), ["everyinfra:twitter"]);
  assert.equal((await sql`SELECT 1 FROM receipts WHERE subject = ${`story:${chinese.id}`}`).length, 0);
  assert.equal(lookup.TIMEOUT_MS, 150_000);
});

test("posts holding the whole phrase become signals, five at most, one participant per account", async () => {
  const st = await story("matching");
  const text = `Worth reading: ${st.title}.`;
  answers.set(st.title, [
    post("alice", text, 10), post("bob", text, 9), post("carol", text, 8), post("carol", `${text} again`, 7), post("dave", text, 6), post("erin", text, 5),
    post("frank", "A different paper about sleep"), post("grace", "Adolescent sleep reshapes emotional memory"),
  ]);
  const out = await lookup.lookupStoryX(now);
  assert.deepEqual({ looked: out.looked, matched: out.matched, kept: out.kept }, { looked: 1, matched: 5, kept: 5 });
  const signals = await kept(st.id);
  assert.equal(signals.length, 5);
  assert.deepEqual([...new Set(signals.map((s) => s.participant_key))].sort(), ["x-author:alice", "x-author:bob", "x-author:carol", "x-author:dave"]);
  assert.ok(signals.every((s) => s.kind === "signal" && s.observed_at >= firstAt && s.observed_at <= now));
  const [article] = await sql<{ processing_state: string; body_status: string; raw: { participant: string; lookup: { storyId: number; query: string } } }[]>`
    SELECT processing_state, body_status, raw FROM articles WHERE id = ${signals[0]!.article_id}`;
  assert.equal(article!.processing_state, "skipped");
  assert.equal(article!.body_status, "none");
  assert.equal(article!.raw.participant, "x-author:alice");
  assert.deepEqual(article!.raw.lookup, { storyId: st.id, query: requests[0] });
  assert.equal((await sql`SELECT 1 FROM publications WHERE article_id = ${signals[0]!.article_id} AND NOT selected AND NOT eligible`).length, 1);
});

test("a story is searched once per twelve-hour bucket, again only if productive or joined, and twice at most", async () => {
  const productive = await story("productive");
  const quiet = await story("quiet");
  answers.set(productive.title, [post("alice", productive.title)]);
  const first = await lookup.lookupStoryX(now);
  assert.equal(first.searches, 2);
  assert.equal((await kept(quiet.id)).length, 0);
  assert.equal(requests.length, 2);
  // The test clock runs ahead of the database's: place the receipts at the lookup's own time.
  await sql`UPDATE receipts SET created_at = ${now} WHERE subject IN ${sql([productive, quiet].map((st) => `story:${st.id}`))}`;

  const again = await lookup.lookupStoryX(now);
  assert.deepEqual({ searches: again.searches, looked: again.looked }, { searches: 0, looked: 0 });
  assert.equal(requests.length, 2, "the same bucket sends nothing");

  // Next bucket: the story that got a post is searched again, the quiet one is not.
  const later = new Date(now.getTime() + 12 * 3600_000);
  assert.equal((await lookup.lookupStoryX(later)).searches, 1);
  assert.deepEqual(requests.slice(2), [keywordOf(productive.title).replace(/since:\S+/, `since:${new Date(later.getTime() - 7 * 86400_000).toISOString().slice(0, 10)}`)]);
  assert.equal(requests.length, 3);

  // A participant that joined after the first lookup earns the quiet story its second one.
  await signal(quiet.id, SOURCE, new Date(later.getTime() - 3600_000));
  assert.equal((await lookup.lookupStoryX(new Date(later.getTime() + 12 * 3600_000))).searches, 1);
  assert.equal(requests.length, 4);

  // Two lookups made: neither is searched again.
  const last = await lookup.lookupStoryX(new Date(later.getTime() + 24 * 3600_000));
  assert.deepEqual({ looked: last.looked, searches: last.searches }, { looked: 0, searches: 0 });
  assert.equal(requests.length, 4);
});

test("a run searches three stories at most, the hottest with a phrase", async () => {
  await story("no-phrase", { score: 99, english: false });
  const stories = [];
  for (const [i, score] of [95, 94, 93, 92, 91].entries()) stories.push(await story(`ranked${"abcde"[i]}`, { score }));
  const out = await lookup.lookupStoryX(now);
  assert.deepEqual({ stories: out.stories, looked: out.looked, searches: out.searches }, { stories: 5, looked: 3, searches: 3 });
  assert.deepEqual(requests, stories.slice(0, 3).map((st) => keywordOf(st.title)));
});

test("a run ends quietly when the budget is spent", async () => {
  const stories = [await story("budget-a", { score: 95 }), await story("budget-b", { score: 94 }), await story("budget-c", { score: 93 })];
  const [used] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts WHERE pool = 'everyinfra:twitter' AND origin = 'live' AND started_at > now() - interval '1 day'`;
  await sql`UPDATE budgets SET per_day = ${used!.n + 1} WHERE service = 'everyinfra:twitter'`;
  try {
    const out = await lookup.lookupStoryX(now);
    assert.deepEqual({ looked: out.looked, searches: out.searches }, { looked: 1, searches: 1 });
    assert.deepEqual(requests, [keywordOf(stories[0]!.title)]);
    assert.equal((await sql`SELECT 1 FROM receipts WHERE subject = ${`story:${stories[1]!.id}`}`).length, 0);
  } finally {
    await sql`UPDATE budgets SET per_day = 10000 WHERE service = 'everyinfra:twitter'`;
  }
});

test("an unknown or in-flight request is skipped without a resend and the run goes on", async () => {
  const unknown = await story("unknown", { score: 95 });
  const busy = await story("busy", { score: 94 });
  const next = await story("next", { score: 93 });
  const third = await story("third", { score: 92 });
  for (const [st, status] of [[unknown, "unknown"], [busy, "pending"]] as const) {
    const logicalKey = logicalKeyFor({ service: "everyinfra", purpose: "x_story_lookup",
      identity: { platform: "twitter", action: "search", params: { keyword: keywordOf(st.title) }, window: bucketOf(now) } });
    await sql`INSERT INTO receipts (logical_key, service, purpose, subject, status, request, attempts)
      VALUES (${logicalKey}, 'everyinfra', 'x_story_lookup', ${`story:${st.id}`}, ${status}, '{}'::jsonb, 1)`;
  }
  const out = await lookup.lookupStoryX(now);
  assert.deepEqual({ looked: out.looked, searches: out.searches }, { looked: 2, searches: 2 });
  assert.equal(out.failed, 2);
  assert.deepEqual(requests, [keywordOf(next.title), keywordOf(third.title)]);
  const states = await sql`SELECT subject, status, attempts FROM receipts WHERE subject IN ${sql([unknown, busy].map((st) => `story:${st.id}`))} ORDER BY subject`;
  assert.deepEqual(states.map((r) => [r.status, r.attempts]).sort(), [["pending", 1], ["unknown", 1]]);
});

test("a tweet another source already collected is neither stored again nor attached", async () => {
  const st = await story("collected");
  const text = `Discussing ${st.title}`;
  const known = post("alice", text, 9);
  const { articleId } = await upsertMaterial({ sourceId: OTHER, title: text, url: known.url, identityKey: `x:${known.id}`, bodyStatus: "none", via: "fetch" });
  articleIds.push(articleId);
  answers.set(st.title, [known, post("bob", text, 1)]);
  const out = await lookup.lookupStoryX(now);
  assert.deepEqual({ matched: out.matched, kept: out.kept }, { matched: 2, kept: 1 });
  const rows = await sql<{ id: string; source_id: string }[]>`SELECT id, source_id FROM articles WHERE identity_key = ${`x:${known.id}`}`;
  assert.deepEqual(rows.map((r) => [r.id, r.source_id]), [[articleId, OTHER]]);
  assert.deepEqual((await kept(st.id)).map((s) => s.participant_key), ["x-author:bob"]);
  assert.equal((await sql`SELECT 1 FROM story_signals WHERE story_id = ${st.id} AND article_id = ${articleId}`).length, 0);
});

test("kept posts raise the story's participants in the hot ranking", async () => {
  const st = await story("heat");
  await signal(st.id, OTHER, new Date(firstAt.getTime() + 3600_000));
  const row = async () => (await hotCandidates(now)).find((r) => Number(r.story_id) === st.id)!;
  const before = await row();
  answers.set(st.title, [post("alice", st.title, 3), post("bob", st.title, 2), post("alice", `${st.title} too`, 1)]);
  await lookup.lookupStoryX(now);
  const after = await row();
  assert.equal(Number(after.participants), Number(before.participants) + 2);
  assert.equal(Number(after.signal_participants), Number(before.signal_participants) + 2);
  assert.ok(Number(after.heat) > Number(before.heat));
});

test("X_STORY_LOOKUP_ENABLED=false sends nothing", async () => {
  await story("disabled");
  process.env.X_STORY_LOOKUP_ENABLED = "false";
  try {
    const out = await lookup.lookupStoryX(now);
    assert.equal(out.skipped, "X_STORY_LOOKUP_ENABLED=false");
    assert.equal(requests.length, 0);
  } finally {
    delete process.env.X_STORY_LOOKUP_ENABLED;
  }
});

test("a refused request is skipped and the run goes on", async () => {
  const refused = await story("refused", { score: 95 });
  const next = await story("after-refusal", { score: 94 });
  refuse.push(refused.title);
  const out = await lookup.lookupStoryX(now);
  assert.deepEqual({ looked: out.looked, searches: out.searches, failed: out.failed }, { looked: 1, searches: 1, failed: 1 });
  assert.deepEqual(requests, [keywordOf(refused.title), keywordOf(next.title)]);
  const rows = await sql`SELECT subject, status FROM receipts WHERE subject IN ${sql([refused, next].map((st) => `story:${st.id}`))}`;
  assert.deepEqual(rows.map((r) => [r.subject, r.status]).sort(), [[`story:${refused.id}`, "failed"], [`story:${next.id}`, "completed"]].sort());
});

test("refused requests count toward the three a run sends", async () => {
  const stories = [];
  for (const [i, score] of [95, 94, 93, 92].entries()) stories.push(await story(`refusedall${"abcd"[i]}`, { score }));
  refuse.push(...stories.map((st) => st.title));
  const out = await lookup.lookupStoryX(now);
  assert.deepEqual({ looked: out.looked, failed: out.failed }, { looked: 0, failed: 3 });
  assert.deepEqual(requests, stories.slice(0, 3).map((st) => keywordOf(st.title)));
});

test("a dropped connection leaves an unknown receipt, is not resent, and the run goes on", async () => {
  const dropped = await story("dropped", { score: 95 });
  const next = await story("after-drop", { score: 94 });
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const keyword = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { params: { keyword: string } }).params.keyword;
      seen.push(keyword);
      if (keyword.includes(dropped.title)) return req.socket.destroy();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const original = process.env.EVERYINFRA_BASE_URL;
  process.env.EVERYINFRA_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const out = await lookup.lookupStoryX(now);
    assert.deepEqual({ looked: out.looked, failed: out.failed }, { looked: 1, failed: 1 });
    assert.deepEqual(seen, [keywordOf(dropped.title), keywordOf(next.title)]);
    const rows = await sql`SELECT subject, status FROM receipts WHERE subject IN ${sql([dropped, next].map((st) => `story:${st.id}`))}`;
    assert.deepEqual(rows.map((r) => [r.subject, r.status]).sort(), [[`story:${dropped.id}`, "unknown"], [`story:${next.id}`, "completed"]].sort());
    await lookup.lookupStoryX(now);
    assert.equal(seen.length, 2, "the unknown request is not sent again");
  } finally {
    process.env.EVERYINFRA_BASE_URL = original;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
