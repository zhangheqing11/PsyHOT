// Exercise only the read-only dry-run path. No role model or real rerun is invoked.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { SELECTION } from "@aihot/industry/selection";
import { ROLE_KEYS } from "@aihot/contracts/taxonomy";
import { invalidateModelCache } from "@aihot/backend/editorial/models";
import { jevAnswers } from "./jev-fixture.ts";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { FEATURES } from "@aihot/industry/features";
import { PROMPT_VERSIONS } from "@aihot/backend/editorial/analyze";
import { rerunRoleScores } from "../scripts/rerun-role-scores.ts";

const T = tag();
const SOURCE = `test-rerun-scores-${T}`;
// Candidate selection excludes future discoveries; host and database clocks may differ slightly.
const DISCOVERED_AT = new Date(Date.now() - 60_000);
const switches = FEATURES as unknown as { industryRoleScoring: boolean };
const was = switches.industryRoleScoring;
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, track, participation_mode, next_fetch_at)
    VALUES (${SOURCE}, 'Role rerun test', 'rss', 'T1', 'industry', 'editorial', '2100-01-01')`;
});
after(async () => { switches.industryRoleScoring = was; await stopBoss(); await closeDb(); });

test("closed feature refuses dry-run before doing work", async () => {
  switches.industryRoleScoring = false;
  await assert.rejects(rerunRoleScores(["--dry-run"]), /FEATURES.industryRoleScoring/);
});

test("dry-run validates arguments and leaves analysis, publication, receipts and hot picks unchanged", async () => {
  switches.industryRoleScoring = true;
  for (const [key, value] of [["days", "0"], ["limit", "1.5"], ["concurrency", "-1"], ["tag", " "]]) {
    await assert.rejects(rerunRoleScores(["--dry-run", `--${key}`, value]), new RegExp(`--${key}`));
  }
  const ids: string[] = [];
  for (const kind of ["industry", "academic", "promotion", "hidden", "old"]) {
    const { articleId: id } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/rerun-${T}-${kind}`, title: `Rerun ${T} ${kind}`,
      bodyText: `${kind} ${T} `.repeat(40), bodyStatus: "ok", via: "fetch", publishedAt: DISCOVERED_AT, discoveredAt: DISCOVERED_AT });
    ids.push(id);
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
      VALUES (${id}, 1, 'rule', 'pass', ${kind === "academic" ? "research" : "policy"}, '中文标题', '中文摘要', 90, true,
        ${sql.json({ promotion: kind === "promotion", writer: "summarize", untouched: T })})`;
    await publishArticle(id, { releasedAt: new Date(Date.now() - 1000) });
    if (kind === "hidden") await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${id}`;
    if (kind === "old") await sql`UPDATE articles SET discovered_at=now() - interval '29 days' WHERE id=${id}`;
  }
  const snapshot = async () => ({
    analyses: [...await sql`SELECT id, output, selected, receipt_ids FROM analyses WHERE article_id=ANY(${ids}::text[]) ORDER BY id`],
    publications: [...await sql`SELECT article_id, revision, selected, selected_roles, hot_pick FROM publications WHERE article_id=ANY(${ids}::text[]) ORDER BY article_id`],
    receipts: [...await sql`SELECT id, status FROM receipts ORDER BY id`],
    picks: [...await sql`SELECT * FROM industry_hot_picks ORDER BY article_id`],
  });
  const before = await snapshot();
  const report = await rerunRoleScores(["--dry-run", "--days", "28", "--concurrency", "3", "--tag", "role-scores-2026-11"]);
  assert.ok("ids" in report && report.ids.includes(ids[0]));
  if ("ids" in report) assert.ok(ids.slice(1).every((id) => !report.ids.includes(id)));
  assert.deepEqual(await snapshot(), before);
  const limited = await rerunRoleScores(["--dry-run", "--limit", "1"]);
  assert.ok("ids" in limited && limited.ids.length === 1);
});

test("dry-run selects only missing or outdated prompt versions, regardless of rerun tag", async () => {
  switches.industryRoleScoring = true;
  const cases = [
    { name: "online-current", promptVersion: PROMPT_VERSIONS.roles, rerun: false },
    { name: "rerun-current-other-tag", promptVersion: PROMPT_VERSIONS.roles, rerunTag: "another-tag", rerun: false },
    { name: "rerun-current-same-tag", promptVersion: PROMPT_VERSIONS.roles, rerunTag: "role-scores-2026-11", rerun: false },
    { name: "rerun-old-same-tag", promptVersion: "old-version", rerunTag: "role-scores-2026-11", rerun: true },
    { name: "online-old", promptVersion: "old-version", rerun: true },
    { name: "missing-version", rerunTag: "role-scores-2026-11", rerun: true },
    { name: "unscored", rerun: true },
  ];
  const checked: Array<{ id: string; name: string; rerun: boolean }> = [];
  for (const c of cases) {
    const { articleId: id } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/rerun-version-${T}-${c.name}`, title: `Version ${T} ${c.name}`,
      bodyText: `${c.name} ${T} `.repeat(40), bodyStatus: "ok", via: "fetch", publishedAt: DISCOVERED_AT, discoveredAt: DISCOVERED_AT });
    const roleScoring = c.name === "unscored" ? null : {
      ...(c.promptVersion ? { promptVersion: c.promptVersion } : {}), ...(c.rerunTag ? { rerunTag: c.rerunTag } : {}),
    };
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
      VALUES (${id}, 1, 'rule', 'pass', 'policy', '中文标题', '中文摘要', 40, false, ${sql.json({ roleScoring })})`;
    await publishArticle(id);
    checked.push({ id, name: c.name, rerun: c.rerun });
  }
  const report = await rerunRoleScores(["--dry-run"]);
  assert.ok("ids" in report);
  for (const c of checked) assert.equal(report.ids.includes(c.id), c.rerun, c.name);
});


test("apply reruns the configured engine, stores model/receipt and republishes selected roles", async () => {
  switches.industryRoleScoring = true;
  config.allowPrivateNetworkFetch = true;
  const local = await stub((_hit, req) => {
    const body = JSON.parse(req.body);
    if (body.questions) return { model: "jev-1.14.0", answers: jevAnswers(), usage: { input_tokens: 1000, output_tokens: 0 } };
    const values = { event: "规则", nov: { score: 3, why: "新规则" }, cred: { score: 3, why: "文件" }, primary: [],
      roles: Object.fromEntries(ROLE_KEYS.map((role) => [role, { rel: 3, act: 3, verdict: "must", why: "依据" }])) };
    return { choices: [{ message: { content: JSON.stringify(values) } }], usage: { prompt_tokens: 1000, completion_tokens: 10 } };
  });
  Object.assign(process.env, { TYPESAFE_BASE_URL: local.url, TYPESAFE_API_KEY: "test-key",
    LLM_BASE_URL: local.url, LLM_API_KEY: "test-key", LLM_MODEL: "rerun-test", SCORE_ROLES_MODEL: "default-think" });
  invalidateModelCache();
  try {
    const at = new Date(Date.now() - 1000);
    const { articleId: id } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/rerun-apply-${T}`, title: `Rerun apply ${T}`,
      bodyText: "A professional body published new practice rules. ".repeat(20), bodyStatus: "ok", via: "fetch", publishedAt: at, discoveredAt: at });
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
      VALUES (${id}, 1, 'rule', 'pass', 'policy', '规则', '新规则', 40, false, '{}')`;
    await publishArticle(id);
    const report = await rerunRoleScores(["--limit", "1", "--concurrency", "1", "--tag", `apply-${T}`]);
    assert.ok("processed" in report && report.processed === 1 && report.failed === 0);
    const [row] = await sql`SELECT an.output, p.selected_roles, r.model, r.service, r.status
      FROM analyses an JOIN publications p ON p.analysis_id=an.id
      JOIN receipts r ON r.id=ANY(an.receipt_ids) AND r.purpose='score_roles' WHERE an.article_id=${id}`;
    assert.ok(row, "the intended candidate was rerun");
    assert.deepEqual(row.selected_roles, [...ROLE_KEYS]);
    assert.equal(row.status, "completed");
    assert.equal(row.output.roleScoring.promptVersion, PROMPT_VERSIONS.roles);
    assert.equal(row.output.roleScoring.model, SELECTION.industryRoles.engine === "jev" ? "jev-1.14.0" : "default-think");
    assert.equal(row.service, SELECTION.industryRoles.engine === "jev" ? "typesafe" : "llm");
  } finally { await local.close(); }
});
