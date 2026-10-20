import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import http from "node:http";
import { closeDb, sql } from "@aihot/backend/db";
import { checkMpAccount, scheduleMpReconcile } from "@aihot/backend/sources/mp";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { config } from "@aihot/backend/config";

const T = tag();
const id = `test-werss-${T}`;
const biz = "MTIzNDU=";
const link = `https://mp.weixin.qq.com/s?__biz=MTIzNDU%3D&amp;mid=${Date.now()}&amp;idx=1`;
let body = "";
let xml = "";
let redirect = false;
const render = (publisherLink = link) => `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><title>心理学研究 ${T}</title><link>${publisherLink}</link><pubDate>${new Date(Date.now()-3600000).toUTCString()}</pubDate><description>列表摘要</description><content:encoded><![CDATA[${body}]]></content:encoded></item></channel></rss>`;
const server = http.createServer((req, res) => {
  assert.equal(req.url, "/feed/MP_WXS_12345.xml");
  res.writeHead(redirect ? 302 : 200, redirect ? { location: "http://127.0.0.1:1/private" } : { "content-type": "application/xml" });
  res.end(xml);
});
await new Promise<void>((resolve) => server.listen(0,"127.0.0.1",resolve));
const address = server.address() as {port:number};
process.env.WECHAT_RSS_BASE_URL = `http://127.0.0.1:${address.port}`;
// Keys are present to prove that WeRSS errors never trigger paid account or body calls.
process.env.EVERYINFRA_API_KEY = "test-paid-key";
process.env.DAJIALA_KEY = "test-paid-key";
config.allowPrivateNetworkFetch = false;
after(async () => { await new Promise<void>(r=>server.close(()=>r())); await stopBoss(); await closeDb(); });

test("fixed accounts read WeRSS only, revise missing bodies, and queue analysis without a paid receipt", async () => {
  await sql`INSERT INTO sources (id,name,kind,config) VALUES (${id},'测试公众号','mp_account',${sql.json({ werssFeedId:"MP_WXS_12345",wechatBiz:biz })})`;
  xml = render();
  assert.equal((await checkMpAccount(id,"manual")).status,"ok");
  const [first] = await sql`SELECT id,body_status,revision,backfill_reason FROM articles WHERE source_id=${id}`;
  assert.equal(first!.body_status,"none");
  assert.equal(first!.backfill_reason,"werss-first-import");
  body = '<p>' + '研究的方法和结果，需要完整正文评估。'.repeat(30) + '</p>';
  xml = render();
  assert.equal((await checkMpAccount(id,"manual")).status,"ok");
  const [next] = await sql`SELECT body_status,revision FROM articles WHERE source_id=${id}`;
  assert.equal(next!.body_status,"ok"); assert.equal(next!.revision,2);
  const third = await checkMpAccount(id,"manual");
  assert.equal(third.status,"ok");
  assert.equal("revised" in third && third.revised,0);
  assert.ok((await sql`SELECT 1 FROM pgboss.job WHERE data->>'articleId'=${first!.id}`).length>0);
  assert.equal((await sql`SELECT 1 FROM receipts WHERE subject=${id}`).length,0);
});

test("empty caches, wrong publishers and redirects are visible failures, never paid fallbacks",async()=>{
  for (const sample of ['<rss><channel/></rss>', render('https://mp.weixin.qq.com/s?__biz=OTk5&amp;mid=2&amp;idx=1')]) {
    xml=sample;
    assert.equal((await checkMpAccount(id,"manual")).status,"failed");
  }
  redirect=true;
  assert.equal((await checkMpAccount(id,"manual")).status,"failed");
  redirect=false;
  const [row]=await sql`SELECT last_error,cursor->>'retryAt' AS retry_at FROM sources WHERE id=${id}`;
  assert.ok(row!.last_error); assert.ok(Date.parse(row!.retry_at)>Date.now()+50*60000);
  await scheduleMpReconcile();
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name='sources.mp' AND data->>'sourceId'=${id}`).length,0);
  assert.equal((await sql`SELECT 1 FROM receipts WHERE subject=${id}`).length,0);
});

test("missing mapping and paused accounts cannot spend money or advance a success cursor",async()=>{
  const other=`test-werss-missing-${T}`;
  await sql`INSERT INTO sources(id,name,kind,config) VALUES(${other},'未配置','mp_account','{"ghid":"gh_test"}')`;
  assert.equal((await checkMpAccount(other,"manual")).status,"failed");
  const [row]=await sql`SELECT last_ok_at FROM sources WHERE id=${other}`;
  assert.equal(row!.last_ok_at,null);
  await sql`UPDATE sources SET enabled=false WHERE id=${other}`;
  assert.equal((await checkMpAccount(other,"manual")).status,"paused");
  assert.equal((await sql`SELECT 1 FROM receipts WHERE subject=${other}`).length,0);
});
