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
import { knownWechatAccounts, selectWechatDiscoveryStories, wechatStoryKeyword, type WechatDiscoveryStory } from "../packages/backend/src/events/wechat-story-discovery.ts";

const T = tag();
await mkdir(join(REPO_ROOT, ".data"), { recursive: true });
const dir = await mkdtemp(join(REPO_ROOT, ".data", "wechat-story-discovery-test-"));
let mode: "normal" | "failed" | "unknown" = "normal";
const requests: Array<{ platform: string; action: string; params: Record<string, unknown> }> = [];
const provider = await stub((hit, req) => {
  requests.push(JSON.parse(req.body));
  if (mode === "failed") return new Reply(503, { error: "local test refusal" });
  if (mode === "unknown") return null; // Unusable 200 after sending: the standard receipt becomes unknown.
  return { id: `wechat-discovery-${T}-${hit}`, billing: { charged_usd: 0.008 }, results: [
    { id: `a${hit}`, title: "睡眠记忆的研究", summary: "青少年的睡眠与记忆", account_name: `wxdisc-known-${T}`, kind: "article", url: `https://mp.weixin.qq.com/s/a${hit}?signature=x&timestamp=1` },
    { id: `b${hit}`, title: "完全无关的内容", account_name: `wxdisc-other-${T}` },
    { id: `c${hit}`, title: "睡眠记忆的研究" }, // No account_name, as observed on 2026-10-18.
  ] };
});
const cli = async (...args: string[]) => promisify(execFile)(process.execPath, ["scripts/discover-wechat-by-story.ts", ...args], {
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
  const prefix = `wxdisc-${tag()}`;
  const sources = { domestic: `${prefix}-cn`, international: `${prefix}-intl` };
  const storyIds: number[] = [];
  const articleIds: string[] = [];
  for (const [region, id] of Object.entries(sources)) {
    await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, region) VALUES (${id}, ${`Discovery reports ${region}`}, 'external', 'T1', 'editorial', ${region})`;
  }
  t.after(async () => {
    mode = "normal";
    await sql`DELETE FROM receipts WHERE purpose = 'wechat_story_discovery' AND subject = ANY(${storyIds.map((id) => `story:${id}`)}::text[])`;
    await sql`DELETE FROM facts WHERE story_id = ANY(${storyIds}::bigint[])`;
    await sql`DELETE FROM stories WHERE id = ANY(${storyIds}::bigint[])`;
    await sql`DELETE FROM articles WHERE id = ANY(${articleIds}::text[])`;
    await sql`DELETE FROM sources WHERE id = ANY(${Object.values(sources)})`;
  });
  return async (opts: { at?: Date; latestAt?: Date; title?: string; reportTitle?: string; language?: string | null; score?: number; selected?: boolean;
    visibility?: string; eligible?: boolean; visibleAfter?: Date; mergedInto?: number; duplicateOf?: string; region?: "domestic" | "international" } = {}): Promise<WechatDiscoveryStory> => {
    const at = opts.at ?? new Date();
    const sourceId = sources[opts.region ?? "international"];
    const [s] = await sql`INSERT INTO stories (public_id, title, latest_at, merged_into)
      VALUES (${randomUUID()}, ${opts.title ?? "睡眠记忆的研究"}, ${opts.latestAt ?? at}, ${opts.mergedInto ?? null}) RETURNING id, title`;
    storyIds.push(s!.id);
    const id = `wxdisc-${tag()}`;
    articleIds.push(id);
    const title = opts.reportTitle ?? "睡眠与记忆的中文报道";
    const url = `https://example.org/${id}`;
    const language = opts.language === undefined ? "zh" : opts.language;
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, language, discovered_at, timeline_at, duplicate_of)
      VALUES (${id}, ${sourceId}, ${`url:${url}`}, ${url}, ${title}, ${language}, ${at}, ${at}, ${opts.duplicateOf ?? null})`;
    await sql`INSERT INTO publications (article_id, visibility, eligible, selected, title, score, source_id, channel, url, discovered_at, timeline_at, sort_at, visible_after)
      VALUES (${id}, ${opts.visibility ?? "public"}, ${opts.eligible ?? true}, ${opts.selected ?? false}, '翻译后的中文标题', ${opts.score ?? 80},
        ${sourceId}, 'news', ${url}, ${at}, ${at}, ${at}, ${opts.visibleAfter ?? at})`;
    const [fact] = await sql`INSERT INTO facts (public_id, story_id, title) VALUES (${id}, ${s!.id}, 'Discovery fact') RETURNING id`;
    await sql`INSERT INTO fact_articles (fact_id, article_id) VALUES (${fact!.id}, ${id})`;
    const reports = [{ id, title, url, sourceId, language }];
    return { storyId: s!.id, title: s!.title, maxScore: opts.score ?? 80, domestic: opts.region === "domestic", reports, keyword: wechatStoryKeyword({ title: s!.title, reports }) };
  };
}

const counts = async () => (await sql`SELECT (SELECT count(*) FROM articles) AS articles, (SELECT count(*) FROM story_signals) AS signals,
  (SELECT count(*) FROM publications) AS publications, (SELECT count(*) FROM analyses) AS analyses, (SELECT count(*) FROM sources) AS sources,
  (SELECT jsonb_object_agg(processing_state, n) FROM (SELECT processing_state, count(*) AS n FROM articles GROUP BY processing_state) states) AS processing`)[0];
const planId = (plan: unknown) => createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 24);
const logicalKey = (s: WechatDiscoveryStory, window: string) => logicalKeyFor({ service: "everyinfra", purpose: "wechat_story_discovery",
  identity: { platform: "wechat_oa", action: "article_search", params: { keyword: s.keyword, category: "LATEST" }, window } });
async function frozenPlan(name: string, stories: WechatDiscoveryStory[]) {
  const path = join(dir, `${name}.json`);
  const plan = { version: 1, at: new Date().toISOString(), search: { category: "LATEST" }, stories };
  await writeFile(path, JSON.stringify(plan));
  return { path, plan, id: planId(plan) };
}
const report = async (path: string) => JSON.parse(await readFile(`${path}.results.json`, "utf8"));

test("WeChat selection is read-only, recent, unmerged, public, qualified and Chinese; domestic reports first, then score", async (t) => {
  const add = await fixture(t);
  const at = new Date("2041-03-15T12:00:00Z"); // A separate snapshot from other invariant-test rows.
  const boundary = await add({ at, score: 50, language: "en" }); // Han title also qualifies.
  const selected = await add({ at, score: 20, selected: true, reportTitle: "English original", language: "zh", title: "English event" });
  const english = await add({ at, score: 90, language: "en", reportTitle: "English primary report", title: "English event with a Chinese report" });
  const chinese = await add({ at, score: 20, eligible: false });
  await sql`INSERT INTO fact_articles (fact_id, article_id) SELECT id, ${chinese.reports[0].id} FROM facts WHERE story_id = ${english.storyId}`;
  const domestic = await add({ at, score: 55, region: "domestic" });
  await add({ at, score: 49, region: "domestic" });
  await add({ at, latestAt: new Date(at.getTime() - 7 * 86400_000), region: "domestic" });
  await add({ at, latestAt: new Date(at.getTime() + 1), region: "domestic" });
  await add({ at, mergedInto: boundary.storyId, region: "domestic" });
  await add({ at, language: "en", reportTitle: "English original", title: "中文事件不能替代中文报道", region: "domestic" });
  await add({ at, visibility: "withdrawn", score: 99, region: "domestic" });
  await add({ at, eligible: false, score: 99, region: "domestic" });
  await add({ at, selected: true, visibleAfter: new Date(at.getTime() + 1), score: 99, region: "domestic" });
  await add({ at, duplicateOf: boundary.reports[0].id, score: 99, region: "domestic" });
  const before = await counts();
  const sample = await sql.begin("isolation level repeatable read read only", (tx) => selectWechatDiscoveryStories(tx, at));
  assert.deepEqual(sample.map((s) => s.storyId), [domestic.storyId, english.storyId, boundary.storyId, selected.storyId]);
  assert.deepEqual(sample.map((s) => s.domestic), [true, false, false, false]);
  assert.deepEqual(sample.map((s) => s.maxScore), [55, 90, 50, 20]);
  assert.equal(sample[1].keyword, chinese.reports[0].title, "qualification and Chinese evidence may come from different reports");
  assert.equal(sample[1].keyword, wechatStoryKeyword(sample[1]));
  assert.deepEqual(sample[2].reports, boundary.reports);
  assert.equal(sample[3].keyword, "English original", "language=zh is the explicit alternative to Han characters");
  assert.deepEqual(await counts(), before);
  // The default and the maximum are twenty; a smaller limit keeps the first of the same order.
  const more: WechatDiscoveryStory[] = [];
  for (let i = 0; i < 18; i++) more.push(await add({ at, score: 60 + i, region: "domestic" }));
  const capped = await selectWechatDiscoveryStories(sql, at);
  assert.equal(capped.length, 20);
  assert.deepEqual(capped.map((s) => s.storyId), [...more.slice(-18).reverse().map((s) => s.storyId), domestic.storyId, english.storyId].slice(0, 20));
  assert.deepEqual((await selectWechatDiscoveryStories(sql, at, 3)).map((s) => s.storyId), capped.slice(0, 3).map((s) => s.storyId));
  await assert.rejects(selectWechatDiscoveryStories(sql, at, 0), /Limit/);
  await assert.rejects(selectWechatDiscoveryStories(sql, at, 21), /Limit/);
});

test("WeChat known accounts match name or nickname exactly, enabled or not, and prefer an enabled source", async () => {
  const name = `wxdisc-known-name-${tag()}`, nick = `wxdisc-known-nick-${tag()}`, shared = `wxdisc-shared-${tag()}`;
  const ids = [`wxdisc-mp-a-${tag()}`, `wxdisc-mp-b-${tag()}`, `wxdisc-mp-c-${tag()}`, `wxdisc-x-${tag()}`];
  try {
    await sql`INSERT INTO sources (id, name, kind, tier, enabled, interval_minutes, config) VALUES (${ids[0]}, ${name}, 'mp_account', 'T1', false, 720, '{}')`;
    await sql`INSERT INTO sources (id, name, kind, tier, enabled, interval_minutes, config) VALUES (${ids[1]}, 'other', 'mp_account', 'T1', true, 720, ${sql.json({ nickname: nick })})`;
    await sql`INSERT INTO sources (id, name, kind, tier, enabled, interval_minutes, config) VALUES (${ids[2]}, ${shared}, 'mp_account', 'T1', false, 720, '{}')`;
    await sql`INSERT INTO sources (id, name, kind, tier, enabled, interval_minutes, config) VALUES (${ids[3]}, ${shared}, 'mp_account', 'T1', true, 720, '{}')`;
    const known = await knownWechatAccounts(sql);
    assert.equal(known.get(name), ids[0]);
    assert.equal(known.get(nick), ids[1]);
    assert.equal(known.get(shared), ids[3]);
    assert.equal(known.get(`${name} `), undefined);
    assert.equal(known.has("other"), true);
  } finally { await sql`DELETE FROM sources WHERE id = ANY(${ids})`; }
});

test("WeChat CLI creates or previews a frozen plan without paying and requires an existing .data plan for --run", async (t) => {
  const add = await fixture(t);
  await add();
  const path = join(dir, "generated.json");
  const hits = provider.hits();
  const before = await counts();
  await cli("--plan", path, "--limit", "2");
  const saved = await readFile(path, "utf8");
  const plan = JSON.parse(saved);
  assert.ok(plan.stories.length > 0 && plan.stories.length <= 2);
  assert.deepEqual(plan.search, { category: "LATEST" });
  assert.ok(plan.stories.every((s: WechatDiscoveryStory) => s.reports.length > 0 && s.keyword === wechatStoryKeyword(s) && [...s.keyword].length <= 16));
  await cli("--plan", path);
  assert.equal(await readFile(path, "utf8"), saved);
  assert.equal(provider.hits(), hits);
  assert.deepEqual(await counts(), before);
  await assert.rejects(cli("--plan", path, "--limit", "3"), /already exists/);
  await assert.rejects(cli("--plan", join(dir, "new-limit.json"), "--limit", "21"), /--limit/);
  await assert.rejects(cli("--plan", join(dir, "missing.json"), "--run"), /ENOENT/);
  await assert.rejects(cli("--plan", join(dir, "missing.json"), "--summarize"), /ENOENT/);
  await assert.rejects(cli("--plan", path, "--run", "--summarize"), /not both/);
  await assert.rejects(cli("--plan", join(REPO_ROOT, "outside-discovery.json")), /\.data/);
  await symlink(join(REPO_ROOT, "docs"), join(dir, "escape"));
  await assert.rejects(cli("--plan", join(dir, "escape", "plan.json")), /\.data/);
  // A keyword rewritten by hand is allowed, but not an empty or overlong one.
  plan.stories[0].keyword = "人工改写的关键词";
  await writeFile(path, JSON.stringify(plan));
  await cli("--plan", path);
  for (const keyword of ["  ", "字".repeat(21)]) {
    plan.stories[0].keyword = keyword;
    await writeFile(path, JSON.stringify(plan));
    await assert.rejects(cli("--plan", path, "--run"), /Invalid WeChat discovery plan/);
  }
  assert.equal(provider.hits(), hits);
  assert.ok((await cli("--help")).stdout.includes("--summarize"));
});

test("WeChat full --run uses LATEST article_search receipts in the discovery pool, replays at the cap, and preserves progress on budget stop", async (t) => {
  const add = await fixture(t);
  const first = await add();
  const second = { ...await add({ title: "青少年睡眠不足影响学习" }), keyword: "人工改写的关键词" };
  const known = `wxdisc-known-${T}`;
  const sourceId = `wxdisc-mp-${tag()}`;
  await sql`INSERT INTO sources (id, name, kind, tier, enabled, interval_minutes, config) VALUES (${sourceId}, ${known}, 'mp_account', 'T1', false, 720, '{}')`;
  t.after(async () => { await sql`DELETE FROM sources WHERE id = ${sourceId}`; });
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
  assert.deepEqual(saved.results[0].hits.map((h: { accountName: string | null; known: string | null; ruleMatch: boolean; review: null }) => [h.accountName, h.known, h.ruleMatch, h.review]),
    [[known, sourceId, true, null], [`wxdisc-other-${T}`, null, false, null], [null, null, true, null]]);
  assert.equal(provider.hits(), hits + 1);
  await sql`UPDATE budgets SET per_day = 10000 WHERE service = ${DISCOVERY_POOL}`;
  const run = await cli("--plan", path, "--run");
  saved = await report(path);
  assert.deepEqual(saved.state, { completed: 2, stopped: null });
  assert.deepEqual(saved.results.map((r: { reused: boolean }) => r.reused), [true, false]);
  assert.equal(provider.hits(), hits + 2);
  const rates = JSON.parse(run.stdout.trim().split("\n").at(-1)!).fieldRates;
  assert.equal(rates.hits, 6);
  assert.deepEqual(rates.rates, { title: 1, summary: 0.333, accountName: 0.667, postedAt: 0, relativeTime: 0, kind: 0.333, url: 0.333 });
  const attempts = await sql`SELECT r.subject, ra.pool FROM receipt_attempts ra JOIN receipts r ON r.id = ra.receipt_id
    WHERE r.logical_key = ANY(${[first, second].map((s) => logicalKey(s, id))}::text[])`;
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every((r) => r.pool === DISCOVERY_POOL));
  assert.deepEqual(attempts.map((r) => r.subject).sort(), [first, second].map((s) => `story:${s.storyId}`).sort());
  assert.deepEqual(requests.at(-1), { platform: "wechat_oa", action: "article_search", params: { keyword: "人工改写的关键词", category: "LATEST" } });
  // Failed attempts count even though the two successful answers remain reusable at the cap.
  const [receipt] = await sql`SELECT id FROM receipts WHERE logical_key = ${logicalKey(first, id)}`;
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, pool, status) VALUES (${receipt!.id}, 2, 'everyinfra', ${DISCOVERY_POOL}, 'failed')`;
  await sql`UPDATE receipts SET attempts = 2 WHERE id = ${receipt!.id}`;
  await cli("--plan", path, "--run");
  saved = await report(path);
  assert.ok(saved.results.every((r: { reused: boolean; receiptCostUsd: number; newCostUsd: number }) => r.reused && r.receiptCostUsd === 0.008 && r.newCostUsd === 0));
  assert.equal(provider.hits(), hits + 2);
  assert.deepEqual(await counts(), before, "no materials, signals, publications, analyses, sources or processing work");
  assert.ok(!(await readdir(dir)).some((name) => name.includes(".tmp")), "results replace atomically without leftover temporary files");
});

test("WeChat --summarize is read-only: it applies reviews from the results file and sends no request", async (t) => {
  const add = await fixture(t);
  const { path, id } = await frozenPlan("summarize", [await add(), await add({ title: "青少年睡眠不足影响学习" })]);
  await cli("--plan", path, "--run");
  const hits = provider.hits();
  const before = await counts();
  await cli("--plan", path, "--summarize");
  let accounts = JSON.parse(await readFile(`${path}.accounts.json`, "utf8"));
  assert.equal(accounts.planId, id);
  // The unreviewed rule keeps only the matching account; reviews then add and remove results by hand.
  assert.deepEqual(accounts.accounts.map((a: { accountName: string; stories: number; hits: number }) => [a.accountName, a.stories, a.hits]), [[`wxdisc-known-${T}`, 2, 2]]);
  assert.match(await readFile(`${path}.accounts.md`, "utf8"), /^\| 公众号名 \| 覆盖事件数 \| 是否已是信源 \| 样例标题 \|\n\| --- \| --- \| --- \| --- \|\n\| wxdisc-known-\w+ \| 2 \| 否 \| 睡眠记忆的研究<br>睡眠记忆的研究 \|\n$/);
  const results = await report(path);
  results.results[0].hits[0].review = false;
  results.results[0].hits[1].review = true;
  results.results[1].hits[1].review = true;
  await writeFile(`${path}.results.json`, JSON.stringify(results));
  await cli("--plan", path, "--summarize");
  accounts = JSON.parse(await readFile(`${path}.accounts.json`, "utf8"));
  assert.deepEqual(accounts.accounts.map((a: { accountName: string; stories: number; hits: number }) => [a.accountName, a.stories, a.hits]),
    [[`wxdisc-other-${T}`, 2, 2], [`wxdisc-known-${T}`, 1, 1]]);
  assert.match(await readFile(`${path}.accounts.md`, "utf8"), new RegExp(`\\| wxdisc-other-${T} \\| 2 \\| 否 \\| 完全无关的内容<br>完全无关的内容 \\|`));
  assert.equal(provider.hits(), hits);
  assert.deepEqual(await counts(), before);
  // Results of another plan (for example after the plan was edited) are refused.
  const plan = JSON.parse(await readFile(path, "utf8"));
  plan.stories[0].keyword = "改写之后";
  await writeFile(path, JSON.stringify(plan));
  await assert.rejects(cli("--plan", path, "--summarize"), /does not belong to this plan/);
  assert.equal(provider.hits(), hits);
  assert.ok(!(await readdir(dir)).some((name) => name.includes(".tmp")));
});

test("WeChat lifetime cap is one attempt per planned event and counts failed attempts", async (t) => {
  const add = await fixture(t);
  const [a, b] = [await add(), await add({ title: "青少年睡眠不足影响学习" })];
  const { path, id } = await frozenPlan("cap", [a, b]);
  const [receipt] = await sql`INSERT INTO receipts (logical_key, service, purpose, subject, status, attempts)
    VALUES (${logicalKey(a, id)}, 'everyinfra', 'wechat_story_discovery', ${`story:${a.storyId}`}, 'failed', 1) RETURNING id`;
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, pool, status) VALUES (${receipt!.id}, 1, 'everyinfra', ${DISCOVERY_POOL}, 'failed')`;
  const hits = provider.hits();
  mode = "failed";
  await assert.rejects(cli("--plan", path, "--run"), /HTTP 503/);
  assert.equal(provider.hits(), hits + 1, "the second and last permitted attempt");
  assert.equal((await report(path)).results.length, 0);
  await cli("--plan", path, "--run");
  assert.deepEqual((await report(path)).state, { completed: 0, stopped: "budget" });
  assert.equal(provider.hits(), hits + 1, "no third attempt");
  const [usage] = await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id = ${receipt!.id}`;
  assert.equal(usage!.n, 2);
});

test("WeChat CLI refuses concurrent copies of a plan and never resends an unknown receipt", async (t) => {
  const add = await fixture(t);
  const s = await add();
  const { path, id } = await frozenPlan("unknown", [s]);
  const hits = provider.hits();
  const lock = await sql.reserve();
  try {
    await lock`SELECT pg_advisory_lock(hashtext(${`wechat-story-discovery:${id}`}))`;
    await assert.rejects(cli("--plan", path, "--run"), /already running/);
    assert.equal(provider.hits(), hits);
  } finally { await lock`SELECT pg_advisory_unlock(hashtext(${`wechat-story-discovery:${id}`}))`; lock.release(); }
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
