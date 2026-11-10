// Role selection preserves the legacy quality score. Only the HTTP model boundary is stubbed.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle, calculateRoleScores, normalizeAnalysis, PROMPT_VERSIONS, RolesSchema, runAnalysis, type AnalyzeInputArticle } from "@aihot/backend/editorial/analyze";
import { CAPABILITIES, invalidateModelCache } from "@aihot/backend/editorial/models";
import { ModelOutputError } from "@aihot/backend/providers/llm";
import { ProviderRejectedError } from "@aihot/backend/providers/receipts";
import { FEATURES } from "@aihot/industry/features";
import { SELECTION } from "@aihot/industry/selection";
import { ROLE_KEYS, industryRoleScoringOn } from "@aihot/contracts/taxonomy";

const T = tag();
const SOURCE = `test-role-scores-${T}`;
const switches = FEATURES as unknown as { industryRoleScoring: boolean };
const originalSwitch = switches.industryRoleScoring;
const values = () => ({
  event: "正式规则改变执业流程", nov: { why: "新规则", score: 3 }, cred: { why: "正式文件", score: 3 },
  roles: Object.fromEntries(ROLE_KEYS.map((r) => [r, { why: "依据", rel: 1, act: 1, verdict: "skip" }])), primary: [] as unknown[],
});

test("role score formula, skip veto and every threshold boundary", () => {
  for (const role of ROLE_KEYS) {
    const v = values();
    const threshold = SELECTION.industryRoles.thresholds[role];
    // nov=3, verdict=maybe: score = rel + act + 6.
    v.roles[role] = { why: "边界", rel: 2, act: threshold - 8, verdict: "maybe" };
    const at = calculateRoleScores(RolesSchema.parse(v));
    assert.equal(at.roleScores[role], threshold);
    assert.deepEqual(at.selectedRoles, [role]);
    v.roles[role]!.act -= 1;
    assert.deepEqual(calculateRoleScores(RolesSchema.parse(v)).selectedRoles, []);
    v.roles[role] = { why: "skip 优先", rel: 4, act: 4, verdict: "skip" };
    v.nov.score = 4;
    assert.equal(calculateRoleScores(RolesSchema.parse(v)).roleScores[role], 12);
    assert.deepEqual(calculateRoleScores(RolesSchema.parse(v)).selectedRoles, []);
  }
  const v = values();
  v.roles.counselor = { why: "最高", rel: 4, act: 4, verdict: "must" };
  v.nov.score = 4;
  const scores = calculateRoleScores(RolesSchema.parse(v)).roleScores;
  assert.equal(scores.counselor, 18);
  assert.equal(scores.school, 6);
  v.nov.score = 1;
  assert.equal(calculateRoleScores(RolesSchema.parse(v)).roleScores.school, 3);
});

test("browse roles require rel >= 2, sort by score then ROLE_KEYS, and stop at three", () => {
  const v = values();
  for (const role of ROLE_KEYS) v.roles[role] = { why: "相关", rel: 2, act: 2, verdict: "maybe" };
  v.roles.operator!.act = 4;
  assert.deepEqual(calculateRoleScores(RolesSchema.parse(v)).browseRoles, ["operator", "counselor", "psychiatry"]);
  v.roles.operator!.rel = 1;
  assert.deepEqual(calculateRoleScores(RolesSchema.parse(v)).browseRoles, ["counselor", "psychiatry", "school"]);
});

test("schema drops invalid and excess primary roles; rejects missing roles and invalid scores", () => {
  const v = values();
  v.primary = ["bogus", 4, "school", "school", "counselor", "operator"];
  assert.deepEqual(RolesSchema.parse(v).primary, ["school", "counselor"]);
  for (const role of ROLE_KEYS) {
    const missing = values();
    delete missing.roles[role];
    assert.equal(RolesSchema.safeParse(missing).success, false);
  }
  for (const value of [0, 5, 2.5, "3"]) {
    for (const field of ["rel", "act"]) {
      const bad = values();
      Object.assign(bad.roles.counselor!, { [field]: value });
      assert.equal(RolesSchema.safeParse(bad).success, false);
    }
    for (const field of ["nov", "cred"] as const) {
      const bad = values();
      Object.assign(bad[field], { score: value });
      assert.equal(RolesSchema.safeParse(bad).success, false);
    }
  }
});

type Step = "prefilter" | "score" | "roles" | "dims" | "structure" | "understand" | "summarize";
interface Case {
  legacy: number[]; category: string | null; promotion: boolean; blocked: boolean; refused: boolean;
  roleValues: ReturnType<typeof values>; failuresLeft: number; rolesRejected?: boolean; calls: Array<{ step: Step; body: Record<string, any> }>; scoreIndex: number;
}
const cases = new Map<string, Case>();
const provider = await stub((hit, req) => {
  const body = JSON.parse(req.body) as Record<string, any>;
  const system = String(body.messages[0]?.content ?? "");
  const user = JSON.stringify(body.messages.at(-1)?.content);
  const state = [...cases].find(([marker]) => user.includes(marker))?.[1];
  if (!state) throw new Error("test request has no case marker");
  const step: Step = system.includes("业界内容评分器") ? "roles" : system.includes('"sig"') ? "dims"
    : system.includes("宽召回") ? "prefilter" : system.includes("事件注意力评分器") ? "score"
    : system.includes("资料结构化助手") ? "structure" : system.includes("内容理解编辑") ? "understand" : "summarize";
  state.calls.push({ step, body });
  const answer = (v: unknown) => ({ id: `roles-stub-${hit}`, choices: [{ message: { content: typeof v === "string" ? v : JSON.stringify(v) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  if (step === "prefilter") return answer({ label: state.blocked ? "BLOCK" : "PASS", reason: "测试" });
  if (step === "score") return state.refused ? new Reply(400, { error: { code: "1301", message: "contentFilter" } }) : answer({ attentionScore: state.legacy[state.scoreIndex++] });
  if (step === "structure") return answer({ category: state.category, tags: [], subjects: [], fact: null, promotion: state.promotion, roles: ["school"], impact: "rule" });
  if (step === "understand") return answer({ itemType: "research_finding", titleZh: "执业规则更新", summaryZh: "正式文件公布了具体执业流程。", editorialJudgment: "值得关注", tags: [] });
  if (step === "summarize") return answer("title_zh: 规则摘要\nsummary_zh: 正式文件公布了具体执业流程。");
  if (step === "dims") return answer({ event: "研究", contentType: "research_finding", ...Object.fromEntries(["sig", "nov", "cred", "reson", "act"].map((k) => [k, { score: 3, why: "依据" }])) });
  if (state.rolesRejected) return new Reply(400, { error: { code: "invalid_request", message: "bad request" } });
  const v = structuredClone(state.roleValues);
  if (state.failuresLeft-- > 0) delete v.roles.operator;
  return answer(v);
});
Object.assign(process.env, {
  LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "role-test-model", MODEL_CALLS_ENABLED: "true",
  LLM_JSON_MODE: "false", LLM_EXTRA_JSON: '{"thinking":{"type":"disabled"}}',
  PREFILTER_MODEL: "default", SCORE_MODEL: "default", STRUCTURE_MODEL: "default", UNDERSTAND_MODEL: "default", SUMMARIZE_MODEL: "default",
});
delete process.env.SCORE_ROLES_MODEL;
let budget: Array<{ per_minute: number; per_hour: number; per_day: number }> = [];
before(async () => {
  switches.industryRoleScoring = true;
  budget = await sql`SELECT per_minute, per_hour, per_day FROM budgets WHERE service='llm'`;
  await sql`UPDATE budgets SET per_minute=100000, per_hour=100000, per_day=100000 WHERE service='llm'`;
  await sql`INSERT INTO sources (id, name, kind, tier, track, participation_mode, next_fetch_at)
    VALUES (${SOURCE}, 'Role scores test', 'rss', 'T1', 'industry', 'editorial', '2100-01-01')`;
  invalidateModelCache();
});
after(async () => {
  switches.industryRoleScoring = originalSwitch;
  if (budget[0]) await sql`UPDATE budgets SET per_minute=${budget[0].per_minute}, per_hour=${budget[0].per_hour}, per_day=${budget[0].per_day} WHERE service='llm'`;
  await provider.close();
  await closeDb();
});

function makeCase(opts: Partial<Case> & { track?: string; thin?: boolean } = {}) {
  const marker = `ROLES_${T}_${cases.size}_END`;
  const state: Case = { legacy: [20, 21], category: "policy", promotion: false, blocked: false, refused: false, roleValues: values(), failuresLeft: 0, calls: [], scoreIndex: 0, ...opts };
  cases.set(marker, state);
  const article: AnalyzeInputArticle = {
    id: marker, revision: 1, title: `${marker} policy update`, url: `https://example.com/${marker}`, author: null,
    publishedAt: new Date(), bodyText: opts.thin ? null : `${marker} A professional body announces a new rule affecting mental health practice. `.repeat(4),
    excerpt: null, bodyStatus: "ok", xPost: null, media: [],
    source: { name: "Role scores test", kind: "rss", tier: "T1", firstParty: true, track: opts.track ?? "industry" },
  };
  return { article, state };
}
async function runCase(opts: Parameters<typeof makeCase>[0] = {}) {
  const { article, state } = makeCase(opts);
  const run = await runAnalysis(article);
  return { run, out: normalizeAnalysis(run), state };
}

test("low legacy quality can be selected by role and written as selected, keeping the old mean", async () => {
  const v = values();
  v.roles.counselor = { why: "执业变化", rel: 3, act: 2, verdict: "maybe" };
  const { run, out, state } = await runCase({ roleValues: v });
  assert.deepEqual([out.scoringPath, out.score, out.selected, out.roles, out.impact], ["roles", 20, true, ["counselor"], "rule"]);
  assert.deepEqual(out.scores, [20, 21]);
  assert.deepEqual(out.roleScoring?.selectedRoles, ["counselor"]);
  assert.equal(run.writing?.kind, "understand");
  const calls = state.calls.filter((c) => c.step === "roles");
  assert.equal(calls.length, 1);
  assert.equal(CAPABILITIES.scoreRoles.default, "default-think");
  assert.equal(CAPABILITIES.scoreRoles.env, "SCORE_ROLES_MODEL");
  assert.deepEqual([calls[0]!.body.thinking, calls[0]!.body.temperature, calls[0]!.body.max_tokens], [{ type: "enabled" }, 0.2, 8000]);
  assert.match(calls[0]!.body.messages.at(-1).content, /^请按系统规则评估以下单篇材料所代表的事件。只输出规定格式的 JSON。/);
});

test("high legacy score cannot select all-skip roles; legacy near writing still applies", async () => {
  const { out, run } = await runCase({ legacy: [95, 96] });
  assert.deepEqual([out.score, out.selected, out.roles, out.impact], [95, false, [], null]);
  assert.equal(run.writing?.kind, "understand");
});

test("academic, promotion, BLOCK, refused scores, title-only and selection-only never run roles", async () => {
  for (const opts of [{ category: "research", track: "academic" }, { promotion: true }, { blocked: true }, { thin: true }, { refused: true }]) {
    const { state } = await runCase(opts);
    assert.ok(!state.calls.some((c) => c.step === "roles"));
  }
  const { article, state } = makeCase();
  await runAnalysis(article, { stages: "selection" });
  assert.deepEqual(state.calls.map((c) => c.step), ["prefilter", "score", "score"]);
});

test("disabled performs the legacy path and sends no new output fields", async () => {
  switches.industryRoleScoring = false;
  try {
    assert.equal(industryRoleScoringOn(), false);
    const { out, run, state } = await runCase({ legacy: [80, 81] });
    assert.deepEqual([out.scoringPath, out.score, out.selected, out.roles, out.impact], ["legacy", 80, true, ["school"], "rule"]);
    assert.ok(!("roleScoring" in out) && !("roleScoring" in run));
    assert.ok(!state.calls.some((c) => c.step === "roles"));
  } finally { switches.industryRoleScoring = true; }
});

test("invalid roles retry once then fail without legacy fallback; corrected retry succeeds", async () => {
  const { article, state } = makeCase({ failuresLeft: 2 });
  await assert.rejects(runAnalysis(article), ModelOutputError);
  assert.equal(state.calls.filter((c) => c.step === "roles").length, 2);
  assert.ok(!state.calls.some((c) => c.step === "understand" || c.step === "summarize"));
  const fixed = await runCase({ failuresLeft: 1 });
  assert.equal(fixed.state.calls.filter((c) => c.step === "roles").length, 2);
  assert.equal(fixed.out.scoringPath, "roles");
});

test("analyzeArticle saves the role result and completed receipt, and reuses all receipts", async () => {
  const { article, state } = makeCase();
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: article.url, title: article.title, bodyText: article.bodyText!, bodyStatus: "ok", via: "fetch", publishedAt: article.publishedAt });
  const first = await analyzeArticle(articleId);
  const [saved] = await sql<{ output: Record<string, any>; score: number; receipt_ids: number[] }[]>`SELECT output, score, receipt_ids FROM analyses WHERE id=${first!.analysisId!}`;
  assert.equal(saved!.output.scoringPath, "roles");
  assert.equal(saved!.score, 20);
  assert.deepEqual(saved!.output.roleScoring.values, RolesSchema.parse(state.roleValues));
  assert.equal(saved!.output.roleScoring.model, "default-think");
  assert.equal(saved!.output.roleScoring.promptVersion, PROMPT_VERSIONS.roles);
  assert.ok(!("rerunTag" in saved!.output.roleScoring), "normal online scoring needs no rerun tag");
  const [receipt] = await sql<{ id: number; status: string }[]>`SELECT id, status FROM receipts WHERE subject=${`article:${articleId}@1`} AND purpose='score_roles'`;
  assert.equal(receipt!.status, "completed");
  assert.ok(saved!.receipt_ids.includes(receipt!.id));
  const count = state.calls.length;
  assert.equal((await analyzeArticle(articleId))!.reused, true);
  assert.equal(state.calls.length, count);
});

test("a non-retryable roles rejection is not retried", async () => {
  const { article, state } = makeCase({ rolesRejected: true });
  await assert.rejects(runAnalysis(article), ProviderRejectedError);
  assert.equal(state.calls.filter((c) => c.step === "roles").length, 1);
});
