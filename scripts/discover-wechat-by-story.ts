// First create a frozen plan (read-only SQL). --run explicitly makes at most one paid attempt per planned event.
// node --env-file=.env scripts/discover-wechat-by-story.ts --plan .data/wechat-story-discovery.json [--limit 20] [--run | --summarize]
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, realpath, writeFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { DISCOVERY_POOL, everyInfraCall } from "@aihot/backend/providers/everyinfra";
import { BudgetExceededError, completeReceipt, logicalKeyFor } from "@aihot/backend/providers/receipts";
import { accountsMarkdown, knownWechatAccounts, runWechatDiscovery, selectWechatDiscoveryStories, summarizeAccounts, wechatFieldRates,
  WECHAT_DISCOVERY_MAX_KEYWORD, WECHAT_DISCOVERY_MAX_STORIES, type WechatDiscoveryResult, type WechatDiscoveryStory } from "../packages/backend/src/events/wechat-story-discovery.ts";

const { values } = parseArgs({ options: { plan: { type: "string" }, limit: { type: "string" }, run: { type: "boolean", default: false },
  summarize: { type: "boolean", default: false }, help: { type: "boolean" } } });
interface Plan { version: 1; at: string; search: { category: "LATEST" }; stories: WechatDiscoveryStory[] }
const search = { category: "LATEST" } as const;

async function dataPlanPath(input: string): Promise<string> {
  const root = resolve(REPO_ROOT, ".data");
  const path = resolve(input);
  const inside = (candidate: string) => {
    const rel = relative(root, candidate);
    return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
  };
  if (path === root || !inside(path)) throw new Error("Discovery plans and results must stay under this repository's .data/");
  await mkdir(root, { recursive: true });
  if (await realpath(root) !== root) throw new Error("Discovery .data/ must not be a symlink");
  // Check the existing ancestor before mkdir, so a directory symlink cannot put files outside .data/.
  let parent = dirname(path);
  for (;;) {
    try { if (!inside(await realpath(parent))) throw new Error("Discovery plans and results must stay under .data/"); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; parent = dirname(parent); }
  }
  await mkdir(dirname(path), { recursive: true });
  try { if (!(await lstat(path)).isFile()) throw new Error("Discovery .data/ plan must be a regular file, not a symlink"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return path;
}

async function loadPlan(path: string): Promise<Plan> {
  const plan: Plan = JSON.parse(await readFile(path, "utf8"));
  // The keyword may have been rewritten by hand, so it is only checked for being usable.
  if (!plan || plan.version !== 1 || typeof plan.at !== "string" || !Number.isFinite(Date.parse(plan.at)) ||
      plan.search?.category !== search.category || !Array.isArray(plan.stories) || plan.stories.length > WECHAT_DISCOVERY_MAX_STORIES ||
      plan.stories.some((s) => !s || !Number.isSafeInteger(s.storyId) || s.storyId < 1 || typeof s.title !== "string" ||
        (s.maxScore !== null && (typeof s.maxScore !== "number" || !Number.isFinite(s.maxScore))) || typeof s.domestic !== "boolean" ||
        !Array.isArray(s.reports) || !s.reports.length ||
        s.reports.some((r) => !r || typeof r.id !== "string" || typeof r.title !== "string" || typeof r.url !== "string" ||
          typeof r.sourceId !== "string" || (r.language !== null && typeof r.language !== "string")) ||
        typeof s.keyword !== "string" || !s.keyword.trim() || [...s.keyword].length > WECHAT_DISCOVERY_MAX_KEYWORD) ||
      new Set(plan.stories.map((s) => s.storyId)).size !== plan.stories.length) {
    throw new Error("Invalid WeChat discovery plan; generate a fresh plan without --run");
  }
  return plan;
}

async function createPlan(path: string, limit: number): Promise<Plan> {
  const at = new Date();
  const stories = await sql.begin("isolation level repeatable read read only", (tx) => selectWechatDiscoveryStories(tx, at, limit));
  const plan: Plan = { version: 1, at: at.toISOString(), search, stories };
  await writeFile(path, JSON.stringify(plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return plan;
}

async function writeAtomic(path: string, text: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

async function main() {
  if (values.help) {
    console.log("--plan <.data/path> [--limit N]: create/review a frozen sample (up to 20 events, default 20) without paid calls; rewrite the keywords by hand before --run. Add --run with an existing plan to search WeChat articles (wechat_oa article_search, category LATEST, at most one actual attempt per planned event including failures). Results: <path>.results.json; set \"review\" to true/false on a result by hand. Add --summarize (read-only, no requests) to rebuild <path>.accounts.json and <path>.accounts.md from the results and your reviews. Uses the discovery pool. No articles, signals, sources, model calls, budgets or schedules are changed.");
    return;
  }
  if (!values.plan) throw new Error("--plan <.data/path> is required; use --help");
  if (values.run && values.summarize) throw new Error("Use either --run or --summarize, not both");
  const limit = values.limit === undefined ? WECHAT_DISCOVERY_MAX_STORIES : Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WECHAT_DISCOVERY_MAX_STORIES) throw new Error(`--limit must be an integer from 1 to ${WECHAT_DISCOVERY_MAX_STORIES}`);
  const path = await dataPlanPath(values.plan);
  let plan: Plan;
  try {
    plan = await loadPlan(path);
    if (values.limit !== undefined) throw new Error("--limit only applies when the plan is created; this plan already exists");
  } catch (error) {
    if (values.run || values.summarize || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    plan = await createPlan(path, limit);
  }
  const planId = createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 24);
  const output = `${path}.results.json`;
  if (values.summarize) {
    const saved = JSON.parse(await readFile(output, "utf8"));
    if (saved?.planId !== planId || !Array.isArray(saved.results) || saved.results.some((r: WechatDiscoveryResult) => !r || !Number.isSafeInteger(r.storyId) || !Array.isArray(r.hits))) {
      throw new Error(`${output} does not belong to this plan or is malformed`);
    }
    const accounts = summarizeAccounts(saved.results);
    await writeAtomic(`${path}.accounts.json`, JSON.stringify({ planId, accounts }, null, 2) + "\n");
    await writeAtomic(`${path}.accounts.md`, accountsMarkdown(accounts));
    console.log(JSON.stringify({ accounts: accounts.length, json: `${path}.accounts.json`, markdown: `${path}.accounts.md` }));
    return;
  }
  console.log(JSON.stringify({ plan: path, at: plan.at, stories: plan.stories.length, search: plan.search,
    preview: plan.stories.map((s) => ({ storyId: s.storyId, title: s.title, keyword: s.keyword, maxScore: s.maxScore, domestic: s.domestic })) }));
  if (!values.run) return;
  const subject = `wechat-story-discovery:${planId}`;
  const cap = plan.stories.length;
  const params = (s: WechatDiscoveryStory) => ({ keyword: s.keyword.trim(), category: plan.search.category });
  const logicalKey = (s: WechatDiscoveryStory) => logicalKeyFor({ service: "everyinfra", purpose: "wechat_story_discovery",
    identity: { platform: "wechat_oa", action: "article_search", params: params(s), window: planId } });
  const logicalKeys = plan.stories.map(logicalKey);
  const results: WechatDiscoveryResult[] = [];
  const save = (state: unknown) => writeAtomic(output, JSON.stringify({ planId, at: plan.at, state, results }, null, 2) + "\n");
  // The receipt subject is the story. Count this plan's logical keys, including failed attempts on recovery.
  const lock = await sql.reserve();
  let locked = false;
  try {
    const [row] = await lock`SELECT pg_try_advisory_lock(hashtext(${subject})) AS locked`;
    if (!row!.locked) throw new Error("This discovery plan is already running");
    locked = true;
    const known = await knownWechatAccounts(sql);
    const state = await runWechatDiscovery(plan.stories, known, async (s) => {
      const [usage] = await sql`SELECT count(*)::int AS n FROM receipt_attempts ra JOIN receipts r ON r.id = ra.receipt_id
        WHERE r.service = 'everyinfra' AND r.purpose = 'wechat_story_discovery' AND r.logical_key = ANY(${logicalKeys}::text[])`;
      if (usage!.n >= cap) {
        // A stored answer is free to replay, and an unknown receipt must reach the standard guard, which stops without resending.
        const cached = await sql`SELECT 1 FROM receipts WHERE logical_key = ${logicalKey(s)} AND status IN ('received', 'completed', 'unknown')`;
        if (cached.length === 0) throw new BudgetExceededError("wechat-story-discovery", `${cap}-attempt cap`, 86400);
      }
      const call = await everyInfraCall({ platform: "wechat_oa", action: "article_search", params: params(s),
        subject: `story:${s.storyId}`, purpose: "wechat_story_discovery", window: planId, pool: DISCOVERY_POOL });
      return { ...call, costUsd: typeof call.response.billing?.charged_usd === "number" ? call.response.billing.charged_usd : null };
    }, async (result) => {
      results.push(result);
      await save("running"); // Persist before completion; recovery reuses the raw receipt response.
      await completeReceipt(sql, result.receiptId);
      console.log(JSON.stringify({ storyId: result.storyId, keyword: result.keyword, received: result.received,
        receiptId: result.receiptId, reused: result.reused, receiptCostUsd: result.receiptCostUsd, newCostUsd: result.newCostUsd }));
    });
    await save(state);
    console.log(JSON.stringify({ ...state, output }));
    console.log(JSON.stringify({ fieldRates: wechatFieldRates(results) }));
  } catch (error) {
    if (locked) await save({ error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    if (locked) await lock`SELECT pg_advisory_unlock(hashtext(${subject}))`;
    lock.release();
  }
}

try { await main(); } finally { await closeDb(); }
