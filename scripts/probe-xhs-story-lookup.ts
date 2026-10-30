// First create a frozen plan (read-only SQL). --run explicitly makes at most 15 paid attempts per plan.
// node --env-file=.env scripts/probe-xhs-story-lookup.ts --plan .data/xhs-story-probe.json [--run]
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, realpath, writeFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { DISCOVERY_POOL, everyInfraCall } from "@aihot/backend/providers/everyinfra";
import { BudgetExceededError, completeReceipt, logicalKeyFor } from "@aihot/backend/providers/receipts";
import { runXhsProbe, selectXhsProbeStories, xhsStoryKeyword, type XhsProbeResult, type XhsProbeStory } from "../packages/backend/src/events/xhs-story-probe.ts";

const { values } = parseArgs({ options: { plan: { type: "string" }, run: { type: "boolean", default: false }, help: { type: "boolean" } } });
interface Plan { version: 1; at: string; search: { sort: "newest"; date_range: "last_7_days" }; stories: XhsProbeStory[] }
// Only newest is evidenced by docs/sources.md and industry/sources.json; do not assume general exists.
const search = { sort: "newest", date_range: "last_7_days" } as const;

async function dataPlanPath(input: string): Promise<string> {
  const root = resolve(REPO_ROOT, ".data");
  const path = resolve(input);
  const inside = (candidate: string) => {
    const rel = relative(root, candidate);
    return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
  };
  if (path === root || !inside(path)) throw new Error("Probe plans and results must stay under this repository's .data/");
  await mkdir(root, { recursive: true });
  if (await realpath(root) !== root) throw new Error("Probe .data/ must not be a symlink");
  // Check the existing ancestor before mkdir, so a directory symlink cannot put files outside .data/.
  let parent = dirname(path);
  for (;;) {
    try { if (!inside(await realpath(parent))) throw new Error("Probe plans and results must stay under .data/"); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; parent = dirname(parent); }
  }
  await mkdir(dirname(path), { recursive: true });
  try { if (!(await lstat(path)).isFile()) throw new Error("Probe .data/ plan must be a regular file, not a symlink"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return path;
}

async function loadPlan(path: string): Promise<Plan> {
  const plan: Plan = JSON.parse(await readFile(path, "utf8"));
  if (!plan || plan.version !== 1 || typeof plan.at !== "string" || !Number.isFinite(Date.parse(plan.at)) ||
      plan.search?.sort !== search.sort || plan.search?.date_range !== search.date_range || !Array.isArray(plan.stories) || plan.stories.length > 15 ||
      plan.stories.some((s) => !s || !Number.isSafeInteger(s.storyId) || s.storyId < 1 || typeof s.title !== "string" ||
        (s.maxScore !== null && (typeof s.maxScore !== "number" || !Number.isFinite(s.maxScore))) ||
        !Number.isSafeInteger(s.xhsParticipants) || s.xhsParticipants < 0 || !Array.isArray(s.reports) || !s.reports.length ||
        s.reports.some((r) => !r || typeof r.id !== "string" || typeof r.title !== "string" || typeof r.url !== "string" ||
          (r.language !== null && typeof r.language !== "string")) || typeof s.keyword !== "string" || !s.keyword.trim() ||
        [...s.keyword].length > 20 || s.keyword !== xhsStoryKeyword(s)) ||
      new Set(plan.stories.map((s) => s.storyId)).size !== plan.stories.length) {
    throw new Error("Invalid XHS probe plan; generate a fresh plan without --run");
  }
  return plan;
}

async function createPlan(path: string): Promise<Plan> {
  const at = new Date();
  const stories = await sql.begin("isolation level repeatable read read only", (tx) => selectXhsProbeStories(tx, at));
  const plan: Plan = { version: 1, at: at.toISOString(), search, stories };
  await writeFile(path, JSON.stringify(plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return plan;
}

async function main() {
  if (values.help) {
    console.log("--plan <.data/path>: create/review a frozen sample (up to 15 events) without paid calls. Add --run with an existing plan to search it (at most 15 actual attempts including failures). Results: <path>.results.json. Uses sort=newest, date_range=last_7_days and the discovery pool. No articles, signals, model calls, budgets or source settings are changed.");
    return;
  }
  if (!values.plan) throw new Error("--plan <.data/path> is required; use --help");
  const path = await dataPlanPath(values.plan);
  let plan: Plan;
  try { plan = await loadPlan(path); }
  catch (error) {
    if (values.run || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    plan = await createPlan(path);
  }
  console.log(JSON.stringify({ plan: path, at: plan.at, stories: plan.stories.length, search: plan.search,
    preview: plan.stories.map((s) => ({ storyId: s.storyId, title: s.title, keyword: s.keyword, maxScore: s.maxScore, xhsParticipants: s.xhsParticipants })) }));
  if (!values.run) return;
  const planId = createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 24);
  const subject = `xhs-probe:${planId}`;
  const params = (s: XhsProbeStory) => ({ keyword: s.keyword, sort: plan.search.sort, date_range: plan.search.date_range });
  const logicalKey = (s: XhsProbeStory) => logicalKeyFor({ service: "everyinfra", purpose: "xhs_story_probe",
    identity: { platform: "xiaohongshu", action: "search", params: params(s), window: planId } });
  const logicalKeys = plan.stories.map(logicalKey);
  const output = `${path}.results.json`;
  const results: XhsProbeResult[] = [];
  const save = async (state: unknown) => {
    const temp = `${output}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ planId, at: plan.at, state, results }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temp, output);
    } finally { await rm(temp, { force: true }); }
  };
  // The receipt subject is the story. Count this plan's logical keys, including failed attempts on recovery.
  const lock = await sql.reserve();
  let locked = false;
  try {
    const [row] = await lock`SELECT pg_try_advisory_lock(hashtext(${subject})) AS locked`;
    if (!row!.locked) throw new Error("This probe plan is already running");
    locked = true;
    const state = await runXhsProbe(plan.stories, async (s) => {
      const [usage] = await sql`SELECT count(*)::int AS n FROM receipt_attempts ra JOIN receipts r ON r.id = ra.receipt_id
        WHERE r.service = 'everyinfra' AND r.purpose = 'xhs_story_probe' AND r.logical_key = ANY(${logicalKeys}::text[])`;
      if (usage!.n >= 15) {
        const cached = await sql`SELECT 1 FROM receipts WHERE logical_key = ${logicalKey(s)} AND status IN ('received', 'completed')`;
        if (cached.length === 0) throw new BudgetExceededError("xhs-story-probe", "15-attempt cap", 86400);
      }
      const call = await everyInfraCall({ platform: "xiaohongshu", action: "search", params: params(s),
        subject: `story:${s.storyId}`, purpose: "xhs_story_probe", window: planId, pool: DISCOVERY_POOL });
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
  } catch (error) {
    if (locked) await save({ error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    if (locked) await lock`SELECT pg_advisory_unlock(hashtext(${subject}))`;
    lock.release();
  }
}

try { await main(); } finally { await closeDb(); }
