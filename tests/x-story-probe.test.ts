import assert from "node:assert/strict";
import { test } from "node:test";
import { runXProbe, type ProbeResult, type ProbeStory } from "../packages/backend/src/events/x-story-probe.ts";
import { BudgetExceededError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";

const at = new Date("2026-10-24T12:00:00Z");
const story = (id: number): ProbeStory => ({ storyId: id, title: `Story ${id}`, reports: [{ id: `article-${id}`,
  url: `https://doi.org/10.1000/paper-${id}`, title: "Sleep changes emotional memory processing across human adolescence", body: null }] });

test("probe compares ten stories with at most thirty receipt-backed calls and records every result", async () => {
  let calls = 0;
  const saved: ProbeResult[] = [];
  const result = await runXProbe(Array.from({ length: 10 }, (_, i) => story(i + 1)), at,
    async (s, q) => { calls++; return { results: [{ id: String(calls), url: `https://x.com/research/status/${calls}`,
      text: q.needle, posted_at: "2026-10-23T12:00:00Z", like_count: 2 }], receiptId: calls, reused: false, costUsd: 0.000556 }; },
    async (r) => { saved.push(r); });
  assert.equal(calls, 30);
  assert.equal(result.completed, 30);
  assert.equal(result.stopped, null);
  assert.equal(saved.length, 30);
  assert.equal(saved[0].received, 1);
  assert.equal(saved[0].matched, 1);
  assert.equal(saved[0].samples[0].review, null, "exact evidence is not a human relevance judgment");
  assert.equal(saved[0].receiptId, 1);
});

test("over-sized or duplicate samples fail before any paid request", async () => {
  let calls = 0;
  const request = async () => { calls++; throw new Error("must not call"); };
  for (const sample of [Array.from({ length: 11 }, (_, i) => story(i)), [story(1), story(1)]]) {
    await assert.rejects(runXProbe(sample, at, request, async () => {}), /10 unique/);
  }
  assert.equal(calls, 0);
});

test("budget exhaustion stops normally, preserves prior results, and sends no subsequent queries", async () => {
  let calls = 0;
  const saved: ProbeResult[] = [];
  const result = await runXProbe([story(1), story(2)], at, async () => {
    if (++calls === 2) throw new BudgetExceededError("everyinfra:twitter", "day", 3600);
    return { results: [], receiptId: 1, reused: false, costUsd: 0.000556 };
  }, async (r) => { saved.push(r); });
  assert.equal(calls, 2);
  assert.equal(result.completed, 1);
  assert.equal(result.stopped, "budget");
  assert.equal(saved.length, 1);
});

test("unknown provider outcome stops the probe without retrying or losing completed evidence", async () => {
  let calls = 0;
  await assert.rejects(runXProbe([story(1)], at, async () => {
    calls++; throw new ReceiptUnknownError(12, "unknown outcome");
  }, async () => {}), ReceiptUnknownError);
  assert.equal(calls, 1);
});

test("replayed receipts are visible as replayed, not reported as new paid calls", async () => {
  const saved: ProbeResult[] = [];
  await runXProbe([story(1)], at, async () => ({ results: [], receiptId: 15, reused: true, costUsd: 0.000556 }),
    async (r) => { saved.push(r); });
  assert.equal(saved.length, 3);
  assert.ok(saved.every((r) => r.reused && r.newCostUsd === 0 && r.receiptCostUsd === 0.000556));
});
