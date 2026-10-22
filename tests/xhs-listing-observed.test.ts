// A Xiaohongshu keyword listing against a local stub: goods notes never enter, the author is the
// participant, and the counts a later listing reports replace the stored ones without a new revision.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { collectSource } from "@aihot/backend/sources/collect";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const noteId = randomBytes(12).toString("hex");
const goodsId = randomBytes(12).toString("hex");
const provider = await stub((hit) => ({
  id: `req-${T}-${hit}`, billing: { charged: true, charged_usd: 0.005556 },
  results: [
    { id: noteId, url: `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=t${hit}`, title: "一项新研究：睡眠与情绪", text: "研究发现……",
      author_id: "5F00AA11", author_name: "研究号", posted_at: new Date().toISOString(), like_count: 10 * hit, comment_count: hit },
    { id: goodsId, url: `https://www.xiaohongshu.com/explore/${goodsId}?xsec_token=t${hit}`, title: "研究级助眠好物", text: "研究……",
      author_id: "5f00bb22", author_name: "店铺", posted_at: new Date().toISOString(), is_goods_note: true },
  ],
}));
process.env.EVERYINFRA_BASE_URL = provider.url;
process.env.EVERYINFRA_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

after(async () => { await provider.close(); await stopBoss(); await closeDb(); });

test("a keyword listing: no goods notes, the author as participant, counts refreshed on the next pass", async () => {
  const id = `xhs-observed-${T}`;
  const budgets = await sql<{ service: string; per_minute: number; per_hour: number; per_day: number }[]>`SELECT service, per_minute, per_hour, per_day FROM budgets WHERE service LIKE 'everyinfra%'`;
  await sql`UPDATE budgets SET per_minute = 10000, per_hour = 10000, per_day = 10000 WHERE service LIKE 'everyinfra%'`;
  try {
    await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, next_fetch_at)
      VALUES (${id}, ${id}, 'json_list', ${sql.json({ adapter: "everyinfra_xhs", everyinfraAction: "search",
        everyinfraParams: { keyword: id }, everyinfraDetail: false, summaryIsBody: true } as never)}, 'T2', 'hot_signal', 1440, '2100-01-01')`;
    const first = await collectSource(id);
    assert.equal(first.created, 1, "the goods note is not ingested");
    assert.equal((await sql`SELECT 1 FROM articles WHERE identity_key = ${`xhs:${goodsId}`}`).length, 0);
    // A different keyword makes the next listing a new paid call within the same window.
    await sql`UPDATE sources SET config = jsonb_set(config, '{everyinfraParams,keyword}', ${sql.json(`next-${T}`)}) WHERE id = ${id}`;
    const second = await collectSource(id);
    assert.equal(second.created, 0);
    assert.equal(second.revised, 0);
    const [row] = await sql<{ raw: Record<string, unknown>; revision: number }[]>`SELECT raw, revision FROM articles WHERE identity_key = ${`xhs:${noteId}`}`;
    assert.equal(row!.raw.participant, "xhs-author:5f00aa11");
    assert.equal(row!.raw.like_count, 20, "the newest count");
    assert.equal(row!.raw.comment_count, 2);
    assert.equal(row!.revision, 1, "counts alone are no new revision");
  } finally {
    for (const b of budgets) await sql`UPDATE budgets SET per_minute = ${b.per_minute}, per_hour = ${b.per_hour}, per_day = ${b.per_day} WHERE service = ${b.service}`;
  }
});
