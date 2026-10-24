// First create a frozen plan (read-only SQL). --run explicitly makes at most 30 paid attempts per plan.
// node --env-file=.env scripts/probe-x-story-lookup.ts --plan .data/x-story-probe.json [--run]
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { closeDb, sql } from "@aihot/backend/db";
import { everyInfraCall } from "@aihot/backend/providers/everyinfra";
import { BudgetExceededError, completeReceipt, logicalKeyFor } from "@aihot/backend/providers/receipts";
import { runXProbe, type ProbeResult, type ProbeStory } from "../packages/backend/src/events/x-story-probe.ts";
import { probeQueries } from "../packages/backend/src/events/x-story-query.ts";

const { values } = parseArgs({ options: { plan: { type: "string" }, run: { type: "boolean", default: false }, help: { type: "boolean" } } });
interface Plan { version: 1; at: string; rankingId: number | null; stories: ProbeStory[] }

async function loadPlan(path: string): Promise<Plan> {
  const plan: Plan = JSON.parse(await readFile(path, "utf8"));
  if (plan.version !== 1 || !Number.isFinite(Date.parse(plan.at)) || !Array.isArray(plan.stories) || plan.stories.length > 10 ||
      new Set(plan.stories.map((s) => s.storyId)).size !== plan.stories.length || plan.stories.some((s) =>
        !Number.isSafeInteger(s.storyId) || s.storyId < 1 || typeof s.title !== "string" || !Array.isArray(s.reports) || s.reports.some((r) =>
          typeof r.id !== "string" || typeof r.url !== "string" || typeof r.title !== "string" || (r.body !== null && typeof r.body !== "string")))) {
    throw new Error("Invalid probe plan; generate a fresh plan without --run");
  }
  return plan;
}

async function createPlan(path: string): Promise<Plan> {
  const at = new Date();
  // Keep the same ten events, keywords and since date on recovery, even if the live ranking changes.
  const [ranking] = await sql<{ id: number }[]>`SELECT id FROM hot_rankings WHERE published AND computed_at <= ${at}
    AND computed_at > ${new Date(at.getTime() - 7 * 86400_000)} ORDER BY computed_at DESC, id DESC LIMIT 1`;
  const ranked = ranking ? await sql<{ id: number; title: string }[]>`
    SELECT st.id, st.title FROM hot_rankings hr CROSS JOIN LATERAL jsonb_array_elements(hr.entries) e
    JOIN stories st ON st.id = (e->>'storyId')::bigint
    WHERE hr.id = ${ranking.id} AND st.merged_into IS NULL AND st.latest_at > ${new Date(at.getTime() - 7 * 86400_000)}
    GROUP BY st.id ORDER BY min((e->>'rank')::int), st.id LIMIT 10` : [];
  const stories: ProbeStory[] = [];
  for (const s of ranked) {
    const reports = await sql<Array<ProbeStory["reports"][number]>>`
      SELECT DISTINCT a.id, a.url, a.title, a.body_text AS body, src.first_party
      FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN articles a ON a.id = fa.article_id
      JOIN sources src ON src.id = a.source_id JOIN publications p ON p.article_id = a.id
      WHERE f.story_id = ${s.id} AND a.duplicate_of IS NULL AND src.participation_mode = 'editorial'
        AND p.visibility = 'public' AND p.eligible AND (NOT p.selected OR p.visible_after <= ${at})
      ORDER BY src.first_party DESC, a.id`;
    stories.push({ storyId: s.id, title: s.title, reports: reports.map(({ id, url, title, body }) => ({ id, url, title, body })) });
  }
  const plan: Plan = { version: 1, at: at.toISOString(), rankingId: ranking?.id ?? null, stories };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return plan;
}

async function main() {
  if (values.help) {
    console.log("--plan <path>: create/review a frozen sample without paid calls. Add --run to search it. Results: <path>.results.json. No articles, signals, budgets or source settings are changed.");
    return;
  }
  if (!values.plan) throw new Error("--plan <path> is required; use --help");
  let plan: Plan;
  try { plan = await loadPlan(values.plan); }
  catch (error) {
    if (values.run || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    plan = await createPlan(values.plan);
  }
  const at = new Date(plan.at);
  const queries = plan.stories.map((s) => ({ storyId: s.storyId, title: s.title, queries: probeQueries(s.reports, at) }));
  console.log(JSON.stringify({ plan: values.plan, at: plan.at, stories: plan.stories.length,
    queries: queries.reduce((n, s) => n + s.queries.length, 0), preview: queries }));
  if (!values.run) return;
  const planId = createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 24);
  const subject = `x-probe:${planId}`;
  const output = `${values.plan}.results.json`;
  const results: ProbeResult[] = [];
  const save = async (state: unknown) => {
    await writeFile(`${output}.tmp`, JSON.stringify({ planId, at: plan.at, state, results }, null, 2) + "\n", { mode: 0o600 });
    await rename(`${output}.tmp`, output);
  };
  // Session lock prevents concurrent copies of this plan racing the 30-attempt experiment cap.
  const lock = await sql.reserve();
  let locked = false;
  try {
    const [row] = await lock`SELECT pg_try_advisory_lock(hashtext(${subject})) AS locked`;
    if (!row!.locked) throw new Error("This probe plan is already running");
    locked = true;
    const state = await runXProbe(plan.stories, at, async (s, q) => {
      const window = `${planId}:story:${s.storyId}`;
      const [usage] = await sql`SELECT count(*)::int AS n FROM receipt_attempts ra JOIN receipts r ON r.id = ra.receipt_id
        WHERE r.service = 'everyinfra' AND r.subject = ${subject}`;
      if (usage!.n >= 30) {
        const logicalKey = logicalKeyFor({ service: "everyinfra", purpose: "x_story_probe",
          identity: { platform: "twitter", action: "search", params: { keyword: q.keyword }, window } });
        const cached = await sql`SELECT 1 FROM receipts WHERE logical_key = ${logicalKey} AND status IN ('received', 'completed')`;
        if (cached.length === 0) throw new BudgetExceededError("x-story-probe", "30-attempt cap", 86400);
      }
      const call = await everyInfraCall({ platform: "twitter", action: "search", params: { keyword: q.keyword }, subject,
        purpose: "x_story_probe", window, pool: "everyinfra:twitter" });
      return { ...call, costUsd: typeof call.response.billing?.charged_usd === "number" ? call.response.billing.charged_usd : null };
    }, async (result) => {
      results.push(result);
      await save("running"); // Persist evidence before completing the receipt; recovery reuses the stored response.
      await completeReceipt(sql, result.receiptId);
      console.log(JSON.stringify({ storyId: result.storyId, format: result.query.format, received: result.received,
        matched: result.matched, selected: result.selected, receiptId: result.receiptId, reused: result.reused }));
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
