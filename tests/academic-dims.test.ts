// The academic second stage: real analysis orchestration and receipts, with only the model HTTP
// boundary stubbed. Legacy scores stay available while the final score controls selection and copy.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle, normalizeAnalysis, runAnalysis, type AnalyzeInputArticle } from "@aihot/backend/editorial/analyze";
import { CAPABILITIES, invalidateModelCache, modelFor } from "@aihot/backend/editorial/models";
import { promptText } from "@aihot/backend/editorial/prompts";
import { MODELS, ModelOutputError } from "@aihot/backend/providers/llm";
import { SELECTION } from "@aihot/industry/selection";

const T = tag();
const SOURCE = `test-academic-dims-${T}`;
const AXES = ["sig", "nov", "cred", "reson", "act"] as const;
type Step = "prefilter" | "score" | "dims" | "structure" | "understand" | "summarize";
interface Case {
  legacy: number[];
  values: number[];
  category: string | null;
  promotion: boolean;
  refused: boolean;
  malformed: "missing" | "range" | "fraction" | "string" | null;
  failuresLeft: number;
  why: string;
  calls: Array<{ step: Step; body: Record<string, any> }>;
  scoreIndex: number;
}
const cases = new Map<string, Case>();
const provider = await stub((hit, req) => {
  const body = JSON.parse(req.body) as Record<string, any>;
  const system = body.messages[0]?.role === "system" ? String(body.messages[0].content) : "";
  const user = JSON.stringify(body.messages.at(-1)?.content);
  const state = [...cases].find(([marker]) => user.includes(marker))?.[1];
  if (!state) throw new Error("test request has no case marker");
  const step: Step = system.includes('"sig"') && system.includes('"nov"') ? "dims"
    : system.includes("宽召回") ? "prefilter" : system.includes("事件注意力评分器") ? "score"
    : system.includes("资料结构化助手") ? "structure" : system.includes("内容理解编辑") ? "understand" : "summarize";
  state.calls.push({ step, body });
  const answer = (content: unknown) => ({ id: `dims-stub-${hit}`, choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  if (step === "prefilter") return answer({ label: "PASS", reason: "测试" });
  if (step === "score") {
    if (state.refused) return new Reply(400, { error: { code: "1301", message: "contentFilter" } });
    return answer({ attentionScore: state.legacy[state.scoreIndex++] });
  }
  if (step === "structure") return answer({ category: state.category, tags: [], subjects: [], fact: null, promotion: state.promotion });
  if (step === "understand") return answer({ itemType: "research_finding", titleZh: "研究结果", summaryZh: "一项心理学研究报告了行为变化。", editorialJudgment: "值得关注", tags: [] });
  if (step === "summarize") return answer("title_zh: 研究摘要\nsummary_zh: 一项研究报告了行为变化。");
  const dims: Record<string, any> = { event: "研究报告行为变化", contentType: "research_finding" };
  AXES.forEach((axis, i) => { dims[axis] = { score: state.values[i], why: state.why }; });
  if (state.failuresLeft-- > 0) {
    if (state.malformed === "missing") delete dims.act;
    if (state.malformed === "range") dims.sig.score = 5;
    if (state.malformed === "fraction") dims.sig.score = 2.5;
    if (state.malformed === "string") dims.sig.score = "3";
  }
  return answer(dims);
});
Object.assign(process.env, {
  LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "dims-test-model",
  LLM_EXTRA_JSON: '{"thinking":{"type":"disabled"}}', LLM_JSON_MODE: "false", MODEL_CALLS_ENABLED: "true",
  PREFILTER_MODEL: "default", SCORE_MODEL: "default", STRUCTURE_MODEL: "default", UNDERSTAND_MODEL: "default", SUMMARIZE_MODEL: "default",
});
delete process.env.SCORE_DIMS_MODEL;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.DEEPSEEK_BASE_URL;
let budget: Array<{ per_minute: number; per_hour: number; per_day: number }> = [];
before(async () => {
  budget = await sql`SELECT per_minute, per_hour, per_day FROM budgets WHERE service='llm'`;
  await sql`UPDATE budgets SET per_minute=100000, per_hour=100000, per_day=100000 WHERE service='llm'`;
  await sql`INSERT INTO sources (id, name, kind, tier, track, participation_mode, next_fetch_at)
    VALUES (${SOURCE}, 'Academic dims test', 'rss', 'T1', 'academic', 'editorial', '2100-01-01')`;
  invalidateModelCache();
});
after(async () => {
  if (budget[0]) await sql`UPDATE budgets SET per_minute=${budget[0].per_minute}, per_hour=${budget[0].per_hour}, per_day=${budget[0].per_day} WHERE service='llm'`;
  await provider.close();
  await closeDb();
});

function makeCase(opts: Partial<Pick<Case, "legacy" | "values" | "category" | "promotion" | "refused" | "malformed" | "failuresLeft" | "why">> & { tier?: string; track?: string } = {}) {
  const marker = `DIMS_${T}_${cases.size}_END`;
  const state: Case = { legacy: [40, 40], values: [3, 3, 3, 3, 2], category: "research", promotion: false, refused: false, malformed: null, failuresLeft: 0, why: "依据", calls: [], scoreIndex: 0, ...opts };
  cases.set(marker, state);
  const article: AnalyzeInputArticle = {
    id: marker, revision: 1, title: `${marker} research findings`, url: `https://example.com/${marker}`, author: null,
    publishedAt: new Date("2026-10-28T01:02:03Z"), bodyText: `${marker} Researchers report psychological and behavioural changes in a longitudinal study. `.repeat(4),
    excerpt: null, bodyStatus: "ok", xPost: null, media: [],
    source: { name: "Academic dims test", kind: "rss", tier: opts.tier ?? "T1", firstParty: true, track: opts.track ?? "academic" },
  };
  return { article, state };
}
async function runCase(opts: Parameters<typeof makeCase>[0] = {}) {
  const { article, state } = makeCase(opts);
  const run = await runAnalysis(article);
  return { run, out: normalizeAnalysis(run), state };
}
const dimsCalls = (state: Case) => state.calls.filter((c) => c.step === "dims");

test("selection-dims renders byte-for-byte like the frozen offline V3 prompt", () => {
  const fixed = readFileSync(new URL("./fixtures/selection-v3.md", import.meta.url), "utf8");
  assert.equal(promptText("selection-dims"), fixed);
});

test("scoreDims defaults to LLM credentials with thinking enabled and 8000 tokens", async () => {
  assert.equal(CAPABILITIES.scoreDims.default, "default-think");
  assert.equal(CAPABILITIES.scoreDims.env, "SCORE_DIMS_MODEL");
  assert.equal(await modelFor("scoreDims"), "default-think");
  assert.equal(MODELS["default-think"]!.baseUrlEnv, "LLM_BASE_URL");
  const { run, state } = await runCase();
  const body = dimsCalls(state)[0]!.body;
  assert.deepEqual([body.model, body.thinking, body.max_tokens, body.temperature, body.response_format],
    ["dims-test-model", { type: "enabled" }, 8000, 0.2, { type: "json_object" }]);
  assert.equal(run.dims?.model, "default-think");
  assert.match(body.messages.at(-1).content, /^请按系统规则评估以下单篇材料所代表的事件。只输出规定格式的 JSON。/);
});

for (const [tier, values, score, selected, threshold] of [
  ["T1", [3, 3, 3, 3, 2], 60, true, 60],
  ["T1", [3, 3, 3, 2, 2], 53, false, 60],
  ["T1_5", [3, 3, 3, 3, 3], 67, true, 65],
  ["T2", [3, 3, 3, 3, 3], 67, true, 67],
  ["T2", [3, 3, 3, 3, 2], 60, false, 67],
] as const) {
  test(`${tier}: sum ${values.reduce((a, b) => a + b, 0)} displays ${score}, selected=${selected}`, async () => {
    const { out, state } = await runCase({ tier, values: [...values] });
    assert.deepEqual([out.scoringPath, out.score, out.selected, out.threshold], ["dims", score, selected, threshold]);
    assert.deepEqual(out.scores, [40, 40], "the two legacy scores remain intact");
    assert.equal(out.dimsSum, values.reduce((a, b) => a + b, 0));
    assert.equal(out.gate, 30);
    assert.equal(dimsCalls(state).length, 1);
  });
}

test("gate 30 uses the exact first-stage mean; 28 skips the second stage", async () => {
  const below = await runCase({ legacy: [27, 29] });
  assert.deepEqual([below.out.scoringPath, below.out.score, below.out.selected, below.out.threshold], ["legacy", 28, false, 60]);
  assert.equal(dimsCalls(below.state).length, 0);
  const edge = await runCase({ legacy: [29, 31] });
  assert.equal(edge.out.scoringPath, "dims");
});

test("industry items retain the old score, threshold, selection and writing", async () => {
  const { out, state } = await runCase({ track: "industry", category: "policy", tier: "T2", legacy: [80, 70] });
  assert.deepEqual([out.scoringPath, out.score, out.threshold, out.selected], ["legacy", 75, 76, false]);
  assert.equal(dimsCalls(state).length, 0);
  assert.ok(state.calls.some((c) => c.step === "understand"));
});

test("the category resolves a mixed source's academic track; a null category uses its source", async () => {
  const mixed = await runCase({ track: "mixed", category: "research" });
  assert.equal(mixed.out.scoringPath, "dims");
  const fallback = await runCase({ category: null });
  assert.equal(fallback.out.scoringPath, "dims");
});

test("disabled restores legacy selection and the half-point writing boundary", async () => {
  const was = SELECTION.academicDims.enabled;
  SELECTION.academicDims.enabled = false;
  try {
    for (const track of ["academic", "industry"]) {
      const r = await runCase({ track, legacy: [80, 70] });
      assert.deepEqual([r.out.scoringPath, r.out.score, r.out.selected, r.out.threshold], ["legacy", 75, true, 60]);
      assert.equal(dimsCalls(r.state).length, 0);
    }
    const half = await runCase({ legacy: [50, 51] });
    assert.equal(half.out.score, 50);
    assert.ok(half.state.calls.some((c) => c.step === "understand"), "the legacy mean 50.5 is above understandFloor");
  } finally {
    SELECTION.academicDims.enabled = was;
  }
});

test("promotions and a refused first-stage score never call dimensions", async () => {
  const promo = await runCase({ promotion: true, legacy: [90, 90] });
  assert.deepEqual([promo.out.scoringPath, promo.out.selected], ["legacy", false]);
  assert.equal(dimsCalls(promo.state).length, 0);
  assert.ok(promo.state.calls.some((c) => c.step === "summarize"));
  const refused = await runCase({ refused: true });
  assert.deepEqual([refused.out.scoringPath, refused.out.score, refused.out.selected], ["legacy", null, false]);
  assert.equal(dimsCalls(refused.state).length, 0);
});

test("copy uses the final score: a high legacy score with dimensions sum 12 is summarized", async () => {
  const { out, state } = await runCase({ legacy: [90, 90], values: [3, 3, 2, 2, 2] });
  assert.deepEqual([out.score, out.selected], [47, false]);
  assert.ok(state.calls.some((c) => c.step === "summarize"));
  assert.ok(!state.calls.some((c) => c.step === "understand"));
});

test("dimensions reasons are clipped to 200 characters", async () => {
  const { out } = await runCase({ why: "据".repeat(250) });
  for (const axis of AXES) assert.equal(out.dims!.why[axis], "据".repeat(200));
});

for (const malformed of ["missing", "range", "fraction", "string"] as const) {
  test(`invalid dimensions (${malformed}) retry once then throw without legacy fallback`, async () => {
    const { article, state } = makeCase({ malformed, failuresLeft: 2 });
    await assert.rejects(runAnalysis(article), ModelOutputError);
    assert.equal(dimsCalls(state).length, 2);
    assert.ok(!state.calls.some((c) => c.step === "understand" || c.step === "summarize"));
  });
}

test("a corrected second response succeeds through the existing receipt retry", async () => {
  const { out, state } = await runCase({ malformed: "missing", failuresLeft: 1 });
  assert.deepEqual([out.scoringPath, out.score, out.selected], ["dims", 60, true]);
  assert.equal(dimsCalls(state).length, 2);
});

test("SelectBench's selection-only path still stops after the two old scores", async () => {
  const { article, state } = makeCase({ legacy: [80, 70] });
  const run = await runAnalysis(article, { stages: "selection" });
  assert.deepEqual([run.scores!.values, run.structure, run.writing, run.dims ?? null], [[80, 70], null, null, null]);
  assert.deepEqual(state.calls.map((c) => c.step), ["prefilter", "score", "score"]);
});

test("analyzeArticle stores the final score, dimensions, legacy scores and completed dims receipt", async () => {
  const { article, state } = makeCase();
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: article.url, title: article.title, bodyText: article.bodyText!, bodyStatus: "ok", via: "fetch", publishedAt: article.publishedAt });
  const first = await analyzeArticle(articleId);
  const [saved] = await sql<{ score: number; selected: boolean; output: Record<string, any>; receipt_ids: number[] }[]>`SELECT score, selected, output, receipt_ids FROM analyses WHERE id=${first!.analysisId!}`;
  assert.deepEqual([saved!.score, saved!.selected, saved!.output.scoringPath, saved!.output.threshold], [60, true, "dims", 60]);
  assert.deepEqual(saved!.output.scores, [40, 40]);
  assert.deepEqual(AXES.map((a) => saved!.output.dims[a]), [3, 3, 3, 3, 2]);
  assert.deepEqual([saved!.output.dimsSum, saved!.output.dimsModel, saved!.output.gate], [14, "default-think", 30]);
  const [receipt] = await sql<{ id: number; status: string }[]>`SELECT id, status FROM receipts WHERE subject=${`article:${articleId}@1`} AND purpose='score_dims'`;
  assert.equal(receipt!.status, "completed");
  assert.ok(saved!.receipt_ids.includes(receipt!.id));
  const count = state.calls.length;
  const again = await analyzeArticle(articleId);
  assert.equal(again!.reused, true);
  assert.equal(state.calls.length, count, "the dimensions receipt is reused with all other steps");
});
