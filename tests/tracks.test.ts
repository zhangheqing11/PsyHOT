// Academic and industry tracks, first batch (docs/plans/handoff-academic-industry-tracks.md): the
// industry categories showed as one 行业 until the switch was turned on; a source's track keeps its items'
// categories on its side; the industry's own promotions are listed in the full feed only.
import { stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle, tierThreshold } from "@aihot/backend/editorial/analyze";
import { categoryForSource } from "@aihot/backend/editorial/vocabulary";
import { groupArticle } from "@aihot/backend/events/group";
import { overrideFields } from "@aihot/backend/admin/content";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadPool } from "@aihot/backend/publication/pool";
import { v1Items } from "@aihot/backend/publication/v1";
import { itemFeed } from "@aihot/backend/publication/feeds";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { FEATURES } from "@aihot/industry/features";
import { SELECTION } from "@aihot/industry/selection";
import { CATEGORY_LABELS, CATEGORY_NAMES, categoryMembers, PUBLIC_API_CATEGORY_KEYS, toPublicApiCategory } from "@aihot/contracts/taxonomy";
import { tag } from "./setup.ts";

const T = tag();
const ACADEMIC = `test-tracks-academic-${T}`;
const INDUSTRY = `test-tracks-industry-${T}`;
const MIXED = `test-tracks-mixed-${T}`;

// What the structure step answers per marker: the category it picks and whether it calls it a promotion.
const STRUCTURE: Record<string, { category: string; promotion?: boolean }> = {
  PROMO: { category: "digital", promotion: true },
  JOURNALPOLICY: { category: "policy" },
  REGULATORSTUDY: { category: "research" },
  MIXEDPOLICY: { category: "policy" },
};
const steps: Array<{ step: string; marker: string; user: string }> = [];
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
  const system = body.messages[0]!.role === "system" ? String(body.messages[0]!.content) : "";
  const last = body.messages[body.messages.length - 1]!.content;
  const user = typeof last === "string" ? last : JSON.stringify(last);
  const marker = Object.keys(STRUCTURE).find((m) => user.includes(m)) ?? "";
  const step = system.includes("宽召回") ? "prefilter" : system.includes("事件注意力评分器") ? "score"
    : system.includes("内容理解编辑") ? "understand" : system.includes("资料结构化助手") ? "structure" : "summarize";
  steps.push({ step, marker, user });
  const answer = (content: unknown) => ({ id: `stub-${steps.length}`, model: "stub", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  if (step === "prefilter") return answer({ label: "PASS", reason: "测试" });
  if (step === "score") return answer({ attentionScore: 90 });
  if (step === "understand") return answer({ itemType: "policy_event", authorRole: "principal", tags: ["政策/监管"], editorialJudgment: `理由 ${marker}`, titleZh: `理解标题 ${marker}`, summaryZh: `理解摘要 ${marker}。第二句。` });
  if (step === "structure") {
    const s = STRUCTURE[marker]!;
    return answer({ category: s.category, tags: ["行业动态"], subjects: [], fact: { title: `事实 ${marker}`, subject: "某机构", action: "发布", object: "产品", occurredAt: null }, ...(s.promotion ? { promotion: true } : {}) });
  }
  return answer(`title_zh: 翻译标题 ${marker}\nsummary_zh: 翻译摘要 ${marker}。第二句补充影响。`);
});
for (const env of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[env] = `${provider.url}/v1`;
for (const env of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[env] = "test-key";

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, track, region, next_fetch_at) VALUES
    (${ACADEMIC}, 'Test journal', 'rss', 'T1', 'editorial', 'academic', 'international', '2100-01-01'),
    (${INDUSTRY}, 'Test regulator', 'rss', 'T1', 'editorial', 'industry', 'domestic', '2100-01-01'),
    (${MIXED}, 'Test news', 'rss', 'T1', 'editorial', 'mixed', 'international', '2100-01-01')`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

const LONG = "an organisation published something with enough detail to be judged on its own. ".repeat(8);
const article = async (sourceId: string, marker: string) =>
  (await upsertMaterial({
    sourceId, url: `https://example.com/${marker}-${T}`, title: `${marker} announcement ${T}`, bodyText: `${marker}: ${LONG} (${T})`,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(Date.now() - 3600_000),
  } as never)).articleId;
const publication = async (id: string) =>
  (await sql<{ category: string | null; selected: boolean; eligible: boolean; promotion: boolean; reason: string | null; fact_id: number | null }[]>`
    SELECT category, selected, eligible, promotion, reason, fact_id FROM publications WHERE article_id = ${id}`)[0]!;

test("with the switch on, every industry category shows, filters and exports as itself", () => {
  assert.equal(FEATURES.tracks, true);
  assert.deepEqual([...PUBLIC_API_CATEGORY_KEYS], ["research", "review", "clinical", "industry", "method", "opinion", "policy", "profession", "digital"]);
  assert.deepEqual(categoryMembers("industry"), ["industry"]);
  assert.deepEqual(categoryMembers("research"), ["research"]);
  for (const k of ["policy", "profession", "industry", "digital"] as const) {
    assert.equal(CATEGORY_LABELS[k], CATEGORY_NAMES[k]);
    assert.equal(toPublicApiCategory(k), k);
  }
  assert.equal(CATEGORY_NAMES.industry, "机构与市场");
  assert.equal(CATEGORY_NAMES.policy, "政策监管");
  assert.equal(toPublicApiCategory("opinion"), "opinion");
  assert.equal(toPublicApiCategory("nonsense"), null);
});

test("a one-track source's items stay on its side; a mixed source's take any category", () => {
  assert.equal(categoryForSource("policy", "academic"), "opinion");
  assert.equal(categoryForSource("research", "academic"), "research");
  assert.equal(categoryForSource("research", "industry"), "industry");
  assert.equal(categoryForSource("digital", "industry"), "digital");
  assert.equal(categoryForSource("policy", "mixed"), "policy");
  assert.equal(categoryForSource(null, "academic"), null);
});

test("thresholds per tier, overridden per track once calibrated", () => {
  assert.equal(tierThreshold("T2"), 76);
  assert.equal(tierThreshold("T2", "industry"), 76);
  assert.equal(tierThreshold("EXCLUDE_MP", "industry"), null);
  SELECTION.trackThresholds.industry!.T2 = 70;
  try {
    assert.equal(tierThreshold("T2", "industry"), 70);
    assert.equal(tierThreshold("T2", "academic"), 76);
  } finally {
    delete SELECTION.trackThresholds.industry!.T2;
  }
});

test("the structure step reads the source's track, and the category it picks is held to it", async () => {
  const journal = await article(ACADEMIC, "JOURNALPOLICY");
  const regulator = await article(INDUSTRY, "REGULATORSTUDY");
  const news = await article(MIXED, "MIXEDPOLICY");
  for (const id of [journal, regulator, news]) await analyzeArticle(id);
  const structureInput = (m: string) => steps.find((s) => s.step === "structure" && s.marker === m)!.user;
  assert.match(structureInput("JOURNALPOLICY"), /视角：学界信源；可选类别：research、review、clinical、method、opinion/);
  assert.match(structureInput("REGULATORSTUDY"), /视角：业界信源；可选类别：industry、policy、profession、digital/);
  assert.doesNotMatch(structureInput("MIXEDPOLICY"), /可选类别/);
  const category = async (id: string) => (await sql<{ category: string }[]>`SELECT category FROM analyses WHERE article_id = ${id} ORDER BY id DESC LIMIT 1`)[0]!.category;
  assert.equal(await category(journal), "opinion");
  assert.equal(await category(regulator), "industry");
  assert.equal(await category(news), "policy");
  // Stored, shown and filtered as itself now that the switch is on.
  await publishArticle(journal);
  await publishArticle(regulator);
  await publishArticle(news);
  assert.equal((await publication(news)).category, "policy");
  // Selected (two scores of 90), so it is listed once its release gate opens.
  const now = new Date(Date.now() + 3600_000);
  const pool = await loadPool({ channel: "all", category: "policy", tag: null, now });
  assert.ok(pool.items.some((i) => i.id === news && i.category === "policy"));
  const institutions = await loadPool({ channel: "all", category: "industry", tag: null, now });
  assert.ok(!institutions.items.some((i) => i.id === news), "机构与市场 no longer stands for the whole industry track");
  const domesticIndustry = await loadPool({ channel: "all", category: null, track: "industry", region: "domestic", tag: null, now });
  assert.ok(domesticIndustry.items.some((i) => i.id === regulator));
  assert.ok(!domesticIndustry.items.some((i) => i.id === news), "international mixed source is excluded from domestic industry");
  const internationalAcademic = await loadPool({ channel: "all", category: null, track: "academic", region: "international", tag: null, now });
  assert.ok(internationalAcademic.items.some((i) => i.id === journal));
  assert.ok(!internationalAcademic.items.some((i) => i.id === regulator));
  const categoryWins = await loadPool({ channel: "all", category: "industry", track: "academic", tag: null, now });
  assert.ok(categoryWins.items.some((i) => i.id === regulator), "category takes precedence over a conflicting track");
});

test("a promotion: scored but never selected, written the cheap way, in the full feed only", async () => {
  const id = await article(MIXED, "PROMO");
  const result = await analyzeArticle(id);
  assert.equal(result?.output?.promotion, true);
  assert.equal(result?.output?.selected, false, "two scores of 90 do not select a promotion");
  const promoSteps = steps.filter((s) => s.marker === "PROMO").map((s) => s.step);
  assert.ok(promoSteps.includes("summarize") && !promoSteps.includes("understand"), promoSteps.join());
  const [an] = await sql<{ category: string; reason_zh: string | null; output: Record<string, unknown> }[]>`
    SELECT category, reason_zh, output FROM analyses WHERE article_id = ${id} ORDER BY id DESC LIMIT 1`;
  assert.equal(an!.category, "industry", "filed under the industry's institutions and market");
  assert.equal(an!.reason_zh, null);
  assert.equal(an!.output.promotion, true);
  assert.equal(an!.output.fact, null);

  await groupArticle(id);
  const p = await publication(id);
  assert.deepEqual({ eligible: p.eligible, selected: p.selected, promotion: p.promotion, fact: p.fact_id }, { eligible: true, selected: false, promotion: true, fact: null });

  // The site's full feed lists it with its mark; the outside exits leave it out.
  const pool = await loadPool({ channel: "all", category: null, tag: null });
  assert.equal(pool.items.find((i) => i.id === id)?.promotion, true);
  const v1 = await v1Items({ mode: "all", window: "24h", by: "timeline", category: null, q: null, limit: 100, cursor: null });
  assert.ok(!v1.items.some((i) => i.id === id), "v1 / MCP / Agent");
  assert.ok(!(await itemFeed("all", null)).includes(id), "RSS");

  // An override of `selected` does not select it; taking back the promotion mark does.
  const version = (await sql<{ version: number }[]>`SELECT version FROM editorial_overrides WHERE article_id = ${id}`)[0]?.version ?? 0;
  await overrideFields(id, { fields: { selected: true }, reason: "测试", version }, "test");
  assert.equal((await publication(id)).selected, false);
  await overrideFields(id, { fields: { promotion: false }, reason: "测试", version: version + 1 }, "test");
  const back = await publication(id);
  assert.equal(back.promotion, false);
  assert.equal(back.selected, true);
});

test("labels: the weekly batch queues promotions, blocks and near-threshold scores; labels export as gold", async () => {
  const { exportGold, labelOf, listLabels, setLabel, weeklyReviewBatch } = await import("@aihot/backend/admin/labels");
  const promo = (await sql<{ id: string }[]>`SELECT a.id FROM articles a WHERE a.source_id = ${MIXED} AND a.title LIKE 'PROMO%'`)[0]!.id;
  // A near-threshold item and a blocked one, as stored judgements (no model calls).
  const near = await article(INDUSTRY, "NEARSCORE");
  const blocked = await article(ACADEMIC, "BLOCKEDONE");
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, score, selected, output) VALUES
    (${near}, 1, 'rule', 'pass', 'policy', 58, false, ${sql.json({ threshold: 60 })}),
    (${blocked}, 1, 'rule', 'block', NULL, NULL, false, ${sql.json({ prefilter: { label: "BLOCK", reason: "无关" } })})`;
  // Promotion was un-marked by an override above; its analysis still says promotion.
  const { queued } = await weeklyReviewBatch({ perKind: 50 });
  assert.ok(queued >= 3);
  const queues = Object.fromEntries((await sql<{ article_id: string; queue: string }[]>`
    SELECT article_id, queue FROM selection_labels WHERE article_id IN ${sql([promo, near, blocked])}`).map((r) => [r.article_id, r.queue]));
  assert.deepEqual(queues, { [promo]: "promotion", [near]: "near_threshold", [blocked]: "blocked" });
  assert.equal((await weeklyReviewBatch({ perKind: 50 })).queued, 0, "already queued items are not queued again");

  const pending = await listLabels({ track: "industry" });
  assert.ok(pending.rows.some((r) => r.id === near && r.track === "industry"));
  await setLabel(near, { decision: "select", note: "新规" }, "test");
  await setLabel(blocked, { decision: "reject" }, "test");
  const nearLabel = await labelOf(near);
  assert.ok(nearLabel?.context?.material?.bodyOriginal?.includes("NEARSCORE"));
  assert.ok((nearLabel?.version ?? 0) > 1);
  await sql`UPDATE articles SET title = 'changed after label snapshot' WHERE id = ${near}`;
  assert.equal((await labelOf(near))?.context.material.title, nearLabel?.context.material.title);
  const blockedLabel = await labelOf(blocked);
  assert.ok(blockedLabel);
  const concurrent = await Promise.allSettled([
    setLabel(blocked, { decision: "either", version: blockedLabel!.version }, "admin:a"),
    setLabel(blocked, { decision: "select", version: blockedLabel!.version }, "admin:b"),
  ]);
  assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((r) => r.status === "rejected").length, 1);
  const manual = await article(MIXED, "MANUALLABEL");
  await setLabel(manual, { decision: "either" }, "test");
  assert.equal((await labelOf(manual))?.queue, "manual");
  await setLabel(manual, { decision: null }, "test");
  assert.equal((await labelOf(manual))?.decision, null);

  assert.equal(await exportGold({ decision: "unlabeled" }), "");
  const lines = (await exportGold()).trim().split("\n").map((l) => JSON.parse(l));
  const nearCase = lines.find((l) => l.caseId === near);
  assert.equal(nearCase.gold.decision, "select");
  assert.equal(nearCase.sourceFacts.track, "industry");
  assert.equal(nearCase.sourceFacts.sourceTier, "T1");
  assert.match(nearCase.material.bodyOriginal, /NEARSCORE/);
  assert.equal(nearCase.samplingContext.samplingStratum, "industry/near_threshold");
  assert.ok(["development", "holdout"].includes(nearCase.samplingContext.benchmarkSplit));
  assert.equal(lines.find((l) => l.caseId === blocked).sourceFacts.track, "academic", "a blocked item takes its source's track");
  assert.ok(!lines.some((l) => l.caseId === manual), "a label taken back is not exported");
});
