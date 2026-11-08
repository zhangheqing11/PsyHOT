// Exercise receipt reuse and republishing with a local stub at the HTTP model boundary.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle, loadAnalyzeInput, PROMPT_VERSIONS, runRoleScores } from "@aihot/backend/editorial/analyze";
import { invalidateModelCache } from "@aihot/backend/editorial/models";
import { completeReceipt } from "@aihot/backend/providers/receipts";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { FEATURES } from "@aihot/industry/features";
import { ROLE_KEYS } from "@aihot/contracts/taxonomy";
import { fillRoleReasons } from "../scripts/fill-role-reasons.ts";

const T = tag();
const SOURCE = `test-fill-reasons-${T}`;
const switches = FEATURES as unknown as { industryRoleScoring: boolean };
const was = switches.industryRoleScoring;
type Step = "prefilter" | "score" | "structure" | "roles" | "understand" | "summarize";
const cases = new Map<string, { calls: Step[]; emptyReason?: boolean; invalidWriting?: boolean }>();
const roleValues = {
  event: "正式规则改变执业流程", nov: { why: "新规则", score: 3 }, cred: { why: "正式文件", score: 3 },
  roles: Object.fromEntries(ROLE_KEYS.map((role) => [role, role === "counselor"
    ? { why: "执业变化", rel: 3, act: 2, verdict: "maybe" }
    : { why: "关联有限", rel: 1, act: 1, verdict: "skip" }])), primary: ["counselor"],
};
const provider = await stub((hit, req) => {
  const body = JSON.parse(req.body);
  const system = String(body.messages[0]?.content ?? "");
  const user = JSON.stringify(body.messages.at(-1)?.content);
  const state = [...cases].find(([marker]) => user.includes(marker))?.[1];
  assert.ok(state, "test request has a case marker");
  const step: Step = system.includes("业界内容评分器") ? "roles" : system.includes("宽召回") ? "prefilter"
    : system.includes("事件注意力评分器") ? "score" : system.includes("资料结构化助手") ? "structure"
    : system.includes("内容理解编辑") ? "understand" : "summarize";
  state.calls.push(step);
  const answers = {
    prefilter: { label: "PASS", reason: "测试" }, score: { attentionScore: 20 }, roles: roleValues,
    structure: { category: "policy", tags: [], subjects: [], fact: null, promotion: false, roles: ["counselor"], impact: "rule" },
    understand: state.invalidWriting ? {} : { itemType: "research_finding", titleZh: "执业规则更新", summaryZh: "正式文件公布了具体执业流程。", editorialJudgment: state.emptyReason ? " " : "咨询师需要按新规调整执业流程。", tags: [] },
    summarize: "title_zh: 规则摘要\nsummary_zh: 正式文件公布了具体执业流程。",
  };
  return { id: `fill-stub-${hit}`, choices: [{ message: { content: typeof answers[step] === "string" ? answers[step] : JSON.stringify(answers[step]) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
});
Object.assign(process.env, {
  LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "fill-test-model", MODEL_CALLS_ENABLED: "true",
  LLM_JSON_MODE: "false", LLM_EXTRA_JSON: '{"thinking":{"type":"disabled"}}',
  PREFILTER_MODEL: "default", SCORE_MODEL: "default", STRUCTURE_MODEL: "default", SCORE_ROLES_MODEL: "default-think",
  UNDERSTAND_MODEL: "default", SUMMARIZE_MODEL: "default",
});
let budget: Array<{ per_minute: number; per_hour: number; per_day: number }> = [];
before(async () => {
  switches.industryRoleScoring = true;
  budget = await sql`SELECT per_minute, per_hour, per_day FROM budgets WHERE service='llm'`;
  await sql`UPDATE budgets SET per_minute=100000, per_hour=100000, per_day=100000 WHERE service='llm'`;
  await sql`INSERT INTO sources (id, name, kind, tier, track, participation_mode, next_fetch_at)
    VALUES (${SOURCE}, 'Fill reasons test', 'rss', 'T1', 'industry', 'editorial', '2100-01-01')`;
  invalidateModelCache();
});
after(async () => {
  switches.industryRoleScoring = was;
  if (budget[0]) await sql`UPDATE budgets SET per_minute=${budget[0].per_minute}, per_hour=${budget[0].per_hour}, per_day=${budget[0].per_day} WHERE service='llm'`;
  await provider.close();
  await stopBoss();
  await closeDb();
});

async function summarizedArticle() {
  const marker = `FILL_${T}_${cases.size}_END`;
  const state: { calls: Step[]; emptyReason?: boolean; invalidWriting?: boolean } = { calls: [] };
  cases.set(marker, state);
  const { articleId: id } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${marker}`, title: `${marker} policy update`,
    bodyText: `${marker} A professional body announces a new rule affecting mental health practice. `.repeat(4),
    bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  switches.industryRoleScoring = false;
  let analysis;
  try { analysis = await analyzeArticle(id); }
  finally { switches.industryRoleScoring = true; }
  const input = await loadAnalyzeInput(id);
  assert.ok(input && analysis?.analysisId);
  return { id, input, analysisId: analysis.analysisId, state };
}

test("roleAttemptTag reuses the rerun receipt and original steps while writing understand copy", async () => {
  const item = await summarizedArticle();
  const roles = await runRoleScores(item.input, { attemptTag: "t1" });
  const reused = await runRoleScores(item.input, { attemptTag: "another-run", roleAttemptTag: "t1" });
  assert.equal(reused.receiptId, roles.receiptId);
  assert.equal(reused.reused, true);
  const previousCalls = [...item.state.calls];
  const result = await analyzeArticle(item.id, { roleAttemptTag: "t1" });
  const [saved] = await sql<{ output: { writer: string }; reason_zh: string; receipt_ids: number[] }[]>`
    SELECT output, reason_zh, receipt_ids FROM analyses WHERE id=${result!.analysisId!}`;
  assert.ok(saved.receipt_ids.includes(roles.receiptId), "the role receipt ID is reused");
  assert.deepEqual(item.state.calls, [...previousCalls, "understand"], "only writing makes a new request");
  assert.equal(saved.output.writer, "understand");
  assert.equal(saved.reason_zh, "咨询师需要按新规调整执业流程。");
});

async function rerunSelectedArticle() {
  const item = await summarizedArticle();
  const roles = await runRoleScores(item.input, { attemptTag: "t1" });
  await sql.begin(async (tx) => {
    await tx`UPDATE analyses SET selected=true, receipt_ids=array_append(receipt_ids, ${roles.receiptId}), output=output || ${tx.json({
      roleScoring: { values: roles.values, roleScores: roles.roleScores, selectedRoles: roles.selectedRoles, model: roles.model, promptVersion: PROMPT_VERSIONS.roles, rerunTag: "t1" },
      roles: roles.browseRoles, impact: "rule", scoringPath: "roles",
    })} WHERE id=${item.analysisId}`;
    await completeReceipt(tx, roles.receiptId);
  });
  await publishArticle(item.id, { releasedAt: new Date(Date.now() - 1000) });
  return item;
}

test("fills one selected publication without changing roles or counting historical paid attempts", async () => {
  const item = await rerunSelectedArticle();
  const [previous] = await sql`SELECT selected_roles, category FROM publications WHERE article_id=${item.id}`;
  assert.deepEqual(previous.selected_roles, ["counselor"]);
  await sql`UPDATE receipt_attempts SET cost=123, usage='{"prompt_tokens":1000,"completion_tokens":500}'::jsonb
    WHERE receipt_id IN (SELECT id FROM receipts WHERE subject=${`article:${item.id}@1`})`;
  const previousCalls = [...item.state.calls];
  const picks = [...await sql`SELECT * FROM industry_hot_picks ORDER BY article_id`];
  const report = await fillRoleReasons(["--limit", "1", "--concurrency", "1"]);
  assert.ok("processed" in report);
  assert.equal(report.processed, 1);
  assert.equal(report.failed, 0);
  assert.deepEqual(report.changed, []);
  assert.equal(report.stillMissing, 0);
  assert.deepEqual(report.usage, { attempts: 1, cost: null, tokens_in: 10, tokens_out: 5 });
  const [current] = await sql`SELECT p.selected_roles, p.category, p.reason, an.output->>'writer' AS writer
    FROM publications p JOIN analyses an ON an.id=p.analysis_id WHERE p.article_id=${item.id}`;
  assert.deepEqual(current.selected_roles, previous.selected_roles);
  assert.equal(current.category, previous.category);
  assert.equal(current.writer, "understand");
  assert.equal(current.reason, "咨询师需要按新规调整执业流程。");
  assert.deepEqual(item.state.calls, [...previousCalls, "understand"]);
  assert.deepEqual([...await sql`SELECT * FROM industry_hot_picks ORDER BY article_id`], picks);
});

test("reports an empty reason as changed without rolling back the new publication", async () => {
  const item = await rerunSelectedArticle();
  item.state.emptyReason = true;
  const report = await fillRoleReasons(["--concurrency", "1"]);
  assert.ok("processed" in report);
  assert.equal(report.processed, 1);
  assert.equal(report.failed, 0);
  assert.equal(report.stillMissing, 1);
  assert.equal(report.changed.length, 1);
  assert.equal(report.changed[0].id, item.id);
  assert.deepEqual(report.changed[0].before, { selectedRoles: ["counselor"], category: "policy", writer: "summarize", reason: null });
  assert.deepEqual(report.changed[0].after, { selectedRoles: ["counselor"], category: "policy", writer: "understand", reason: null });
  const [current] = await sql`SELECT analysis_id FROM publications WHERE article_id=${item.id}`;
  assert.notEqual(current.analysis_id, item.analysisId);
});

test("reports changed published category and roles without rolling back", async () => {
  const item = await rerunSelectedArticle();
  await sql`INSERT INTO editorial_overrides (article_id, fields) VALUES (${item.id}, '{"category":"research"}'::jsonb)`;
  const report = await fillRoleReasons(["--concurrency", "1"]);
  assert.ok("processed" in report);
  assert.equal(report.processed, 1);
  assert.equal(report.failed, 0);
  assert.equal(report.changed.length, 1);
  const change = report.changed[0];
  assert.equal(change.id, item.id);
  assert.deepEqual(change.before.selectedRoles, ["counselor"]);
  assert.equal(change.before.category, "policy");
  assert.deepEqual(change.after.selectedRoles, []);
  assert.equal(change.after.category, "research");
  const [current] = await sql`SELECT selected_roles, category FROM publications WHERE article_id=${item.id}`;
  assert.deepEqual(current.selected_roles, change.after.selectedRoles);
  assert.equal(current.category, change.after.category);
});

test("a failed item leaves its publication unchanged and does not stop another item", async () => {
  const bad = await rerunSelectedArticle();
  const good = await rerunSelectedArticle();
  bad.state.invalidWriting = true;
  try {
    const report = await fillRoleReasons(["--concurrency", "2"]);
    assert.ok("processed" in report);
    assert.equal(report.processed, 1);
    assert.equal(report.failed, 1);
    assert.deepEqual(report.changed, []);
    assert.equal(report.stillMissing, 1);
    assert.equal(report.usage.attempts, 2, "failed paid attempts are counted too");
    const [current] = await sql`SELECT analysis_id, reason FROM publications WHERE article_id=${bad.id}`;
    assert.equal(current.analysis_id, bad.analysisId);
    assert.equal(current.reason, null);
    const [filled] = await sql`SELECT reason FROM publications WHERE article_id=${good.id}`;
    assert.ok(filled.reason);
  } finally {
    await sql`UPDATE publications SET selected=false WHERE article_id=${bad.id}`;
  }
});

test("dry-run uses the published analysis, validates options, and leaves all data unchanged", async () => {
  for (const [key, value] of [["limit", "0"], ["limit", "1.5"], ["concurrency", "-1"], ["concurrency", "9007199254740992"]]) {
    await assert.rejects(fillRoleReasons(["--dry-run", `--${key}`, value]), new RegExp(`--${key}`));
  }
  const kinds = ["candidate", "candidate-newer", "understand", "not-selected", "no-roles", "no-tag", "empty-tag", "old-prompt", "stale"];
  const ids: string[] = [];
  try {
    for (const [index, kind] of kinds.entries()) {
      const { articleId: id } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/fill-dry-${T}-${kind}`, title: `Fill dry ${T} ${kind}`,
        bodyText: `${kind} ${T} `.repeat(40), bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
      ids.push(id);
      await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
        VALUES (${id}, 1, 'rule', 'pass', 'policy', '中文标题', '中文摘要', 20, ${kind !== "not-selected"}, ${sql.json({
          writer: kind === "understand" ? "understand" : "summarize", roles: ["counselor"], impact: "rule",
          roleScoring: { selectedRoles: kind === "no-roles" ? [] : ["counselor"], promptVersion: kind === "old-prompt" ? "old" : PROMPT_VERSIONS.roles,
            ...(kind === "no-tag" ? {} : { rerunTag: kind === "empty-tag" ? " " : "t1" }) },
        })})`;
      await publishArticle(id, { releasedAt: new Date(Date.now() - 1000) });
      await sql`UPDATE articles SET discovered_at=now() - make_interval(days => ${kinds.length - index}) WHERE id=${id}`;
      if (kind === "stale") await sql`UPDATE articles SET revision=revision+1 WHERE id=${id}`;
    }
    // An unpublished newer analysis must not replace the publication's candidate evidence.
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, output)
      VALUES (${ids[0]}, 1, 'rule', 'pass', 'policy', '{"writer":"understand"}'::jsonb)`;
    const snapshot = async () => ({
      articles: [...await sql`SELECT * FROM articles WHERE id=ANY(${ids}::text[]) ORDER BY id`],
      analyses: [...await sql`SELECT * FROM analyses WHERE article_id=ANY(${ids}::text[]) ORDER BY id`],
      publications: [...await sql`SELECT * FROM publications WHERE article_id=ANY(${ids}::text[]) ORDER BY article_id`],
      receipts: [...await sql`SELECT * FROM receipts ORDER BY id`],
      attempts: [...await sql`SELECT * FROM receipt_attempts ORDER BY id`],
      picks: [...await sql`SELECT * FROM industry_hot_picks ORDER BY article_id`],
      ledger: [...await sql`SELECT * FROM selected_ledger ORDER BY seq`],
    });
    const previous = await snapshot();
    const hits = provider.hits();
    const report = await fillRoleReasons(["--dry-run"]);
    assert.deepEqual(report, { total: 2, ids: [ids[1], ids[0]], dryRun: true });
    assert.deepEqual(await fillRoleReasons(["--dry-run", "--limit", "1"]), { total: 2, ids: [ids[1]], dryRun: true });
    assert.deepEqual(await snapshot(), previous);
    assert.equal(provider.hits(), hits);
  } finally {
    await sql`UPDATE publications SET selected=false WHERE article_id=ANY(${ids}::text[])`;
  }
});

test("closed feature refuses both dry-run and apply before doing work", async () => {
  switches.industryRoleScoring = false;
  try {
    await assert.rejects(fillRoleReasons(["--dry-run"]), /FEATURES.industryRoleScoring/);
    await assert.rejects(fillRoleReasons([]), /FEATURES.industryRoleScoring/);
  } finally { switches.industryRoleScoring = true; }
});
