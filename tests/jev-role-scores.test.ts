import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { calculateRoleScores, runRoleScores, PROMPT_VERSIONS, scoreInputTime, type AnalyzeInputArticle } from "@aihot/backend/editorial/analyze";
import { JEV_ROLE_QUESTIONS, jevRoleValues } from "@aihot/backend/editorial/roles-jev";
import { modelFor, modelSources } from "@aihot/backend/editorial/models";
import { SELECTION } from "@aihot/industry/selection";
import { ROLE_KEYS } from "@aihot/contracts/taxonomy";
import { ProviderRejectedError } from "@aihot/backend/providers/receipts";
import { jevAnswers } from "./jev-fixture.ts";

const T = tag();
let sent: Record<string, any>[] = [];
let reject = false;
const provider = await stub((_hit, req) => {
  sent.push(JSON.parse(req.body));
  return reject ? new Reply(422, {}) : { model: "jev-1.14.0", answers: jevAnswers(), usage: { input_tokens: 10000, output_tokens: 0 } };
});
const originalEngine = SELECTION.industryRoles.engine;
before(() => {
  (SELECTION.industryRoles as { engine: string }).engine = "jev";
  config.allowPrivateNetworkFetch = true;
  process.env.TYPESAFE_BASE_URL = provider.url;
  process.env.TYPESAFE_API_KEY = "test-key";
});
after(async () => {
  (SELECTION.industryRoles as { engine: string }).engine = originalEngine;
  await provider.close();
  await closeDb();
});

test("Jev threshold boundaries include equality, use probabilities, and do not veto skip", () => {
  for (const role of ROLE_KEYS) {
    const v = jevRoleValues(jevAnswers());
    const threshold = SELECTION.industryRoles.jevThresholds[role];
    v.roles[role].pMust = threshold / 2;
    v.roles[role].pMaybe = 0;
    v.roles[role].pSkip = 1 - v.roles[role].pMust;
    v.roles[role].verdict = "skip";
    assert.equal(calculateRoleScores(v).roleScores[role], threshold);
    assert.ok(calculateRoleScores(v).selectedRoles.includes(role));
    v.roles[role].pMust -= 0.001;
    assert.ok(!calculateRoleScores(v).selectedRoles.includes(role));
  }
  const v = jevRoleValues(jevAnswers());
  v.roles.school.pMust = 0.33333; v.roles.school.pMaybe = 0.33333;
  assert.equal(calculateRoleScores(v).roleScores.school, 1);
  v.roles.school.pMust = 1; v.roles.school.pMaybe = 0;
  assert.equal(calculateRoleScores(v).roleScores.school, 2);
  v.roles.school.pMust = 0;
  assert.equal(calculateRoleScores(v).roleScores.school, 0);
});

test("Jev uses zero-based EV, rounds rel/nov for SQL, ranks primary and browses by unrounded relEv", () => {
  const a = jevAnswers();
  a.counselor_rel!.probabilities = { 0: 0.4, 1: 0.6, 2: 0, 3: 0 }; // 1.6 rounds to 2, but not browse
  a.operator_verdict!.probabilities = { must: 0.9, maybe: 0.1, skip: 0 };
  a.operator_verdict!.choice = "skip"; // verdict is argmax, not the returned label
  const v = jevRoleValues(a);
  assert.equal(v.roles.counselor.relEv, 1.6);
  assert.equal(v.roles.counselor.rel, 2);
  assert.equal(v.nov.score, 3);
  assert.equal(v.roles.operator.verdict, "must");
  assert.deepEqual(v.primary, ["operator", "psychiatry"]);
  assert.deepEqual(calculateRoleScores(v).browseRoles, ["operator", "psychiatry", "school"]);
  assert.deepEqual(v.cred, { score: 0, why: "" });
  for (const r of Object.values(v.roles)) assert.ok(Number.isInteger(r.rel) && r.act === 0 && r.why === "");
});

const article = (): AnalyzeInputArticle => ({
  id: `jev-${T}-${tag()}`, revision: 1, title: "原文标题", url: "https://example.com/jev", author: null,
  publishedAt: new Date("2026-11-16T01:02:03Z"), bodyText: "😀正文".repeat(2000), excerpt: "后备摘要", xPost: null, media: [],
  source: { name: "Must not reach state", kind: "rss", tier: "T1", firstParty: true, track: "industry" },
});
test("runRoleScores sends only the offline state/question set, saves pinned model, and reuses roleAttemptTag", async () => {
  const a = article();
  const r = await runRoleScores(a, { attemptTag: "rerun" });
  assert.deepEqual(sent.at(-1)!.state, { "标题": a.title, "发布时间": scoreInputTime(a.publishedAt!), "正文": [...a.bodyText!].slice(0, 4000).join("") });
  assert.equal(Object.keys(sent.at(-1)!.questions).length, 11);
  assert.deepEqual(sent.at(-1)!.questions, JEV_ROLE_QUESTIONS);
  assert.equal(r.model, "jev-1.14.0");
  assert.equal(r.values.engine, "jev");
  const count = sent.length;
  const reused = await runRoleScores(a, { attemptTag: "other", roleAttemptTag: "rerun" });
  assert.deepEqual([reused.receiptId, reused.reused, sent.length], [r.receiptId, true, count]);
  const [row] = await sql`SELECT request FROM receipts WHERE id=${r.receiptId}`;
  assert.equal(row.request.promptVersion, PROMPT_VERSIONS.roles);
  for (const bodyText of [null, "", "None"]) {
    await runRoleScores({ ...article(), bodyText });
    assert.equal(sent.at(-1)!.state["正文"], "后备摘要");
  }
  assert.match(JEV_ROLE_QUESTIONS.counselor_verdict!.instructions, /只按当前角色判断。\n这条消息对当前角色的结论。$/);
  assert.ok(!JEV_ROLE_QUESTIONS.nov!.instructions.includes("## 两层分数"));
});

test("Jev rejection fails the step without any LLM fallback", async () => {
  reject = true;
  const start = sent.length;
  try { await assert.rejects(runRoleScores(article()), ProviderRejectedError); }
  finally { reject = false; }
  assert.equal(sent.length, start + 1);
});

test("model metadata identifies Jev and ignores LLM overrides for scoreRoles only", async () => {
  process.env.SCORE_ROLES_MODEL = "deepseek-flash-think";
  assert.equal(await modelFor("scoreRoles"), "jev-1.14.0");
  assert.deepEqual((await modelSources()).scoreRoles, { model: "jev-1.14.0", source: "default" });
});
