import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetExceededError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { runXhsProbe, xhsRuleMatch, xhsStoryKeyword, type XhsProbeResult, type XhsProbeStory } from "../packages/backend/src/events/xhs-story-probe.ts";

const story = (id = 1): XhsProbeStory => ({ storyId: id, title: "抑郁症治疗迎来新进展", keyword: "抑郁症治疗迎来新进展",
  maxScore: 80, xhsParticipants: 2, reports: [{ id: `paper-${id}`, title: "临床试验比较两种干预方案", url: "https://example.org/paper", language: "zh" }] });

test("XHS keyword reuses lookupQuery cleaning, falls back to a Chinese report, and caps Unicode characters at twenty", () => {
  assert.equal(xhsStoryKeyword({ title: "【前沿】研究速递｜睡眠不足改变青少年的情绪记忆：多中心研究证据", reports: [] }), "睡眠不足改变青少年的情绪记忆");
  const s = story();
  assert.equal(xhsStoryKeyword({ title: "An English event", reports: [
    { ...s.reports[0], title: "An English report", language: "en" },
    { ...s.reports[0], title: "【综述】新研究揭示睡眠与情绪调节之间长期而复杂的联系", language: null },
  ] }), "新研究揭示睡眠与情绪调节之间长期而复杂的");
  const unicode = "𠮷".repeat(30);
  assert.equal([...xhsStoryKeyword({ title: unicode, reports: [] })].length, 20);
  assert.equal(xhsStoryKeyword({ title: "English event", reports: [{ ...s.reports[0], title: "中文报道标题", language: "zh" }] }), "中文报道标题");
});

test("XHS rule needs two distinct non-overlapping Chinese fragments, ignoring generic words", () => {
  assert.equal(xhsRuleMatch("抑郁症治疗", [], "抑郁经历", "治疗的实际体验"), true);
  assert.equal(xhsRuleMatch("抑郁症治疗", [], "抑郁症", ""), false, "overlapping 抑郁 and 郁症 are one fragment");
  assert.equal(xhsRuleMatch("抑郁症治疗", [], "抑郁抑郁", ""), false, "repeating one fragment is insufficient");
  assert.equal(xhsRuleMatch("心理学研究最新发现", [], "最新心理学研究发现", ""), false);
  assert.equal(xhsRuleMatch("睡眠 记忆", [], "睡眠", "记忆"), true);
  assert.equal(xhsRuleMatch("睡眠 记忆", [], "睡，眠，记，忆", ""), false, "punctuation must not manufacture consecutive characters");
});

test("XHS rule also accepts report-title bigram Dice overlap of at least 0.3", () => {
  assert.equal(xhsRuleMatch("完全不同的检索词", [{ title: "甲乙丙丁戊己庚" }], "甲乙丙丁新标题", ""), true);
  assert.equal(xhsRuleMatch("完全不同的检索词", [{ title: "甲乙丙丁戊己庚" }], "甲乙其他标题", ""), false);
  assert.equal(xhsRuleMatch("", [{ title: "" }], "", ""), false);
  assert.equal(xhsRuleMatch("无关检索词", [{ title: "甲乙丙丁戊己庚辛壬癸子" }], "甲乙丙丁丑寅卯辰巳午未", ""), true, "three shared bigrams out of ten on each side is exactly 0.3");
});

test("XHS probe records raw counts and twenty samples, retains goods notes, and removes signed note links", async () => {
  const saved: XhsProbeResult[] = [];
  const rows = Array.from({ length: 23 }, (_, i) => {
    const id = (i + 1).toString(16).padStart(24, "0");
    return { id, url: `https://m.xiaohongshu.com/discovery/item/${id}?xsec_token=secret&xsec_source=pc_search#fragment`,
      title: "抑郁症的经历", text: "𠮷".repeat(210) + "治疗", author_name: "作者", author_id: "author123",
      posted_at: "2026-10-29T12:00:00Z", like_count: 7, collect_count: 8, comment_count: 9, is_goods_note: i === 0 };
  });
  const state = await runXhsProbe([story()], async () => ({ results: rows, receiptId: 12, reused: false, costUsd: 0.0056 }), async (r) => { saved.push(r); });
  assert.deepEqual(state, { completed: 1, stopped: null });
  assert.equal(saved[0].keyword, story().keyword);
  assert.equal(saved[0].received, 23);
  assert.equal(saved[0].samples.length, 20);
  assert.deepEqual(saved[0].samples[0], { id: rows[0].id, url: `https://www.xiaohongshu.com/explore/${rows[0].id}`,
    title: rows[0].title, text: "𠮷".repeat(200), authorName: "作者", authorId: "author123", postedAt: rows[0].posted_at,
    likes: 7, collects: 8, comments: 9, isGoodsNote: true, ruleMatch: true, review: null });
  assert.equal(saved[0].receiptCostUsd, 0.0056);
  assert.equal(saved[0].newCostUsd, 0.0056);
});

test("XHS samples refuse unsafe or mismatched note identities and do not invent missing counts", async () => {
  const id = "abcdef0123456789abcdef01";
  const saved: XhsProbeResult[] = [];
  await runXhsProbe([story()], async () => ({ receiptId: 1, reused: true, costUsd: null, results: [
    { id, url: `https://xiaohongshu.com.evil.org/explore/${id}`, title: "fake" },
    { id, url: "https://www.xiaohongshu.com/explore/abcdef0123456789abcdef02", title: "wrong id" },
    { id, url: `https://www.xiaohongshu.com/explore/${id}`, title: "valid", like_count: "9", collect_count: Infinity },
  ] }), async (r) => { saved.push(r); });
  assert.equal(saved[0].received, 3);
  assert.equal(saved[0].samples.length, 1);
  assert.equal(saved[0].samples[0].likes, null);
  assert.equal(saved[0].samples[0].collects, null);
  assert.equal(saved[0].samples[0].comments, null);
  assert.equal(saved[0].samples[0].isGoodsNote, null);
  assert.equal(saved[0].newCostUsd, 0);
  assert.equal(saved[0].receiptCostUsd, null);
});

test("XHS probe allows at most fifteen unique stories and validates all queries before requesting", async () => {
  let calls = 0;
  const request = async () => { calls++; return { results: [], receiptId: calls, reused: false, costUsd: null }; };
  for (const stories of [Array.from({ length: 16 }, (_, i) => story(i + 1)), [story(), story()], [story(0)],
    [story(), { ...story(2), keyword: " " }], [{ ...story(), keyword: "字".repeat(21) }]]) {
    await assert.rejects(runXhsProbe(stories, request, async () => {}), /15 unique|keyword/);
  }
  assert.equal(calls, 0);
  const state = await runXhsProbe(Array.from({ length: 15 }, (_, i) => story(i + 1)), request, async () => {});
  assert.equal(calls, 15);
  assert.equal(state.completed, 15);
});

test("XHS budget stop preserves completed evidence and does not continue to later events", async () => {
  let calls = 0;
  const saved: XhsProbeResult[] = [];
  const state = await runXhsProbe([story(), story(2), story(3)], async () => {
    if (++calls === 2) throw new BudgetExceededError("everyinfra:discovery", "day", 3600);
    return { results: [], receiptId: 1, reused: false, costUsd: 0.0056 };
  }, async (r) => { saved.push(r); });
  assert.deepEqual(state, { completed: 1, stopped: "budget" });
  assert.equal(calls, 2);
  assert.equal(saved.length, 1);
});

test("XHS unknown outcomes are never retried; invalid result envelopes are errors, not zero recall", async () => {
  let calls = 0;
  await assert.rejects(runXhsProbe([story(), story(2)], async () => {
    calls++; throw new ReceiptUnknownError(12, "unknown outcome");
  }, async () => {}), ReceiptUnknownError);
  assert.equal(calls, 1);
  await assert.rejects(runXhsProbe([story()], async () => ({ results: {}, receiptId: 13, reused: true, costUsd: null }), async () => {}), /results is not an array/);
});
