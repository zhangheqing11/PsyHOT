// Throwaway database and local HTTP stub only; all frozen plans/results live under .data/.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { DISCOVERY_POOL } from "@aihot/backend/providers/everyinfra";
import { logicalKeyFor } from "@aihot/backend/providers/receipts";
import { selectXhsProbeStories, xhsStoryKeyword, type XhsProbeStory } from "../packages/backend/src/events/xhs-story-probe.ts";

const T = tag();
await mkdir(join(REPO_ROOT, ".data"), { recursive: true });
const dir = await mkdtemp(join(REPO_ROOT, ".data", "xhs-story-probe-test-"));
let mode: "normal" | "failed" | "unknown" = "normal";
const requests: Array<{ platform: string; action: string; params: Record<string, unknown> }> = [];
const provider = await stub((hit, req) => {
  requests.push(JSON.parse(req.body));
  if (mode === "failed") return new Reply(503, { error: "local test refusal" });
  if (mode === "unknown") return null; // Unusable 200 after sending: the standard receipt becomes unknown.
  const id = hit.toString(16).padStart(24, "0");
  return { id: `xhs-probe-${T}-${hit}`, billing: { charged_usd: 0.0056 }, results: [
    { id, url: `https://www.xiaohongshu.com/explore/${id}?xsec_token=secret`, title: "睡眠记忆的研究", text: "青少年的睡眠与记忆",
      author_name: "作者", author_id: "author123", posted_at: "2026-10-29T12:00:00Z", like_count: 3, collect_count: 4, comment_count: 5, is_goods_note: true },
  ] };
});
const cli = async (...args: string[]) => promisify(execFile)(process.execPath, ["scripts/probe-xhs-story-lookup.ts", ...args], {
  env: { ...process.env, EVERYINFRA_BASE_URL: provider.url, EVERYINFRA_API_KEY: "test-key", ALLOW_PRIVATE_NETWORK_FETCH: "true",
    AIHOT_CREDENTIALS_DIR: "/nonexistent-test-credentials", COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false" }, timeout: 30_000,
});
const budgets = await sql`SELECT * FROM budgets WHERE service IN ('everyinfra', 'everyinfra:discovery')`;
await sql`UPDATE budgets SET per_minute = 10000, per_hour = 10000, per_day = 10000 WHERE service IN ('everyinfra', 'everyinfra:discovery')`;
after(async () => {
  for (const b of budgets) await sql`UPDATE budgets SET per_minute = ${b.per_minute}, per_hour = ${b.per_hour}, per_day = ${b.per_day} WHERE service = ${b.service}`;
  await provider.close(); await closeDb(); await rm(dir, { recursive: true, force: true });
});

async function fixture(t: TestContext) {
  const source = `xhs-probe-paper-${tag()}`;
  const storyIds: number[] = [];
  const articleIds: string[] = [];
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode) VALUES (${source}, 'Probe reports', 'external', 'T1', 'editorial')`;
  t.after(async () => {
    mode = "normal";
    await sql`DELETE FROM receipts WHERE purpose = 'xhs_story_probe' AND subject = ANY(${storyIds.map((id) => `story:${id}`)}::text[])`;
    await sql`DELETE FROM story_signals WHERE story_id = ANY(${storyIds}::bigint[])`;
    await sql`DELETE FROM facts WHERE story_id = ANY(${storyIds}::bigint[])`;
    await sql`DELETE FROM stories WHERE id = ANY(${storyIds}::bigint[])`;
    await sql`DELETE FROM articles WHERE id = ANY(${articleIds}::text[])`;
    await sql`DELETE FROM sources WHERE id = ${source}`;
  });
  return async (opts: { at?: Date; latestAt?: Date; title?: string; reportTitle?: string; language?: string | null; score?: number; selected?: boolean;
    visibility?: string; eligible?: boolean; visibleAfter?: Date; mergedInto?: number; duplicateOf?: string } = {}): Promise<XhsProbeStory> => {
    const at = opts.at ?? new Date();
    const [s] = await sql`INSERT INTO stories (public_id, title, latest_at, merged_into)
      VALUES (${randomUUID()}, ${opts.title ?? "睡眠记忆的研究"}, ${opts.latestAt ?? at}, ${opts.mergedInto ?? null}) RETURNING id, title`;
    storyIds.push(s!.id);
    const id = `probe-${tag()}`;
    articleIds.push(id);
    const title = opts.reportTitle ?? "睡眠与记忆的中文报道";
    const url = `https://example.org/${id}`;
    const language = opts.language === undefined ? "zh" : opts.language;
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, language, discovered_at, timeline_at, duplicate_of)
      VALUES (${id}, ${source}, ${`url:${url}`}, ${url}, ${title}, ${language}, ${at}, ${at}, ${opts.duplicateOf ?? null})`;
    await sql`INSERT INTO publications (article_id, visibility, eligible, selected, title, score, source_id, channel, url, discovered_at, timeline_at, sort_at, visible_after)
      VALUES (${id}, ${opts.visibility ?? "public"}, ${opts.eligible ?? true}, ${opts.selected ?? false}, '翻译后的中文标题', ${opts.score ?? 80},
        ${source}, 'news', ${url}, ${at}, ${at}, ${at}, ${opts.visibleAfter ?? at})`;
    const [fact] = await sql`INSERT INTO facts (public_id, story_id, title) VALUES (${id}, ${s!.id}, 'Probe fact') RETURNING id`;
    await sql`INSERT INTO fact_articles (fact_id, article_id) VALUES (${fact!.id}, ${id})`;
    const reports = [{ id, title, url, language }];
    return { storyId: s!.id, title: s!.title, maxScore: opts.score ?? 80, xhsParticipants: 0, reports, keyword: xhsStoryKeyword({ title: s!.title, reports }) };
  };
}

const counts = async () => (await sql`SELECT (SELECT count(*) FROM articles) AS articles, (SELECT count(*) FROM story_signals) AS signals,
  (SELECT count(*) FROM publications) AS publications, (SELECT count(*) FROM analyses) AS analyses,
  (SELECT jsonb_object_agg(processing_state, n) FROM (SELECT processing_state, count(*) AS n FROM articles GROUP BY processing_state) states) AS processing`)[0];
const planId = (plan: unknown) => createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 24);
const logicalKey = (s: XhsProbeStory, window: string) => logicalKeyFor({ service: "everyinfra", purpose: "xhs_story_probe",
  identity: { platform: "xiaohongshu", action: "search", params: { keyword: s.keyword, sort: "newest", date_range: "last_7_days" }, window } });
async function frozenPlan(name: string, stories: XhsProbeStory[]) {
  const path = join(dir, `${name}.json`);
  const plan = { version: 1, at: new Date().toISOString(), search: { sort: "newest", date_range: "last_7_days" }, stories };
  await writeFile(path, JSON.stringify(plan));
  return { path, plan, id: planId(plan) };
}
const report = async (path: string) => JSON.parse(await readFile(`${path}.results.json`, "utf8"));

test("XHS selection is read-only, recent, unmerged, public, qualified and Chinese; highest fifteen win", async (t) => {
  const add = await fixture(t);
  const at = new Date("2040-01-15T12:00:00Z"); // A separate snapshot from other invariant-test rows.
  const boundary = await add({ at, score: 50, language: "en" }); // Han title also qualifies.
  const selected = await add({ at, score: 20, selected: true, reportTitle: "English original", language: "zh", title: "English event" });
  const english = await add({ at, score: 90, language: "en", reportTitle: "English primary report", title: "English event with a Chinese report" });
  const chinese = await add({ at, score: 20, eligible: false });
  await sql`INSERT INTO fact_articles (fact_id, article_id) SELECT id, ${chinese.reports[0].id} FROM facts WHERE story_id = ${english.storyId}`;
  await add({ at, score: 49 });
  await add({ at, latestAt: new Date(at.getTime() - 7 * 86400_000) });
  await add({ at, latestAt: new Date(at.getTime() + 1) });
  await add({ at, mergedInto: boundary.storyId });
  await add({ at, language: "en", reportTitle: "English original", title: "中文事件不能替代中文报道" });
  await add({ at, visibility: "withdrawn", score: 99 });
  await add({ at, eligible: false, score: 99 });
  await add({ at, selected: true, visibleAfter: new Date(at.getTime() + 1), score: 99 });
  await add({ at, duplicateOf: boundary.reports[0].id, score: 99 });
  await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
    VALUES (${boundary.storyId}, ${boundary.reports[0].id}, 'xhs-author:test', 'xhs-old-keyword', 'signal', ${at})`;
  const before = await counts();
  const sample = await sql.begin("isolation level repeatable read read only", (tx) => selectXhsProbeStories(tx, at));
  assert.deepEqual(sample.map((s) => s.storyId), [english.storyId, boundary.storyId, selected.storyId]);
  assert.equal(sample[0].keyword, chinese.reports[0].title, "qualification and Chinese evidence may come from different reports");
  assert.equal(sample[1].xhsParticipants, 1);
  assert.deepEqual(sample[1].reports, boundary.reports);
  assert.equal(sample[2].keyword, "English original", "language=zh is the explicit alternative to Han characters");
  assert.deepEqual(await counts(), before);
  const higher: XhsProbeStory[] = [];
  for (let i = 0; i < 18; i++) higher.push(await add({ at, score: 60 + i }));
  const capped = await selectXhsProbeStories(sql, at);
  assert.deepEqual(capped.map((s) => s.storyId), [english.storyId, ...higher.slice(4).reverse().map((s) => s.storyId)]);
});

test("XHS CLI creates or previews a frozen plan without paying and requires an existing .data plan for --run", async (t) => {
  const add = await fixture(t);
  await add();
  const path = join(dir, "generated.json");
  const hits = provider.hits();
  const before = await counts();
  await cli("--plan", path);
  const saved = await readFile(path, "utf8");
  const plan = JSON.parse(saved);
  assert.ok(plan.stories.length > 0 && plan.stories.length <= 15);
  assert.ok(plan.stories.every((s: XhsProbeStory) => s.reports.length > 0 && s.keyword === xhsStoryKeyword(s)));
  await cli("--plan", path);
  assert.equal(await readFile(path, "utf8"), saved);
  assert.equal(provider.hits(), hits);
  assert.deepEqual(await counts(), before);
  await assert.rejects(cli("--plan", join(dir, "missing.json"), "--run"), /ENOENT/);
  await assert.rejects(cli("--plan", join(REPO_ROOT, "outside-probe.json")), /\.data/);
  await symlink(join(REPO_ROOT, "docs"), join(dir, "escape"));
  await assert.rejects(cli("--plan", join(dir, "escape", "plan.json")), /\.data/);
  assert.equal(provider.hits(), hits);
});

test("XHS full --run uses discovery receipts, replays at the cap, and preserves progress on budget stop", async (t) => {
  const add = await fixture(t);
  const first = await add();
  const second = await add({ title: "青少年睡眠不足影响学习" });
  const { path, id } = await frozenPlan("replay", [first, second]);
  const before = await counts();
  const hits = provider.hits();
  // Admit only the first new call, then exhaust this pool during the same run.
  const [usage] = await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE pool = ${DISCOVERY_POOL} AND origin = 'live' AND started_at > now() - interval '1 day'`;
  await sql`UPDATE budgets SET per_day = ${usage!.n + 1} WHERE service = ${DISCOVERY_POOL}`;
  await cli("--plan", path, "--run");
  let saved = await report(path);
  assert.deepEqual(saved.state, { completed: 1, stopped: "budget" });
  assert.equal(saved.results.length, 1);
  assert.equal(saved.results[0].samples[0].isGoodsNote, true);
  assert.equal(saved.results[0].samples[0].review, null);
  assert.equal(provider.hits(), hits + 1);
  await sql`UPDATE budgets SET per_day = 10000 WHERE service = ${DISCOVERY_POOL}`;
  await cli("--plan", path, "--run");
  saved = await report(path);
  assert.deepEqual(saved.state, { completed: 2, stopped: null });
  assert.deepEqual(saved.results.map((r: { reused: boolean }) => r.reused), [true, false]);
  assert.equal(provider.hits(), hits + 2);
  const attempts = await sql`SELECT r.subject, ra.pool FROM receipt_attempts ra JOIN receipts r ON r.id = ra.receipt_id
    WHERE r.logical_key = ANY(${[first, second].map((s) => logicalKey(s, id))}::text[])`;
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every((r) => r.pool === DISCOVERY_POOL));
  assert.deepEqual(attempts.map((r) => r.subject).sort(), [first, second].map((s) => `story:${s.storyId}`).sort());
  assert.deepEqual(requests.at(-1), { platform: "xiaohongshu", action: "search", params: { keyword: second.keyword, sort: "newest", date_range: "last_7_days" } });
  // Failed attempts count even though the two successful answers remain reusable at the cap.
  const [receipt] = await sql`SELECT id FROM receipts WHERE logical_key = ${logicalKey(first, id)}`;
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, pool, status)
    SELECT ${receipt!.id}, n, 'everyinfra', ${DISCOVERY_POOL}, 'failed' FROM generate_series(2, 14) n`;
  await sql`UPDATE receipts SET attempts = 14 WHERE id = ${receipt!.id}`;
  await cli("--plan", path, "--run");
  saved = await report(path);
  assert.ok(saved.results.every((r: { reused: boolean; receiptCostUsd: number; newCostUsd: number }) => r.reused && r.receiptCostUsd === 0.0056 && r.newCostUsd === 0));
  assert.equal(provider.hits(), hits + 2);
  assert.deepEqual(await counts(), before, "no materials, signals, publications, analyses or processing work");
  assert.ok(!(await readdir(dir)).some((name) => name.includes(".tmp")), "results replace atomically without leftover temporary files");
});

test("XHS lifetime cap counts failed attempts, including the fifteenth real local request", async (t) => {
  const add = await fixture(t);
  const s = await add();
  const { path, id } = await frozenPlan("cap", [s]);
  const [receipt] = await sql`INSERT INTO receipts (logical_key, service, purpose, subject, status, attempts)
    VALUES (${logicalKey(s, id)}, 'everyinfra', 'xhs_story_probe', ${`story:${s.storyId}`}, 'failed', 14) RETURNING id`;
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, pool, status)
    SELECT ${receipt!.id}, n, 'everyinfra', ${DISCOVERY_POOL}, 'failed' FROM generate_series(1, 14) n`;
  const hits = provider.hits();
  mode = "failed";
  await assert.rejects(cli("--plan", path, "--run"), /HTTP 503/);
  assert.equal(provider.hits(), hits + 1);
  assert.equal((await report(path)).results.length, 0);
  await cli("--plan", path, "--run");
  assert.deepEqual((await report(path)).state, { completed: 0, stopped: "budget" });
  assert.equal(provider.hits(), hits + 1, "no sixteenth attempt");
  const [usage] = await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id = ${receipt!.id}`;
  assert.equal(usage!.n, 15);
});

test("XHS CLI refuses concurrent copies of a plan and never resends an unknown receipt", async (t) => {
  const add = await fixture(t);
  const s = await add();
  const { path, id } = await frozenPlan("unknown", [s]);
  const hits = provider.hits();
  const lock = await sql.reserve();
  try {
    await lock`SELECT pg_advisory_lock(hashtext(${`xhs-probe:${id}`}))`;
    await assert.rejects(cli("--plan", path, "--run"), /already running/);
    assert.equal(provider.hits(), hits);
  } finally { await lock`SELECT pg_advisory_unlock(hashtext(${`xhs-probe:${id}`}))`; lock.release(); }
  mode = "unknown";
  await assert.rejects(cli("--plan", path, "--run"));
  assert.equal(provider.hits(), hits + 1);
  await assert.rejects(cli("--plan", path, "--run"), /unknown outcome/);
  assert.equal(provider.hits(), hits + 1);
  const [receipt] = await sql`SELECT status, attempts FROM receipts WHERE logical_key = ${logicalKey(s, id)}`;
  assert.equal(receipt!.status, "unknown");
  assert.equal(receipt!.attempts, 1);
  assert.match((await report(path)).state.error, /unknown outcome/);
});
