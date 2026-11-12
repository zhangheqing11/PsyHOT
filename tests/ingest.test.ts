// Malformed external batches are rejected before any source or article is written; ordinary
// batches retain their missing-field skips, URL deduplication and isolated-source defaults.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import Fastify from "fastify";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { zhihuSignal } from "@aihot/backend/ingest/zhihu";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { groupArticle } from "@aihot/backend/events/group";
import { settleNonEditorial } from "@aihot/backend/jobs/content";
import { publishArticle } from "@aihot/backend/publication/publish";
import { registerIngest } from "../apps/api/src/routes/ingest.ts";

const T = tag();
const token = "ingest-test-token-0123456789";
const previousToken = process.env.INGEST_TOKEN;
process.env.INGEST_TOKEN = token;
const app = Fastify();
registerIngest(app);
let request = 0;

async function push(body: unknown) {
  request += 1;
  return app.inject({
    method: "POST", url: "/api/ingest/items", remoteAddress: `192.0.2.${request}`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
  if (previousToken === undefined) delete process.env.INGEST_TOKEN;
  else process.env.INGEST_TOKEN = previousToken;
});

const malformed = [null, "not an item", 42, true, []];

test("non-object request bodies return 400", async () => {
  for (const body of malformed) {
    const response = await push(body);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().ok, false);
  }
});

test("non-object items return 400 without creating a source", async (t) => {
  for (const [index, item] of malformed.entries()) {
    await t.test(`item ${JSON.stringify(item)}`, async () => {
      const sourceId = `ingest-invalid-${T}-${index}`;
      const response = await push({ sourceId, items: [item] });
      const sources = await sql`SELECT id FROM sources WHERE id = ${sourceId}`;
      assert.equal(sources.length, 0, "invalid input must not create a source");
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().ok, false);
    });
  }
});

test("a malformed item after a valid one rejects the batch before either is stored", async (t) => {
  for (const [index, item] of malformed.entries()) {
    await t.test(`later item ${JSON.stringify(item)}`, async () => {
      const sourceId = `ingest-mixed-${T}-${index}`;
      const url = `https://example.org/ingest-mixed-${T}-${index}`;
      const response = await push({ sourceId, items: [{ title: "Valid article", url }, item] });
      const sources = await sql`SELECT id FROM sources WHERE id = ${sourceId}`;
      const articles = await sql`SELECT id FROM articles WHERE url = ${url}`;
      assert.equal(sources.length, 0, "validate the whole batch before creating its source");
      assert.equal(articles.length, 0, "a valid earlier item must not be partially ingested");
      assert.equal(response.statusCode, 400, response.body);
    });
  }
});

test("rejecting a malformed batch does not update an existing source", async () => {
  const sourceId = `ingest-existing-${T}`;
  const lastOk = new Date("2020-01-01T00:00:00Z");
  await sql`INSERT INTO sources (id, name, kind, last_ok_at)
            VALUES (${sourceId}, 'Existing ingest source', 'external', ${lastOk})`;
  const response = await push({ sourceId, items: [null] });
  const [source] = await sql`SELECT last_ok_at, last_fetch_at FROM sources WHERE id = ${sourceId}`;
  assert.equal(source!.last_ok_at.toISOString(), lastOk.toISOString());
  assert.equal(source!.last_fetch_at, null);
  assert.equal(response.statusCode, 400, response.body);
});

test("valid batches retain skips, deduplication, backfill and isolated-source defaults", async () => {
  const sourceId = `ingest-valid-${T}`;
  const url = `https://example.org/ingest-valid-${T}`;
  const response = await push({
    sourceId, sourceName: "Test crawler",
    items: [
      {}, { title: "Missing URL" }, { url }, { title: "Invalid URL", url: "not a URL" },
      { title: " First title ", url, author: "Test author", publishedAt: "2020-01-01T00:00:00Z", raw: { _aihot: { backfill: true } } },
      { title: "Duplicate URL", url },
    ],
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true, created: 1 });
  const [source] = await sql`SELECT name, kind, participation_mode FROM sources WHERE id = ${sourceId}`;
  assert.deepEqual({ ...source }, { name: "Test crawler", kind: "external", participation_mode: "isolated" });
  const articles = await sql`SELECT title, author, backfill FROM articles WHERE source_id = ${sourceId}`;
  assert.deepEqual(articles.map((row) => ({ ...row })), [{ title: "First title", author: "Test author", backfill: true }]);
  const repeated = await push({ sourceId, items: [{ title: "First title", url, author: "Test author", publishedAt: "2020-01-01T00:00:00Z", raw: { _aihot: { backfill: true } } }] });
  assert.deepEqual(repeated.json(), { ok: true, created: 0 });
});

test("empty and oversized batches are rejected before creating a source", async () => {
  const sourceId = `ingest-size-${T}`;
  for (const [items, status] of [[[], 400], [Array.from({ length: 51 }, () => ({})), 413]] as const) {
    const response = await push({ sourceId, items });
    assert.equal(response.statusCode, status, response.body);
  }
  assert.equal((await sql`SELECT id FROM sources WHERE id = ${sourceId}`).length, 0);
});

test("external bodies reach analysis input and only changed text makes a new revision", async () => {
  const sourceId = `ingest-body-${T}`;
  const item = { title: "讨论论文", url: `https://www.zhihu.com/question/123/answer/${Date.now()}`, bodyText: "正文 https://doi.org/10.1038/example", excerpt: "简介", language: "zh" };
  assert.equal((await push({ sourceId, items: [item] })).json().created, 1);
  const [first] = await sql`SELECT id, body_text, body_status, excerpt, language, revision FROM articles WHERE source_id = ${sourceId}`;
  assert.deepEqual([first.body_text, first.body_status, first.excerpt, first.language, first.revision], [item.bodyText, "ok", "简介", "zh", 1]);
  await push({ sourceId, items: [{ ...item, raw: { likes: 99 } }] });
  assert.equal((await sql`SELECT revision FROM articles WHERE id = ${first.id}`)[0].revision, 1, "engagement changes do not reprocess text");
  await push({ sourceId, items: [{ ...item, bodyText: `${item.bodyText}\n新增论据` }] });
  const [revised] = await sql`SELECT body_text, revision FROM articles WHERE id = ${first.id}`;
  assert.deepEqual([revised.body_text, revised.revision], [`${item.bodyText}\n新增论据`, 2]);
});

test("invalid optional body fields reject the whole batch before writing anything", async () => {
  for (const [index, invalid] of [{ bodyText: {} }, { bodyText: "x".repeat(200_001) }, { excerpt: 7 }, { language: ["zh"] }].entries()) {
    const sourceId = `ingest-body-invalid-${T}-${index}`;
    const response = await push({ sourceId, items: [{ title: "Valid", url: `https://example.org/body-${T}-${index}` }, { title: "Invalid", url: `https://example.org/bad-${T}-${index}`, ...invalid }] });
    assert.equal(response.statusCode, 400);
    assert.equal((await sql`SELECT 1 FROM sources WHERE id = ${sourceId}`).length, 0);
  }
});

test("a known discussion source queues supplied text for grouping instead of extraction or scoring", async () => {
  const sourceId = `ingest-signal-${T}`;
  await sql`INSERT INTO sources (id, name, kind, participation_mode) VALUES (${sourceId}, 'Zhihu discussion', 'external', 'hot_signal')`;
  const response = await push({ sourceId, items: [{ title: "论文讨论", url: `https://zhuanlan.zhihu.com/p/${Date.now()}`, bodyText: "讨论 https://doi.org/10.1038/example", publishedAt: new Date().toISOString() }] });
  assert.equal(response.json().created, 1);
  const [article] = await sql`SELECT id FROM articles WHERE source_id = ${sourceId}`;
  const [job] = await sql`SELECT name, data FROM pgboss.job WHERE singleton_key = ${article.id} ORDER BY created_on DESC LIMIT 1`;
  assert.deepEqual([job.name, job.data.signalOnly], ["events.group", true]);
});

test("a Zhihu import and a Bluesky discussion add equal heat evidence to the same paper without paid calls", async () => {
  const editorial = `ingest-paper-${T}`;
  const bsky = `ingest-bsky-${T}`;
  const paperUrl = `https://www.nature.com/articles/s41562-026-${T}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode) VALUES
    (${editorial}, 'Test paper', 'rss', 'T1', 'editorial'), (${bsky}, 'Test Bluesky', 'json_list', 'T2', 'hot_signal')`;
  const paper = await upsertMaterial({ sourceId: editorial, url: paperUrl, title: `研究 ${T}`, bodyText: "Abstract.", via: "fetch", publishedAt: new Date() });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
    VALUES (${paper.articleId}, 1, 'rule', 'pass', 'research', ${`研究 ${T}`}, '摘要', 80, false, ${sql.json({ fact: { title: `研究 ${T}` } })})`;
  // Seed the already-published research this integration is meant to attach to; founding research
  // stories is covered by events.test.ts and must not call a model in this import-only test.
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, origin, first_report_at, latest_at)
    VALUES (${randomUUID()}, ${`研究 ${T}`}, 'manual', now(), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title, manual) VALUES (${randomUUID()}, ${story.id}, ${`研究 ${T}`}, true) RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role, manual) VALUES (${fact.id}, ${paper.articleId}, 'primary', true)`;
  await publishArticle(paper.articleId);
  const contentId = String(Date.now());
  const creatorHash = createHash("sha256").update(T).digest("hex").slice(0, 16);
  const converted = zhihuSignal({ content_id: contentId, content_type: "article", content_url: `https://zhuanlan.zhihu.com/p/${contentId}`, content_text: "对这项研究的讨论", content_links: [paperUrl], created_time: Math.floor(Date.now() / 1000), creator_hash: creatorHash });
  assert.ok(converted);
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode) VALUES (${converted.sourceId}, 'Test Zhihu', 'external', 'T2', 'hot_signal')`;
  const [before] = await sql`SELECT count(*)::int AS n FROM receipts`;
  assert.equal((await push({ sourceId: converted.sourceId, items: [converted.item] })).json().created, 1);
  const [zhihu] = await sql`SELECT id FROM articles WHERE source_id = ${converted.sourceId}`;
  await settleNonEditorial(zhihu.id);
  const joined = await groupArticle(zhihu.id, { signalOnly: true });
  assert.deepEqual([joined.verdict, joined.storyId], ["signal-link", story.id]);
  const bluesky = await upsertMaterial({ sourceId: bsky, url: `https://bsky.app/profile/test.bsky.social/post/${T}`, title: "讨论论文", bodyText: `讨论 ${paperUrl}`, via: "fetch", publishedAt: new Date() });
  await settleNonEditorial(bluesky.articleId);
  assert.equal((await groupArticle(bluesky.articleId, { signalOnly: true })).storyId, story.id);
  const signals = await sql`SELECT kind, participant_key FROM story_signals WHERE story_id = ${story.id} AND source_id IN (${converted.sourceId}, ${bsky})`;
  assert.equal(signals.length, 2);
  assert.deepEqual(signals.map((s) => s.kind), ["signal", "signal"]);
  assert.equal(new Set(signals.map((s) => s.participant_key)).size, 2);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0].n, before.n, "direct links bypass models");
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id = ${zhihu.id}`).length, 0, "discussion is not scored");
  assert.equal((await sql`SELECT eligible FROM publications WHERE article_id = ${zhihu.id}`)[0].eligible, false, "discussion is not a standalone publication");
});


test("paused sources reject pushes without recording success, then accept after resuming", async () => {
  const sourceId = `ingest-paused-${T}`;
  const lastOk = new Date("2020-01-01T00:00:00Z");
  await sql`INSERT INTO sources (id, name, kind, enabled, health, last_ok_at)
            VALUES (${sourceId}, 'Paused source', 'external', false, 'paused', ${lastOk})`;
  const body = { sourceId, items: [{ title: "Report", url: `https://example.org/${sourceId}` }] };
  const paused = await push(body);
  assert.equal(paused.statusCode, 409, paused.body);
  const [source] = await sql`SELECT last_ok_at FROM sources WHERE id = ${sourceId}`;
  assert.equal(source!.last_ok_at.toISOString(), lastOk.toISOString());
  assert.equal((await sql`SELECT id FROM articles WHERE source_id = ${sourceId}`).length, 0);
  await sql`UPDATE sources SET enabled = true WHERE id = ${sourceId}`;
  const resumed = await push(body);
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.deepEqual(resumed.json(), { ok: true, created: 1 });
});
