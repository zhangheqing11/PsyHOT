// Xiaohongshu through EveryInfra (json_list adapter everyinfra_xhs) against a local stub: one paid
// listing call through the receipts, notes mapped with their link, author and time, and the public
// counts kept for the hot ranking.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { fetchJsonList } from "@aihot/backend/sources/json-list";

const T = tag();
const calls: Array<{ platform: string; action: string; params: Record<string, unknown> }> = [];
const provider = await stub((_hit, req) => {
  calls.push(JSON.parse(req.body));
  return {
    id: `req-${T}`, billing: { charged: true, charged_usd: 0.005556 },
    results: [
      { id: `n1-${T}`, url: `https://www.xiaohongshu.com/explore/n1-${T}?xsec_token=x`, title: "Nature 子刊：AI 陪伴与心理健康", text: "一项纵向研究……",
        author_name: "研究号", posted_at: "2026-10-16T08:00:00+00:00", like_count: 120, collect_count: 40, comment_count: 10, share_count: "5" },
      { id: `n2-${T}`, url: "", title: "没有链接的笔记" },
    ],
  };
});
process.env.EVERYINFRA_BASE_URL = provider.url;
process.env.EVERYINFRA_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true; // the stub listens on 127.0.0.1

after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("a keyword search becomes candidates with their counts, through one receipted call", async () => {
  const source = { id: `test-xhs-${T}`, config: { adapter: "everyinfra_xhs", everyinfraAction: "search", everyinfraParams: { keyword: `AI心理健康 ${T}`, sort: "newest" }, summaryIsBody: true }, cursor: null };
  const found = await fetchJsonList(source as never);
  assert.deepEqual(calls.map((c) => [c.platform, c.action, c.params.keyword]), [["xiaohongshu", "search", `AI心理健康 ${T}`]]);
  assert.equal(found.length, 1, "a note without a link is skipped");
  const [note] = found;
  assert.equal(note!.url, `https://www.xiaohongshu.com/explore/n1-${T}?xsec_token=x`);
  assert.equal(note!.author, "研究号");
  assert.equal(note!.publishedAt?.toISOString(), "2026-10-16T08:00:00.000Z");
  assert.equal(note!.bodyText, "一项纵向研究……");
  assert.deepEqual(note!.raw, { externalId: `n1-${T}`, like_count: 120, collect_count: 40, comment_count: 10 }, "counts that are not numbers are left out");
  const [receipt] = await sql<{ status: string; cost: string }[]>`SELECT status, cost FROM receipts WHERE service = 'everyinfra' AND subject = ${source.id}`;
  assert.equal(receipt!.status, "received");
  assert.equal(Number(receipt!.cost), 0.005556);
});
