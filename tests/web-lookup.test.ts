// Lookup eligibility uses stored receipts and signals; all searches go to a local stub.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { hotCandidates } from "@aihot/backend/events/hot";
import * as lookup from "@aihot/backend/events/web-lookup";
import { stopBoss } from "@aihot/backend/jobs/queue";

const SOURCE = `test-lookup-${tag()}`;
// Keep older fixtures in a reused test database outside this candidate window.
const now = new Date(Date.now() + 30 * 86400_000);
const firstAt = new Date(now.getTime() - 13 * 3600_000);
const bucket = String(Math.floor(Date.now() / (12 * 3600_000)));
const searches: string[] = [];
const storyIds: number[] = [];
const articleIds: string[] = [];
let saved: Array<{ service: string; per_minute: number; per_hour: number; per_day: number }> = [];
const provider = await stub((_hit, req) => {
  assert.equal(req.url, "/v1/tools/search");
  searches.push((JSON.parse(req.body) as { query: string }).query);
  return { results: [] };
});
process.env.DEEPSEEK_TOOLS_BASE_URL = provider.url;
process.env.DEEPSEEK_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind) VALUES (${SOURCE}, ${SOURCE}, 'rss')`;
  saved = await sql`SELECT service, per_minute, per_hour, per_day FROM budgets WHERE service LIKE 'deepseek-tools%'`;
  await sql`UPDATE budgets SET per_minute = 10000, per_hour = 10000, per_day = 10000 WHERE service LIKE 'deepseek-tools%'`;
});
afterEach(async () => {
  if (storyIds.length) await sql`DELETE FROM receipts WHERE subject IN ${sql(storyIds.map((id) => `story:${id}`))}`;
  if (articleIds.length) await sql`DELETE FROM articles WHERE id IN ${sql(articleIds)}`;
  if (storyIds.length) await sql`DELETE FROM stories WHERE id IN ${sql(storyIds)}`;
  storyIds.length = 0;
  articleIds.length = 0;
  searches.length = 0;
});
after(async () => {
  for (const b of saved) await sql`UPDATE budgets SET per_minute = ${b.per_minute}, per_hour = ${b.per_hour}, per_day = ${b.per_day} WHERE service = ${b.service}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await provider.close();
  await stopBoss();
  await closeDb();
});

async function material(title: string) {
  const url = `https://example.com/lookup/${tag()}`;
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, title, url, bodyStatus: "none", via: "fetch" });
  articleIds.push(articleId);
  return { articleId, url };
}

async function story(name: string, score = 90) {
  const title = `Lookup ${name} ${tag()}`;
  const [st] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at)
    VALUES (${randomUUID()}, ${title}, ${firstAt}, ${now}) RETURNING id`;
  const id = st!.id;
  storyIds.push(id);
  const { articleId, url } = await material(title);
  await sql`INSERT INTO publications (article_id, title, source_id, channel, url, story_id, score, eligible, published_at, discovered_at, timeline_at, sort_at)
    VALUES (${articleId}, ${title}, ${SOURCE}, 'news', ${url}, ${id}, ${score}, true, ${now}, ${now}, ${now}, ${now})`;
  await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
    VALUES (${id}, ${articleId}, ${`${SOURCE}:${articleId}`}, ${SOURCE}, 'editorial', ${new Date(firstAt.getTime() - 3600_000)})`;
  return { id, title };
}

async function signal(id: number, sourceId: string, at: Date) {
  const { articleId } = await material("Coverage evidence");
  await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
    VALUES (${id}, ${articleId}, ${`${sourceId}:${articleId}`}, ${sourceId}, 'signal', ${at})`;
}

async function receipt(id: number, window = String(Number(bucket) - 1), at = firstAt) {
  await sql`INSERT INTO receipts (logical_key, service, purpose, subject, status, request, created_at)
    VALUES (${tag()}, 'deepseek-tools', 'web_story_lookup', ${`story:${id}`}, 'completed', ${sql.json({ bucket: window })}, ${at})`;
}

test("only productive or newly joined stories get a second lookup, including hot-only candidates", async () => {
  const fresh = await story("fresh");
  const quiet = await story("quiet");
  const covered = await story("covered");
  const joined = await story("joined");
  const equal = await story("equal-time");
  const hotQuiet = await story("hot-quiet", 40);
  const hotJoined = await story("hot-joined", 40);
  const hotCovered = await story("hot-covered", 40);
  const capped = await story("capped");
  const thisBucket = await story("this-bucket");
  for (const st of [quiet, covered, joined, equal, hotQuiet, hotJoined, hotCovered, capped]) await receipt(st.id);
  // Two title queries in the first bucket are one lookup. The earliest receipt is the boundary.
  await receipt(joined.id, String(Number(bucket) - 1), new Date(firstAt.getTime() + 3600_000));
  await receipt(capped.id, String(Number(bucket) - 2));
  await receipt(thisBucket.id, bucket);
  for (const st of [covered, hotCovered, capped, thisBucket]) await signal(st.id, lookup.WEB_LOOKUP_SOURCE, firstAt);
  await signal(joined.id, SOURCE, new Date(firstAt.getTime() + 1));
  await signal(equal.id, SOURCE, firstAt);
  await signal(hotQuiet.id, SOURCE, new Date(firstAt.getTime() - 1));
  await signal(hotJoined.id, SOURCE, new Date(firstAt.getTime() + 1));
  const hot = (await hotCandidates(now)).map((r) => Number(r.story_id));
  for (const st of [hotQuiet, hotJoined, hotCovered]) assert.ok(hot.includes(st.id), `${st.title} must exercise the hot path`);

  await lookup.lookupStoryCoverage(now);
  assert.deepEqual([...searches].sort(), [fresh, covered, joined, hotJoined, hotCovered].map((st) => st.title).sort());
});

test("quiet second lookups do not take the recent list's thirty places from a fresh story", async () => {
  for (let i = 0; i < 30; i++) {
    const st = await story(`quiet-${i}`, 100);
    await receipt(st.id);
  }
  const fresh = await story("fresh-after-quiet", 99);
  await lookup.lookupStoryCoverage(now);
  assert.deepEqual([...searches], [fresh.title]);
});

test("quiet second lookups do not take the hot list's thirty places from an eligible story", async () => {
  for (let i = 0; i < 30; i++) {
    const st = await story(`quiet-hot-${i}`, 40);
    await receipt(st.id);
    await signal(st.id, SOURCE, new Date(firstAt.getTime() - 1));
  }
  const fresh = await story("fresh-hot-after-quiet", 40);
  await signal(fresh.id, SOURCE, firstAt);
  await sql`UPDATE story_signals SET observed_at = ${new Date(now.getTime() - 3 * 86400_000)} WHERE story_id = ${fresh.id}`;
  const hot = (await hotCandidates(now)).map((r) => Number(r.story_id));
  assert.ok(hot.indexOf(fresh.id) >= 30, "the eligible hot-only story ranks after thirty quiet ones");
  await lookup.lookupStoryCoverage(now);
  assert.deepEqual([...searches], [fresh.title]);
});

test("Chinese lookup queries drop a column and subtitle, leaving the event title intact", () => {
  assert.equal(lookup.lookupQuery("bioRxiv 方法学解读｜多重分析路径（multiverse）：当结果取决于一连串分析决定，怎样看出每个决定的分量"), "多重分析路径（multiverse）");
  assert.equal(lookup.lookupQuery("HHS更新阿尔茨海默病国家计划"), "HHS更新阿尔茨海默病国家计划");
  const english = "[Research] A very long English headline | Methods: a subtitle that must stay unchanged";
  assert.equal(lookup.lookupQuery(english), english);
  assert.equal(lookup.lookupQuery("【重磅】中国心理学会发布…"), "中国心理学会发布…");
  assert.equal(lookup.lookupQuery("[重磅] 中国心理学会发布…"), "中国心理学会发布…");
  assert.equal(lookup.lookupQuery("一二三四五六七八九十一二三｜中国心理学会发布报告"), "一二三四五六七八九十一二三｜中国心理学会发布报告");
  assert.equal(lookup.lookupQuery("一二三四五六七八九十一二|中国心理学会发布报告"), "中国心理学会发布报告");
  assert.equal(lookup.lookupQuery("中国心理学会:发布报告"), "中国心理学会");
  assert.equal(lookup.lookupQuery("新研究：中国心理学会发布报告"), "新研究：中国心理学会发布报告");
  assert.equal(lookup.lookupQuery(`  ${"汉".repeat(41)}  `), "汉".repeat(40));
  assert.equal(lookup.lookupQuery("【重磅】短讯"), "【重磅】短讯");
});
