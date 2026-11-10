// Cost estimates: the math, the estimate written onto new receipts, and the price loader script.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson } from "@aihot/backend/providers/llm";
import { estimateCallCost, estimateCost, invalidatePriceCache, usageTotals } from "@aihot/backend/providers/prices";
import { modelsOverview } from "@aihot/backend/admin/models";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { applyServicePrices } from "../scripts/apply-service-prices.ts";

const T = tag();
const usage = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600 };
const provider = await stub(() => ({ id: `stub-${T}`, choices: [{ message: { content: '{"ok":true}' } }], usage }));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
after(async () => {
  await sql`DELETE FROM service_prices WHERE service = 'deepseek' AND model LIKE 'deepseek-flash%' OR service = 'deepseek-tools' OR service LIKE ${`svc-${T}%`}`;
  invalidatePriceCache();
  await provider.close();
  await stopBoss();
  await closeDb();
});

const price = { currency: "CNY", input_per_mtok: "2", cached_per_mtok: "0.5", output_per_mtok: "8", per_request: null };

test("estimate splits cache hits from misses and prices output; no price or nothing priced gives null", () => {
  const u = usageTotals(usage);
  assert.deepEqual(u, { tokensIn: 1000, tokensCached: 400, tokensOut: 200, requests: 1 });
  const est = estimateCost(price, u)!;
  assert.equal(est.currency, "CNY");
  assert.ok(Math.abs(est.amount - (600 * 2 + 400 * 0.5 + 200 * 8) / 1e6) < 1e-12);
  // No cached price: hits count as ordinary input. OpenAI-style cached_tokens is understood too.
  const noCached = estimateCost({ ...price, cached_per_mtok: null }, usageTotals({ prompt_tokens: 1000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 400 } }))!;
  assert.ok(Math.abs(noCached.amount - 2000 / 1e6) < 1e-12);
  // Cache hits can never exceed the prompt.
  assert.ok(estimateCost(price, { tokensIn: 10, tokensCached: 99, tokensOut: 0, requests: 1 })!.amount > 0);
  assert.equal(estimateCost(null, u), null);
  assert.equal(estimateCost({ ...price, input_per_mtok: null, cached_per_mtok: null, output_per_mtok: null }, u), null);
  assert.equal(estimateCost(price, usageTotals(null))!.amount, 0);
  assert.ok(Math.abs(estimateCost({ ...price, input_per_mtok: null, cached_per_mtok: null, output_per_mtok: null, per_request: "0.01" }, usageTotals(null))!.amount - 0.01) < 1e-12);
});

const ask = (subject: string) =>
  chatJson({ model: "deepseek-flash", purpose: "price_test", subject, promptVersion: "t1", system: "s", user: `input ${subject}`, schema: z.object({ ok: z.boolean() }) });
const attemptOf = async (receiptId: number) => {
  const [a] = await sql<{ cost: string | null; currency: string | null; cost_basis: string | null }[]>`SELECT cost, currency, cost_basis FROM receipt_attempts WHERE receipt_id = ${receiptId}`;
  const [r] = await sql<{ cost: string | null; cost_basis: string | null }[]>`SELECT cost, cost_basis FROM receipts WHERE id = ${receiptId}`;
  return { a: a!, r: r! };
};

test("a model call writes an estimated cost onto its receipt only when a price row exists", async () => {
  await sql`DELETE FROM service_prices WHERE service = 'deepseek' AND model = 'deepseek-flash'`;
  invalidatePriceCache();
  const none = await attemptOf((await ask(`noprice-${T}`)).receiptId);
  assert.deepEqual([none.a.cost, none.a.currency, none.a.cost_basis, none.r.cost], [null, null, null, null]);

  await sql`INSERT INTO service_prices (service, model, currency, input_per_mtok, cached_per_mtok, output_per_mtok) VALUES ('deepseek', 'deepseek-flash', 'CNY', 2, 0.5, 8)`;
  invalidatePriceCache();
  const priced = await attemptOf((await ask(`price-${T}`)).receiptId);
  assert.equal(priced.a.currency, "CNY");
  assert.equal(priced.a.cost_basis, "estimated");
  assert.ok(Math.abs(Number(priced.a.cost) - (600 * 2 + 400 * 0.5 + 200 * 8) / 1e6) < 1e-9);
  assert.equal(priced.r.cost_basis, "estimated");

  // The admin page sums the cache hits that the estimate needs.
  await modelsOverview(1);
  const [sum] = await sql<{ tokens_cached: string }[]>`
    SELECT sum(coalesce(a.usage->>'prompt_cache_hit_tokens', a.usage->'prompt_tokens_details'->>'cached_tokens')::bigint) AS tokens_cached
    FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id WHERE r.purpose = 'price_test' AND r.subject LIKE ${`%-${T}`}`;
  assert.equal(Number(sum!.tokens_cached), 800);

  // A broken price table must not fail the paid call.
  await sql`ALTER TABLE service_prices RENAME TO service_prices_off`;
  invalidatePriceCache();
  try {
    const survived = await attemptOf((await ask(`broken-${T}`)).receiptId);
    assert.equal(survived.a.cost, null);
  } finally {
    await sql`ALTER TABLE service_prices_off RENAME TO service_prices`;
    invalidatePriceCache();
  }
});

test("the price loader previews without writing, then upserts with an audit row and keeps unlisted rows", async () => {
  const svc = `svc-${T}`;
  const keep = `${svc}-keep`;
  await sql`INSERT INTO service_prices (service, model, currency, input_per_mtok) VALUES (${keep}, '', 'USD', 1)`;
  const rows = [{ service: svc, model: "m", currency: "CNY", input_per_mtok: 0.5, cached_per_mtok: null, output_per_mtok: null, per_request: null, source_url: "https://example.org/p", verified_on: "2026-11-10", note: "t" }];
  const lines: string[] = [];
  assert.equal(await applyServicePrices(rows, { report: (l) => lines.push(l) }), 1);
  assert.equal((await sql`SELECT 1 FROM service_prices WHERE service = ${svc}`).length, 0, "preview writes nothing");
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject = ${`price:${svc}/m`}`).length, 0);

  assert.equal(await applyServicePrices(rows, { apply: true, report: () => {} }), 1);
  const [p] = await sql<{ input_per_mtok: string; verified_on: string }[]>`SELECT input_per_mtok, verified_on::text FROM service_prices WHERE service = ${svc} AND model = 'm'`;
  assert.equal(Number(p!.input_per_mtok), 0.5);
  assert.equal(p!.verified_on, "2026-11-10");
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject = ${`price:${svc}/m`} AND action = 'service_prices.set'`).length, 1);
  assert.equal((await sql`SELECT 1 FROM service_prices WHERE service = ${keep}`).length, 1, "unlisted rows stay");

  // Unchanged rows are a no-op; a changed price updates and records the old values.
  assert.equal(await applyServicePrices(rows, { apply: true, report: () => {} }), 0);
  assert.equal(await applyServicePrices([{ ...rows[0]!, input_per_mtok: 0.6 }], { apply: true, report: () => {} }), 1);
  const [audit] = await sql<{ before: { input_per_mtok: number } }[]>`SELECT before FROM audit_log WHERE subject = ${`price:${svc}/m`} ORDER BY id DESC LIMIT 1`;
  assert.equal(audit!.before.input_per_mtok, 0.5);
});

test("industry/service-prices.json is valid for the loader", async () => {
  const { readFileSync } = await import("node:fs");
  await applyServicePrices(JSON.parse(readFileSync(new URL("../industry/service-prices.json", import.meta.url), "utf8")), { report: () => {} });
});

test("the price follows the time of the call: off-peak row at weekends and off hours, peak row at weekday working hours", async () => {
  const svc = `svc-${T}-tier`;
  await sql`INSERT INTO service_prices (service, model, currency, input_per_mtok, cached_per_mtok, output_per_mtok) VALUES
    (${svc}, 'm', 'CNY', 2, 0.04, 8), (${svc}, 'm@offpeak', 'CNY', 1, 0.02, 4), (${svc}, 'plain', 'CNY', 2, null, 8)`;
  invalidatePriceCache();
  const u = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, prompt_cache_hit_tokens: 0 };
  const weekdayTen = new Date("2026-11-11T02:00:00Z"); // Wednesday 10:00 Beijing
  const saturday = new Date("2026-11-14T02:00:00Z"); // Saturday 10:00 Beijing
  const evening = new Date("2026-11-11T12:00:00Z"); // Wednesday 20:00 Beijing
  assert.equal((await estimateCallCost(svc, "m", u, weekdayTen))!.amount, 10);
  assert.equal((await estimateCallCost(svc, "m", u, saturday))!.amount, 5);
  assert.equal((await estimateCallCost(svc, "m", u, evening))!.amount, 5);
  // A model without an @offpeak row keeps its one price at any time.
  assert.equal((await estimateCallCost(svc, "plain", u, saturday))!.amount, 10);
});

test("a web search or fetch is priced per successful request from the deepseek-tools row", async () => {
  await sql`INSERT INTO service_prices (service, model, currency, per_request) VALUES ('deepseek-tools', '', 'CNY', 0.005)`;
  invalidatePriceCache();
  const c = await estimateCallCost("deepseek-tools", null, null);
  assert.deepEqual([c!.amount, c!.currency, c!.basis], [0.005, "CNY", "estimated"]);
});
