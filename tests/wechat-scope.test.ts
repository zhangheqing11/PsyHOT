// The local公众号 page must scope the existing public pool to fixed mp_account sources.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { buildApp } from "../apps/api/src/app.ts";
import { tag } from "./setup.ts";

const T = tag();
const WECHAT = `test-wechat-${T}`;
const RSS = `test-wechat-rss-${T}`;
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, config, next_fetch_at, interval_minutes)
            VALUES
              (${WECHAT}, 'Test 公众号', 'mp_account', 'T1', 'editorial', ${sql.json({ ghid: 'gh_test', wechatBiz: 'biz_test' })}, '2100-01-01', 720),
              (${RSS}, 'Test RSS', 'rss', 'T1', 'editorial', ${sql.json({})}, '2100-01-01', 30)`;
});

after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

async function article(sourceId: string, slug: string) {
  const { articleId } = await upsertMaterial({
    sourceId,
    url: `https://example.com/${slug}-${T}`,
    title: `测试文章 ${slug}`,
    bodyText: `正文 ${slug} ${T}`,
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, title_zh, summary_zh, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', ${`公众号标题 ${slug}`}, ${`公众号摘要 ${slug}`}, false)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return articleId;
}

async function get(url: string) {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: JSON.parse(res.body) as { items?: Array<{ id: string }> } };
}

test("source=wechat returns all public mp_account articles and excludes other sources", async () => {
  const wechat = await article(WECHAT, "wechat");
  const rss = await article(RSS, "rss");

  const result = await get("/api/site/pool?source=wechat");
  assert.equal(result.status, 200);
  const ids = result.body.items?.map((item) => item.id) ?? [];
  assert.ok(ids.includes(wechat));
  assert.ok(!ids.includes(rss));
  const kinds = await sql<{ kind: string }[]>`
    SELECT s.kind FROM publications p JOIN sources s ON s.id = p.source_id WHERE p.article_id IN ${sql(ids)}`;
  assert.ok(kinds.length > 0 && kinds.every((row) => row.kind === "mp_account"));
});

test("source=wechat rejects an unknown source scope", async () => {
  const result = await app.inject({ method: "GET", url: "/api/site/pool?source=not-a-scope" });
  assert.equal(result.statusCode, 400);
});
