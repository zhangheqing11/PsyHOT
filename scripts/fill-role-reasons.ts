// Fill selected copy after rerun-role-scores: reuse that rerun's role receipt, then analyze and republish.
//   node --env-file=.env scripts/fill-role-reasons.ts --limit 20 --concurrency 3 --dry-run
// Requires FEATURES.industryRoleScoring. Dry runs only read; hot picks are never recalculated here.
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { industryRoleScoringOn } from "@aihot/contracts/taxonomy";
import { closeDb, sql } from "@aihot/backend/db";
import { analyzeArticle, PROMPT_VERSIONS } from "@aihot/backend/editorial/analyze";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";

type CopyState = { selectedRoles: string[]; category: string | null; writer: string | null; reason: string | null };

export async function fillRoleReasons(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    limit: { type: "string" }, concurrency: { type: "string", default: "3" },
    "dry-run": { type: "boolean", default: false },
  } });
  if (!industryRoleScoringOn()) throw new Error("请先打开 FEATURES.industryRoleScoring，再运行 fill-role-reasons（含 --dry-run）。");
  for (const key of ["limit", "concurrency"] as const) {
    if (values[key] !== undefined && (!Number.isSafeInteger(Number(values[key])) || Number(values[key]) < 1)) throw new Error(`--${key} must be a positive integer`);
  }
  const set = await sql<(CopyState & { id: string; rerun_tag: string })[]>`
    SELECT a.id, p.selected_roles AS "selectedRoles", an.category, an.output->>'writer' AS writer, p.reason,
      an.output->'roleScoring'->>'rerunTag' AS rerun_tag
    FROM publications p JOIN articles a ON a.id = p.article_id JOIN analyses an ON an.id = p.analysis_id
    WHERE p.selected AND cardinality(p.selected_roles) > 0
      AND an.output->>'writer' IS DISTINCT FROM 'understand'
      AND nullif(btrim(an.output->'roleScoring'->>'rerunTag'), '') IS NOT NULL
      AND an.output->'roleScoring'->>'promptVersion' = ${PROMPT_VERSIONS.roles}
      AND an.input_revision = a.revision
    ORDER BY a.discovered_at DESC, a.id`;
  const items = set.slice(0, values.limit ? Number(values.limit) : undefined);
  const ids = items.map((r) => r.id);
  console.log(`${set.length} items left in the set; running ${items.length}${values["dry-run"] ? " (dry-run)" : ""}`);
  if (values["dry-run"]) {
    const report = { total: set.length, ids, dryRun: true };
    console.log(JSON.stringify(report));
    return report;
  }

  const [started] = await sql<{ at: string }[]>`SELECT clock_timestamp()::text AS at`;
  const changed: Array<{ id: string; before: CopyState; after: CopyState }> = [];
  let next = 0;
  let failed = 0;
  await Promise.all(Array.from({ length: Number(values.concurrency) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      const before: CopyState = { selectedRoles: item.selectedRoles, category: item.category, writer: item.writer, reason: item.reason };
      try {
        const result = await analyzeArticle(item.id, { roleAttemptTag: item.rerun_tag });
        if (!result) throw new Error("article no longer exists");
        if (result.needsBody) throw new Error("article needs body before analysis");
        if (result.stale) throw new Error("article changed during analysis; rerun later");
        if (!result.analysisId || !result.output) throw new Error("analysis produced no result");
        if (!await publishArticle(item.id)) throw new Error("publication no longer exists");
        const [after] = await sql<CopyState[]>`
          SELECT p.selected_roles AS "selectedRoles", p.category, an.output->>'writer' AS writer, p.reason
          FROM publications p JOIN analyses an ON an.id = p.analysis_id WHERE p.article_id = ${item.id}`;
        if (!after) throw new Error("publication no longer exists");
        if (JSON.stringify(after.selectedRoles) !== JSON.stringify(before.selectedRoles) || after.category !== before.category
          || after.writer !== "understand" || !after.reason?.trim()) changed.push({ id: item.id, before, after });
      } catch (error) {
        failed += 1;
        console.error(`${item.id}: ${String(error).slice(0, 200)}`);
      }
    }
  }));
  const [missing] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM publications
    WHERE article_id = ANY(${ids}::text[]) AND selected AND nullif(btrim(reason), '') IS NULL`;
  const [usage] = await sql<{ attempts: number; cost: number | null; tokens_in: number | null; tokens_out: number | null }[]>`
    SELECT count(*)::int AS attempts, sum(ra.cost) AS cost,
      sum(coalesce((ra.usage->>'prompt_tokens')::int, 0)) AS tokens_in, sum(coalesce((ra.usage->>'completion_tokens')::int, 0)) AS tokens_out
    FROM receipt_attempts ra JOIN receipts r ON r.id = ra.receipt_id
    WHERE split_part(r.subject, '@', 1) = ANY(${ids.map((id) => `article:${id}`)}::text[])
      AND ra.started_at >= ${started!.at}::timestamptz`;
  const report = { total: set.length, processed: items.length - failed, failed, changed, stillMissing: missing!.n, usage: usage! };
  console.log(JSON.stringify(report));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await fillRoleReasons(); }
  finally { await stopBoss(); await closeDb(); }
}
