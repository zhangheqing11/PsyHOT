import { Reply, stub, tag, gate } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { systemOne } from "@aihot/backend/providers/typesafe";
import { BudgetExceededError, completeReceipt, ProviderRejectedError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { ModelOutputError } from "@aihot/backend/providers/llm";
import { collectFindings } from "@aihot/backend/operations/alerts";
import { JEV_ROLE_QUESTIONS } from "@aihot/backend/editorial/roles-jev";
import { jevAnswers } from "./jev-fixture.ts";

const T = `typesafe-${tag()}`;
const answer = () => ({ model: "jev-1.14.0", answers: jevAnswers(), usage: { input_tokens: 10000, output_tokens: 0 } });
let respond: (hit: number) => unknown = answer;
const provider = await stub((hit, req) => {
  assert.equal(req.url, "/v1/systemone");
  const body = JSON.parse(req.body);
  assert.equal(body.model, "jev-1.14.0");
  assert.deepEqual(body.questions, JEV_ROLE_QUESTIONS);
  return respond(hit);
});
const ask = (suffix = tag(), extra = {}) => systemOne({ state: { title: "test" }, questions: JEV_ROLE_QUESTIONS, subject: `${T}-${suffix}`, promptVersion: "test", ...extra });
let budget: { per_minute: number; per_hour: number; per_day: number };
before(async () => {
  config.allowPrivateNetworkFetch = true;
  process.env.TYPESAFE_BASE_URL = provider.url;
  process.env.TYPESAFE_API_KEY = "test-key";
  [budget] = await sql`SELECT per_minute, per_hour, per_day FROM budgets WHERE service='typesafe'` as [typeof budget];
  assert.ok(budget, "migration seeds the circuit breaker");
  await sql`UPDATE budgets SET per_minute=100000, per_hour=100000, per_day=100000 WHERE service='typesafe'`;
});
after(async () => {
  await sql`DELETE FROM receipt_attempts WHERE receipt_id IN (SELECT id FROM receipts WHERE subject LIKE ${T + '%'})`;
  await sql`DELETE FROM receipts WHERE subject LIKE ${T + '%'}`;
  if (budget) await sql`UPDATE budgets SET per_minute=${budget.per_minute}, per_hour=${budget.per_hour}, per_day=${budget.per_day} WHERE service='typesafe'`;
  await provider.close();
  await closeDb();
});

test("System One records actual usage cost, completes and reuses receipts, separates subjects and attempt tags", async () => {
  const start = provider.hits();
  const a = await ask("reuse");
  await completeReceipt(sql, a.receiptId);
  const b = await ask("reuse");
  assert.equal(b.receiptId, a.receiptId);
  assert.equal(b.reused, true);
  assert.equal(provider.hits(), start + 1);
  const [r] = await sql`SELECT service, model, purpose, status, usage, cost::float, currency, cost_basis, logical_key FROM receipts WHERE id=${a.receiptId}`;
  assert.deepEqual([r.service, r.model, r.purpose, r.status, r.cost, r.currency, r.cost_basis], ["typesafe", "jev-1.14.0", "score_roles", "completed", 0.00042, "USD", "actual"]);
  assert.deepEqual(r.usage, answer().usage);
  assert.match(r.logical_key, /^typesafe:score_roles:jev-1.14.0:/);
  assert.notEqual((await ask("other")).receiptId, a.receiptId);
  assert.notEqual((await ask("reuse", { attemptTag: "rerun" })).receiptId, a.receiptId);
});

test("429, 529 and 5xx retry on the same receipt, stopping after three attempts", async () => {
  for (const status of [429, 529, 503]) {
    let hits = 0;
    respond = () => ++hits === 1 ? new Reply(status, {}) : answer();
    const r = await ask();
    const [row] = await sql`SELECT attempts FROM receipts WHERE id=${r.receiptId}`;
    assert.equal(row.attempts, 2);
    assert.equal(hits, 2);
  }
  let hits = 0;
  respond = () => { hits++; return new Reply(503, {}); };
  await assert.rejects(ask(), ProviderRejectedError);
  assert.equal(hits, 3);
  respond = answer;
});

test("422 does not retry; invalid probabilities fail and keep the billed response", async () => {
  const start = provider.hits();
  respond = () => new Reply(422, {});
  await assert.rejects(ask(), (e: unknown) => e instanceof ProviderRejectedError && e.status === 422 && !e.retryable);
  assert.equal(provider.hits(), start + 1);
  respond = () => { const a = answer(); a.answers.nov!.probabilities = { 0: 0.5, 1: 0, 2: 0, 3: 0 }; return a; };
  await assert.rejects(ask("invalid"), ModelOutputError);
  const [row] = await sql`SELECT status, response, cost FROM receipts WHERE subject=${T + '-invalid'}`;
  assert.equal(row.status, "failed");
  assert.ok(row.response && Number(row.cost) > 0);
  respond = answer;
});

test("timeout remains unknown and cannot be bought again before receipt recovery", async () => {
  const hold = gate();
  respond = async () => { await hold.promise; return answer(); };
  const start = provider.hits();
  try {
    await assert.rejects(ask("timeout", { timeoutMs: 100 }));
    await assert.rejects(ask("timeout"), ReceiptUnknownError);
    assert.equal(provider.hits(), start + 1);
    const [row] = await sql`SELECT status, attempts FROM receipts WHERE subject=${T + '-timeout'}`;
    assert.deepEqual([row.status, row.attempts], ["unknown", 1]);
  } finally { hold.open(); respond = answer; }
});

test("valve off, drifting model alias and stopped budget all prevent HTTP", async () => {
  const start = provider.hits();
  config.modelCallsEnabled = false;
  try { await assert.rejects(ask(), /disabled/); } finally { config.modelCallsEnabled = true; }
  process.env.TYPESAFE_MODEL = "jev-latest";
  try { await assert.rejects(ask(), /pinned/); } finally { delete process.env.TYPESAFE_MODEL; }
  await sql`UPDATE budgets SET per_minute=0 WHERE service='typesafe'`;
  try { await assert.rejects(ask(), BudgetExceededError); }
  finally { await sql`UPDATE budgets SET per_minute=100000 WHERE service='typesafe'`; }
  assert.equal(provider.hits(), start);
});

test("a refused local connection is failed, not unknown, and counts three attempts", async () => {
  const closed = await stub(answer);
  await closed.close();
  process.env.TYPESAFE_BASE_URL = closed.url;
  try {
    await assert.rejects(ask("connect-refused"), (e: unknown) => e instanceof ProviderRejectedError && e.retryable);
    const [row] = await sql`SELECT status, attempts FROM receipts WHERE subject=${T + '-connect-refused'}`;
    assert.deepEqual([row.status, row.attempts], ["failed", 3]);
  } finally { process.env.TYPESAFE_BASE_URL = provider.url; }
});

test("three 402 refusals pause TypeSafe and appear in the existing Feishu alert findings", async () => {
  respond = () => new Reply(402, {});
  const start = provider.hits();
  for (let i = 0; i < 3; i++) await assert.rejects(ask(`balance-${i}`), (e: unknown) => e instanceof ProviderRejectedError && e.status === 402);
  await assert.rejects(ask("paused"), (e: unknown) => e instanceof BudgetExceededError && e.period === "balance");
  assert.equal(provider.hits(), start + 3);
  assert.ok((await collectFindings()).some((f) => f.key === "provider.refused.typesafe"));
});
