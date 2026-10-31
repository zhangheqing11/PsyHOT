import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetExceededError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { accountsMarkdown, runWechatDiscovery, summarizeAccounts, wechatFieldRates, wechatRuleMatch, wechatStoryKeyword,
  type WechatDiscoveryHit, type WechatDiscoveryResult, type WechatDiscoveryStory } from "../packages/backend/src/events/wechat-story-discovery.ts";

const story = (id = 1): WechatDiscoveryStory => ({ storyId: id, title: "抑郁症治疗迎来新进展", keyword: "抑郁症治疗迎来新进展", maxScore: 80, domestic: true,
  reports: [{ id: `paper-${id}`, title: "临床试验比较两种干预方案", url: "https://example.org/paper", sourceId: "paper-source", language: "zh" }] });
const hit = (over: Partial<WechatDiscoveryHit> = {}): WechatDiscoveryHit => ({ title: "标题", summary: null, accountName: "账号甲", postedAt: null,
  relativeTime: null, kind: null, url: null, known: null, ruleMatch: true, review: null, ...over });
const result = (storyId: number, hits: WechatDiscoveryHit[]): WechatDiscoveryResult => ({ storyId, title: "事件", keyword: "关键词", receiptId: storyId,
  reused: false, receiptCostUsd: null, newCostUsd: null, received: hits.length, hits });

test("WeChat keyword reuses lookupQuery cleaning, falls back to a Chinese report, and caps at sixteen characters", () => {
  assert.equal(wechatStoryKeyword({ title: "【前沿】研究速递｜睡眠不足改变青少年的情绪记忆：多中心研究证据", reports: [] }), "睡眠不足改变青少年的情绪记忆");
  assert.equal(wechatStoryKeyword({ title: "一二三四五六七八九十甲乙丙丁戊己庚辛", reports: [] }), "一二三四五六七八九十甲乙丙丁戊己");
  const s = story();
  assert.equal(wechatStoryKeyword({ title: "An English event", reports: [
    { ...s.reports[0], title: "An English report", language: "en" },
    { ...s.reports[0], title: "【综述】新研究揭示睡眠与情绪调节之间长期而复杂的联系", language: null },
  ] }), "新研究揭示睡眠与情绪调节之间长期");
  assert.equal([...wechatStoryKeyword({ title: "𠮷".repeat(30), reports: [] })].length, 16);
  assert.equal(wechatStoryKeyword({ title: "English event", reports: [{ ...s.reports[0], title: "English original", language: "zh" }] }), "English original");
});

test("WeChat rule match: report-title overlap of at least 0.3, or every Chinese fragment of the keyword", () => {
  const reports = [{ title: "甲乙丙丁戊己庚辛壬癸子" }];
  assert.equal(wechatRuleMatch("无关检索词", reports, "甲乙丙丁丑寅卯辰巳午未", null), true, "three shared bigrams out of ten on each side is exactly 0.3");
  assert.equal(wechatRuleMatch("无关检索词", reports, "甲乙其他标题", null), false);
  assert.equal(wechatRuleMatch("抑郁症 治疗", [], "抑郁症的新疗法", "药物治疗取得进展"), true);
  assert.equal(wechatRuleMatch("抑郁症 治疗", [], "抑郁症的新疗法", null), false, "one fragment missing");
  assert.equal(wechatRuleMatch("English only", [], "English only", null), false, "no Chinese fragment is not a match");
  assert.equal(wechatRuleMatch("睡眠记忆", [{ title: "" }], null, null), false);
});

test("WeChat hits keep missing fields as null, rank no account when the name is absent, and mark known accounts exactly", async () => {
  const saved: WechatDiscoveryResult[] = [];
  const rows = [
    { id: "a1", title: "抑郁症治疗迎来新进展", summary: "𠮷".repeat(210), account_name: "已收录号", posted_at: "2026-10-29T12:00:00Z", relative_time: "1天前", kind: "article",
      url: "https://mp.weixin.qq.com/s?signature=abc&timestamp=1" },
    { title: "抑郁症治疗迎来新进展" }, // The 10-18 shape: no account_name or posted_at.
    { title: "抑郁症治疗迎来新进展", account_name: "已收录号 ", posted_at: 1_761_000_000, summary: "" },
    { account_name: "停用号", url: "" },
    null, "text", 7,
  ];
  const known = new Map([["已收录号", "mp-known"], ["停用号", "mp-disabled"]]);
  const state = await runWechatDiscovery([story()], known, async () => ({ results: rows, receiptId: 5, reused: false, costUsd: 0.008 }), async (r) => { saved.push(r); });
  assert.deepEqual(state, { completed: 1, stopped: null });
  assert.equal(saved[0].received, 7);
  assert.equal(saved[0].hits.length, 4, "non-object rows are skipped");
  assert.deepEqual(saved[0].hits[0], { title: "抑郁症治疗迎来新进展", summary: "𠮷".repeat(200), accountName: "已收录号", postedAt: "2026-10-29T12:00:00Z",
    relativeTime: "1天前", kind: "article", url: "https://mp.weixin.qq.com/s?signature=abc&timestamp=1", known: "mp-known", ruleMatch: true, review: null });
  assert.deepEqual(saved[0].hits[1], { title: "抑郁症治疗迎来新进展", summary: null, accountName: null, postedAt: null, relativeTime: null,
    kind: null, url: null, known: null, ruleMatch: true, review: null });
  assert.equal(saved[0].hits[2].known, null, "a name that differs by a space is not the same account");
  assert.equal(saved[0].hits[2].postedAt, 1_761_000_000);
  assert.equal(saved[0].hits[2].summary, null);
  assert.deepEqual(saved[0].hits[3], { title: null, summary: null, accountName: "停用号", postedAt: null, relativeTime: null, kind: null, url: null,
    known: "mp-disabled", ruleMatch: false, review: null });
  assert.equal(saved[0].receiptCostUsd, 0.008);
  assert.equal(saved[0].newCostUsd, 0.008);
  assert.deepEqual(wechatFieldRates(saved), { hits: 4, rates: { title: 0.75, summary: 0.25, accountName: 0.75, postedAt: 0.5, relativeTime: 0.25, kind: 0.25, url: 0.25 } });
  assert.deepEqual(wechatFieldRates([]), { hits: 0, rates: { title: null, summary: null, accountName: null, postedAt: null, relativeTime: null, kind: null, url: null } });
});

test("WeChat account summary: a review overrides the rule, results are grouped by account and ordered by events covered", () => {
  const accounts = summarizeAccounts([
    result(1, [hit({ accountName: "甲", title: "甲1", known: "mp-a" }), hit({ accountName: "乙", title: "乙1" }), hit({ accountName: "丙", ruleMatch: false }),
      hit({ accountName: "丁", review: false }), hit({ accountName: null })]),
    result(2, [hit({ accountName: "甲", title: "甲2", postedAt: "2026-10-30" }), hit({ accountName: "甲", title: "甲2b" }), hit({ accountName: "丙", ruleMatch: false, review: true, title: "丙1" }),
      hit({ accountName: "丁", ruleMatch: false, review: false })]),
    result(3, [hit({ accountName: "甲", title: "甲3" }), hit({ accountName: "甲", title: "甲4" }), hit({ accountName: "乙", title: "乙2", known: "mp-b" })]),
  ]);
  assert.deepEqual(accounts.map((a) => [a.accountName, a.stories, a.hits]), [["甲", 3, 5], ["乙", 2, 2], ["丙", 1, 1]]);
  assert.equal(accounts[0].known, "mp-a");
  assert.equal(accounts[1].known, "mp-b", "known comes from any of the account's results");
  assert.equal(accounts[2].known, null);
  assert.deepEqual(accounts[0].samples, [{ title: "甲1", postedAt: null, storyId: 1 }, { title: "甲2", postedAt: "2026-10-30", storyId: 2 }, { title: "甲2b", postedAt: null, storyId: 2 }]);
  assert.deepEqual(summarizeAccounts([]), []);
});

test("WeChat account table is a Chinese Markdown table that escapes cell separators", () => {
  const table = accountsMarkdown([
    { accountName: "甲|号", stories: 2, hits: 3, known: "mp-a", samples: [{ title: "第一\n条", postedAt: null, storyId: 1 }, { title: null, postedAt: null, storyId: 2 }] },
    { accountName: "乙", stories: 1, hits: 1, known: null, samples: [{ title: "只有|一条", postedAt: null, storyId: 3 }] },
  ]);
  assert.deepEqual(table.trimEnd().split("\n"), [
    "| 公众号名 | 覆盖事件数 | 是否已是信源 | 样例标题 |", "| --- | --- | --- | --- |",
    "| 甲\\|号 | 2 | 是（mp-a） | 第一 条<br>（无标题） |", "| 乙 | 1 | 否 | 只有\\|一条 |",
  ]);
});

test("WeChat discovery allows at most twenty unique stories and validates all keywords before requesting", async () => {
  let calls = 0;
  const request = async () => { calls++; return { results: [], receiptId: calls, reused: false, costUsd: null }; };
  const run = (stories: WechatDiscoveryStory[]) => runWechatDiscovery(stories, new Map(), request, async () => {});
  for (const stories of [Array.from({ length: 21 }, (_, i) => story(i + 1)), [story(), story()], [story(0)],
    [story(), { ...story(2), keyword: " " }], [{ ...story(), keyword: "字".repeat(21) }]]) {
    await assert.rejects(run(stories), /20 unique|keyword/);
  }
  assert.equal(calls, 0);
  assert.equal((await run([{ ...story(), keyword: "字".repeat(20) }])).completed, 1, "a rewritten keyword may use all twenty characters");
  const state = await run(Array.from({ length: 20 }, (_, i) => story(i + 1)));
  assert.equal(calls, 21);
  assert.equal(state.completed, 20);
});

test("WeChat budget stop preserves completed evidence; unknown outcomes are never retried; bad envelopes are errors", async () => {
  let calls = 0;
  const saved: WechatDiscoveryResult[] = [];
  const state = await runWechatDiscovery([story(), story(2), story(3)], new Map(), async () => {
    if (++calls === 2) throw new BudgetExceededError("everyinfra:discovery", "day", 3600);
    return { results: [], receiptId: 1, reused: false, costUsd: 0.008 };
  }, async (r) => { saved.push(r); });
  assert.deepEqual(state, { completed: 1, stopped: "budget" });
  assert.equal(calls, 2);
  assert.equal(saved.length, 1);
  calls = 0;
  await assert.rejects(runWechatDiscovery([story(), story(2)], new Map(), async () => {
    calls++; throw new ReceiptUnknownError(12, "unknown outcome");
  }, async () => {}), ReceiptUnknownError);
  assert.equal(calls, 1);
  await assert.rejects(runWechatDiscovery([story()], new Map(), async () => ({ results: {}, receiptId: 13, reused: true, costUsd: null }), async () => {}), /results is not an array/);
});
