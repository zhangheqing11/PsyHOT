// Run only the new industry role step, merging into the latest analysis and republishing that item.
//   node --env-file=.env scripts/rerun-role-scores.ts --days 28 --limit 20 --dry-run
// Requires FEATURES.industryRoleScoring. Dry runs only read; selected copy is never rewritten here.
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { industryRoleScoringOn, TRACK_CATEGORIES } from "@aihot/contracts/taxonomy";
import { closeDb, sql } from "@aihot/backend/db";
import { loadAnalyzeInput, PROMPT_VERSIONS, runRoleScores } from "@aihot/backend/editorial/analyze";
import { completeReceipt } from "@aihot/backend/providers/receipts";
import { publishArticleTx } from "@aihot/backend/publication/publish";
import { pickIndustryHot } from "@aihot/backend/events/industry-hot";
import { stopBoss } from "@aihot/backend/jobs/queue";

export async function rerunRoleScores(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    days: { type: "string", default: "28" }, limit: { type: "string" },
    concurrency: { type: "string", default: "3" }, tag: { type: "string", default: "role-scores-2026-11" },
    "dry-run": { type: "boolean", default: false },
  } });
  if (!industryRoleScoringOn()) throw new Error("请先打开 FEATURES.industryRoleScoring，再运行 rerun-role-scores（含 --dry-run）。");
  for (const key of ["days", "limit", "concurrency"] as const) {
    if (values[key] !== undefined && (!Number.isSafeInteger(Number(values[key])) || Number(values[key]) < 1)) throw new Error(`--${key} must be a positive integer`);
  }
  if (!values.tag!.trim()) throw new Error("--tag must not be empty");
  const set = await sql<{ id: string; analysis_id: number }[]>`
    SELECT a.id, an.id AS analysis_id
    FROM articles a JOIN publications p ON p.article_id = a.id JOIN sources s ON s.id = a.source_id
    JOIN LATERAL (SELECT * FROM analyses WHERE article_id = a.id ORDER BY input_revision DESC, id DESC LIMIT 1) an ON true
    WHERE a.discovered_at > now() - make_interval(days => ${Number(values.days)}) AND a.discovered_at <= now()
      AND a.duplicate_of IS NULL AND an.input_revision = a.revision
      AND s.participation_mode = 'editorial' AND p.visibility = 'public' AND NOT p.promotion
      AND p.category = ANY(${TRACK_CATEGORIES.industry}::text[]) AND an.category = ANY(${TRACK_CATEGORIES.industry}::text[])
      AND an.relevance = 'pass' AND coalesce((an.output->>'promotion')::boolean, false) = false
      AND an.output->'roleScoring'->>'promptVersion' IS DISTINCT FROM ${PROMPT_VERSIONS.roles}
    ORDER BY a.discovered_at DESC, a.id`;
  const items = set.slice(0, values.limit ? Number(values.limit) : undefined);
  const ids = items.map((r) => r.id);
  const missingCopy = async () => {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM publications p JOIN analyses an ON an.id = p.analysis_id
      WHERE p.article_id = ANY(${ids}::text[]) AND p.selected AND an.output->>'writer' IS DISTINCT FROM 'understand'`;
    return row!.n;
  };
  console.log(`${set.length} items left in the set; running ${items.length}${values["dry-run"] ? " (dry-run)" : ""}`);
  if (values["dry-run"]) {
    const report = { total: set.length, ids, dryRun: true, selectedWithoutUnderstand: await missingCopy() };
    console.log(JSON.stringify(report));
    return report;
  }

  const receiptIds: number[] = [];
  let next = 0;
  let failed = 0;
  await Promise.all(Array.from({ length: Number(values.concurrency) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        const input = await loadAnalyzeInput(item.id);
        if (!input) throw new Error("article no longer exists");
        const result = await runRoleScores(input, { attemptTag: values.tag! });
        receiptIds.push(result.receiptId);
        await sql.begin(async (tx) => {
          const [current] = await tx<{ revision: number }[]>`SELECT revision FROM articles WHERE id=${item.id} FOR UPDATE`;
          const [latest] = await tx<{ id: number; input_revision: number; relevance: string; output: Record<string, any>; receipt_ids: number[] }[]>`
            SELECT id, input_revision, relevance, output, receipt_ids FROM analyses WHERE article_id=${item.id} ORDER BY input_revision DESC, id DESC LIMIT 1 FOR UPDATE`;
          if (current?.revision !== input.revision || latest?.id !== item.analysis_id || latest.input_revision !== input.revision) throw new Error("article or analysis changed during role scoring; rerun later");
          const selected = latest.relevance === "pass" && !latest.output.promotion && result.selectedRoles.length > 0;
          const output = { ...latest.output,
            roleScoring: { values: result.values, roleScores: result.roleScores, selectedRoles: result.selectedRoles, model: result.model, promptVersion: PROMPT_VERSIONS.roles, rerunTag: values.tag! },
            roles: result.browseRoles, impact: result.browseRoles.length ? latest.output.impact ?? null : null, selected, scoringPath: "roles",
          };
          await tx`UPDATE analyses SET output=${tx.json(output as never)}, selected=${selected}, receipt_ids=${[...new Set([...latest.receipt_ids, result.receiptId])]} WHERE id=${latest.id}`;
          await completeReceipt(tx, result.receiptId);
          await publishArticleTx(tx, item.id);
        });
      } catch (error) {
        failed += 1;
        console.error(`${item.id}: ${String(error).slice(0, 200)}`);
      }
    }
  }));
  const hotPicks = await pickIndustryHot();
  const [usage] = await sql`
    SELECT count(*)::int AS attempts, sum(cost) AS cost,
      sum(coalesce((usage->>'prompt_tokens')::int, 0)) AS tokens_in, sum(coalesce((usage->>'completion_tokens')::int, 0)) AS tokens_out
    FROM receipt_attempts WHERE receipt_id = ANY(${[...new Set(receiptIds)]}::bigint[])`;
  const report = { total: set.length, processed: items.length - failed, failed, hotPicks, selectedWithoutUnderstand: await missingCopy(), usage };
  console.log(JSON.stringify(report));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await rerunRoleScores(); }
  finally { await stopBoss(); await closeDb(); }
}
