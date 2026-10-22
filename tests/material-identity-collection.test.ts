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
const calls: string[] = [];
const body = "Full note content, not the short search excerpt. ".repeat(40);
const provider = await stub((hit, req) => {
  const call = JSON.parse(req.body);
  calls.push(call.action);
  return {
    id: `req-${T}-${hit}`, billing: { charged: true, charged_usd: 0.005556 },
    results: call.action === "note"
      ? { title: "Full note title", text: body, author_name: "One author", posted_at: new Date().toISOString() }
      : [{ id: noteId, url: `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=token-${hit}`,
          title: "Search title", text: "Short search excerpt.", author_name: "One author", posted_at: new Date().toISOString() }],
  };
});
process.env.EVERYINFRA_BASE_URL = provider.url;
process.env.EVERYINFRA_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

after(async () => { await provider.close(); await stopBoss(); await closeDb(); });

test("rotating signed URLs across search entrances never pay for the same note detail again", async () => {
  const sources = [`xhs-collection-a-${T}`, `xhs-collection-b-${T}`];
  // Only local stubs are contacted. Keep enough budget for the listing calls in this regression.
  const [budget] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'everyinfra'`;
  await sql`UPDATE budgets SET per_minute = 10000, per_hour = 10000, per_day = 10000 WHERE service = 'everyinfra'`;
  try {
    for (const id of sources) {
      await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, next_fetch_at)
        VALUES (${id}, ${id}, 'json_list', ${sql.json({ adapter: "everyinfra_xhs", everyinfraAction: "search",
          everyinfraParams: { keyword: id }, everyinfraDetail: true, summaryIsBody: true } as never)}, 'T2', 'editorial', '2100-01-01')`;
    }
    const first = await collectSource(sources[0]!);
    assert.equal(first.created, 1);
    const [stored] = await sql<{ id: string; revision: number }[]>`SELECT id, revision FROM articles WHERE identity_key = ${`xhs:${noteId}`}`;
    // Change the configured search so its logical listing receipt differs, even within one 10-min window.
    await sql`UPDATE sources SET config = jsonb_set(config, '{everyinfraParams,keyword}', ${sql.json(`next-${T}`)}) WHERE id = ${sources[0]}`;
    const sameEntrance = await collectSource(sources[0]!);
    const otherEntrance = await collectSource(sources[1]!);
    assert.equal(sameEntrance.created, 0);
    assert.equal(sameEntrance.revised, 0);
    assert.equal(otherEntrance.created, 0);
    assert.equal(otherEntrance.revised, 0);
    assert.equal(calls.filter((a) => a === "note").length, 1);
    assert.equal(calls.filter((a) => a === "search").length, 3);
    const [current] = await sql<{ title: string; body_text: string; revision: number }[]>`SELECT title, body_text, revision FROM articles WHERE id = ${stored!.id}`;
    assert.equal(current!.body_text, body);
    assert.equal(current!.title, "Full note title");
    assert.equal(current!.revision, stored!.revision);
    assert.equal((await sql`SELECT 1 FROM article_discoveries WHERE article_id = ${stored!.id}`).length, 2);
  } finally {
    if (budget) await sql`UPDATE budgets SET per_minute = ${budget.per_minute}, per_hour = ${budget.per_hour}, per_day = ${budget.per_day} WHERE service = 'everyinfra'`;
  }
});
