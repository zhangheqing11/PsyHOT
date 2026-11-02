// Guards on a provider billed per call: a platform's share of the budget, a pause after balance
// refusals, and an interval floor no writer can go below. Only local functions; nothing is sent.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { BudgetExceededError, paidRequest, ProviderRejectedError } from "@aihot/backend/providers/receipts";
import { assertPaidInterval } from "@aihot/backend/sources/config-keys";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
after(async () => { await stopBoss(); await closeDb(); });

const request = (service: string, pool: string | undefined, n: number) =>
  ({ service, pool, purpose: "guard_test", subject: `guard-${T}`, identity: { n, T } });

test("one platform's share runs out without touching the service's other platforms", async () => {
  const service = `svc-${T}`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES
            (${service}, 100, 100, 100), (${`${service}:a`}, 100, 100, 1), (${`${service}:b`}, 100, 100, 1)`;
  let sent = 0;
  const call = async () => { sent += 1; return { response: { ok: true } }; };
  await paidRequest(request(service, `${service}:a`, 1), call);
  await assert.rejects(paidRequest(request(service, `${service}:a`, 2), call), (e: unknown) => e instanceof BudgetExceededError && e.service === `${service}:a`);
  await paidRequest(request(service, `${service}:b`, 3), call);
  assert.equal(sent, 2);
});

test("after three balance refusals within the hour the provider is not asked again", async () => {
  const service = `svc-balance-${T}`;
  let sent = 0;
  const refuse = async (): Promise<never> => {
    sent += 1;
    throw new ProviderRejectedError('everyinfra HTTP 402: {"error":{"code":"payment_required"}}', 402, false);
  };
  for (let n = 1; n <= 3; n++) await assert.rejects(paidRequest(request(service, undefined, n), refuse), ProviderRejectedError);
  await assert.rejects(paidRequest(request(service, undefined, 4), refuse), (e: unknown) => e instanceof BudgetExceededError && /balance/.test(e.message));
  assert.equal(sent, 3);
});

/** Three refusals with this text within the hour, then a fourth request: stopped before sending, or sent. */
async function pausedAfter(label: string, status: number, text: string): Promise<boolean> {
  const service = `svc-${label}-${T}`;
  let sent = 0;
  const refuse = async (): Promise<never> => {
    sent += 1;
    throw new ProviderRejectedError(text, status, status === 429);
  };
  for (let n = 1; n <= 3; n++) await assert.rejects(paidRequest(request(service, undefined, n), refuse), ProviderRejectedError);
  await assert.rejects(paidRequest(request(service, undefined, 4), refuse), (e: unknown) => e instanceof ProviderRejectedError || e instanceof BudgetExceededError);
  return sent === 3;
}

test("DashScope's billing refusals pause the provider like a 402 does", async () => {
  const refusals = [
    'HTTP 429: {"error":{"code":"CommodityNotPurchased","message":"Access denied, please make sure your account is in good standing."}}',
    'HTTP 429: {"code":"GoUsageLimitError","message":"You have reached the usage limit of your plan."}',
    'HTTP 429: {"error":{"code":"FreeUsageLimitError","message":"The free tier is used up."}}',
    'HTTP 429: {"code":"PostpaidBillOverdue","message":"Your postpaid bill is overdue."}',
    'HTTP 429: {"code":"Throttling.AllocationQuota","message":"Free allocated quota exceeded."}',
    'HTTP 429: {"error":{"message":"Free allocated quota exceeded.","type":"Throttling"}}',
  ];
  for (const [i, text] of refusals.entries()) assert.equal(await pausedAfter(`billing${i}`, 429, text), true, text);
});

test("a rate limit or a refused key does not pause the provider", async () => {
  const passing = [
    ["429", 429, 'HTTP 429: {"error":{"message":"Too many requests. Your current concurrency is 12","type":"rate_limit_error"}}'],
    ["throttle", 429, 'HTTP 429: {"code":"Throttling","message":"Requests rate limit exceeded, please try again later."}'],
    ["allocation", 429, 'HTTP 429: {"code":"Throttling.AllocationQuota","message":"Allocated quota exceeded, please increase your quota limit."}'],
    ["tpm", 429, 'HTTP 429: {"code":"Throttling.RateQuota","message":"Request rate increased too quickly."}'],
    ["401", 401, 'HTTP 401: {"error":{"code":"invalid_api_key","message":"Incorrect API key provided."}}'],
    ["403", 403, 'HTTP 403: {"error":{"message":"Access denied for this resource."}}'],
  ] as const;
  for (const [label, status, text] of passing) assert.equal(await pausedAfter(label, status, text), false, text);
});

test("a paid listing cannot be polled faster than its floor, by the admin or by any SQL", async () => {
  assert.throws(() => assertPaidInterval("json_list", { adapter: "everyinfra_xhs" }, 60), /720/);
  assert.doesNotThrow(() => assertPaidInterval("json_list", { adapter: "everyinfra_xhs" }, 1440));
  assert.doesNotThrow(() => assertPaidInterval("rss", { feedUrl: "https://example.org/feed" }, 15));
  const id = `xhs-floor-${T}`;
  await sql`INSERT INTO sources (id, name, kind, config, interval_minutes, next_fetch_at)
            VALUES (${id}, ${id}, 'json_list', ${sql.json({ adapter: "everyinfra_xhs", everyinfraAction: "search" })}, 1440, '2100-01-01')`;
  await assert.rejects(sql`UPDATE sources SET interval_minutes = 60 WHERE id = ${id}`, /sources_paid_interval_floor/);
});
