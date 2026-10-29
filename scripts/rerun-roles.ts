// Re-analyses recent editorial items last filed in an industry category whose latest analysis uses older prompts,
// then republishes them. Academic items are left alone (the structure prompt only added the industry roles).
// Only structure uses --tag for a new request; other steps reuse receipts when request conditions are unchanged.
//   node --env-file=.env scripts/rerun-roles.ts --limit 20 --dry-run  # preview a sample
//   node --env-file=.env scripts/rerun-roles.ts                     # the whole set (skips items done)
// Waits for the provider's off-peak price unless --now. --dry-run only counts.
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { ANALYZE_PROMPT_VERSION, analyzeArticle } from "@aihot/backend/editorial/analyze";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { waitForOffPeak } from "@aihot/backend/lib/offpeak";

const { values } = parseArgs({
  options: {
    limit: { type: "string" },
    /** Only these articles (comma separated), if they are in the set. */
    ids: { type: "string" },
    days: { type: "string", default: "30" },
    concurrency: { type: "string", default: "3" },
    tag: { type: "string", default: "roles-2026-10" },
    "dry-run": { type: "boolean", default: false },
    now: { type: "boolean", default: false },
  },
});
const ATTEMPT = values.tag!;
// An empty list (a lookup that found nothing) must never fall through to the whole set.
if (values.ids !== undefined && !values.ids.split(",").some((id) => id.trim())) throw new Error("--ids is empty");

for (const key of ["days", "concurrency", "limit"] as const) {
  if (values[key] !== undefined && (!Number.isInteger(Number(values[key])) || Number(values[key]) < 1)) throw new Error(`--${key} must be a positive integer`);
}
const categories = CATEGORIES.filter((c) => c.track === "industry").map((c) => c.key);
const set = await sql<{ id: string }[]>`
  WITH latest AS (
    SELECT DISTINCT ON (article_id) article_id, category, prompt_version FROM analyses ORDER BY article_id, input_revision DESC, id DESC)
  SELECT a.id FROM articles a JOIN sources s ON s.id = a.source_id LEFT JOIN latest l ON l.article_id = a.id
  WHERE s.participation_mode = 'editorial' AND a.discovered_at > now() - make_interval(days => ${Number(values.days)})
    AND l.category = ANY(${categories}::text[])
    AND l.prompt_version IS DISTINCT FROM ${ANALYZE_PROMPT_VERSION}
    ${values.ids ? sql`AND a.id = ANY(${values.ids.split(",").map((id) => id.trim()).filter(Boolean)}::text[])` : sql``}
  ORDER BY md5(a.id)`;
const ids = set.map((r) => r.id).slice(0, values.limit ? Number(values.limit) : undefined);
console.log(`${set.length} items left in the set; running ${ids.length}`);
if (values["dry-run"] || !ids.length) {
  await closeDb();
  process.exit(0);
}
await waitForOffPeak("rerun-roles");

const started = Date.now();
const startedAt = new Date(started);
const receiptIds: number[] = [];
let failed = 0;
let next = 0;
await Promise.all(Array.from({ length: Number(values.concurrency) }, async () => {
  while (next < ids.length) {
    const id = ids[next++]!;
    try {
      const result = await analyzeArticle(id, { structureAttemptTag: ATTEMPT });
      receiptIds.push(...(result?.receiptIds ?? []));
      await publishArticle(id);
    } catch (error) {
      failed += 1;
      console.log(`${id}: ${String(error).slice(0, 200)}`);
    }
  }
}));

const [cost] = await sql<{ n: number; attempts: number; unknown: number; reused: number; cost: string | null; estimated: number; tin: string | null; tout: string | null }[]>`
  WITH attempts AS (
    SELECT a.* FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
    WHERE a.started_at >= ${startedAt}
      AND (r.id = ANY(${[...new Set(receiptIds)]}::bigint[]) OR split_part(r.subject, '@', 1) = ANY(${ids.map((id) => `article:${id}`)}::text[]))
  )
  SELECT count(DISTINCT receipt_id)::int AS n, count(*)::int AS attempts,
         count(*) FILTER (WHERE cost IS NULL)::int AS unknown,
         (SELECT count(*)::int FROM receipts r WHERE r.id = ANY(${[...new Set(receiptIds)]}::bigint[])
            AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.receipt_id = r.id)) AS reused,
         sum(cost) AS cost, count(*) FILTER (WHERE cost_basis = 'estimated')::int AS estimated,
         sum(coalesce((usage->>'prompt_tokens')::int, 0)) AS tin, sum(coalesce((usage->>'completion_tokens')::int, 0)) AS tout
  FROM attempts`;
const outcome = await sql`
  SELECT an.category, an.output->>'impact' AS impact,
         jsonb_array_length(coalesce(an.output->'roles', '[]'::jsonb)) AS role_count, count(*)::int AS n
  FROM (SELECT DISTINCT ON (article_id) * FROM analyses WHERE article_id = ANY(${ids}::text[]) ORDER BY article_id, input_revision DESC, id DESC) an
  GROUP BY 1, 2, 3 ORDER BY 4 DESC`;
const per = ids.length - failed ? Number(cost?.cost ?? 0) / (ids.length - failed) : 0;
console.log(JSON.stringify({
  items: ids.length, failed, minutes: +((Date.now() - started) / 60000).toFixed(1),
  receipts: cost?.n, attempts: cost?.attempts, unknownCostAttempts: cost?.unknown, reusedReceipts: cost?.reused, estimatedCost: cost?.estimated, tokensIn: Number(cost?.tin ?? 0), tokensOut: Number(cost?.tout ?? 0),
  cost: Number(cost?.cost ?? 0), costPerItem: +per.toFixed(5), projectedForRest: +(per * (set.length - ids.length)).toFixed(2),
}, null, 1));
console.table(outcome);
await stopBoss();
await closeDb();
