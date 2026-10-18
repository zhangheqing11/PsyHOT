// Re-analyses the last 30 days of the items the tracks change touches (handoff-academic-industry-tracks.md,
// decision 13): items last filed as 行业 or 观点, and everything from the industry sources added since
// 2026-10-05. Each is analysed again under the current prompts (a new paid request per step, through
// the receipts and budgets) and republished; published reports are not touched, and no event grouping
// runs here (the worker regroups an item when it is next queued).
//   node --env-file=.env scripts/rerun-tracks.ts --limit 20          # a cost trial on a stable sample
//   node --env-file=.env scripts/rerun-tracks.ts                      # the whole set (skips items done)
// Waits for the provider's off-peak price unless --now. --dry-run only counts.
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
    since: { type: "string", default: "2026-10-05" },
    concurrency: { type: "string", default: "3" },
    tag: { type: "string", default: "tracks-2026-10" },
    "dry-run": { type: "boolean", default: false },
    now: { type: "boolean", default: false },
  },
});
const ATTEMPT = values.tag!;
// An empty list (a lookup that found nothing) must never fall through to the whole set.
if (values.ids !== undefined && !values.ids.split(",").some((id) => id.trim())) throw new Error("--ids is empty");

// The set: ever filed as 行业 or 观点 (judgements are append-only, so an item a run already moved stays
// in it), or from a new industry source. Left to do: its latest analysis is not under the current prompts.
const set = await sql<{ id: string }[]>`
  WITH latest AS (
    SELECT DISTINCT ON (article_id) article_id, prompt_version FROM analyses ORDER BY article_id, input_revision DESC, id DESC)
  SELECT a.id FROM articles a JOIN sources s ON s.id = a.source_id LEFT JOIN latest l ON l.article_id = a.id
  WHERE s.participation_mode = 'editorial' AND a.discovered_at > now() - make_interval(days => ${Number(values.days)})
    AND (EXISTS (SELECT 1 FROM analyses x WHERE x.article_id = a.id AND x.category IN ('industry', 'opinion')) OR s.created_at >= ${values.since!}::date)
    AND l.prompt_version IS DISTINCT FROM ${ANALYZE_PROMPT_VERSION}
    ${values.ids ? sql`AND a.id = ANY(${values.ids.split(",")}::text[])` : sql``}
  ORDER BY md5(a.id)`;
const ids = set.map((r) => r.id).slice(0, values.limit ? Number(values.limit) : undefined);
console.log(`${set.length} items left in the set; running ${ids.length}`);
if (values["dry-run"] || !ids.length) {
  await closeDb();
  process.exit(0);
}
await waitForOffPeak("rerun-tracks");

const started = Date.now();
const receiptIds: number[] = [];
let failed = 0;
let next = 0;
await Promise.all(Array.from({ length: Number(values.concurrency) }, async () => {
  while (next < ids.length) {
    const id = ids[next++]!;
    try {
      const result = await analyzeArticle(id, { attemptTag: ATTEMPT });
      receiptIds.push(...(result?.receiptIds ?? []));
      await publishArticle(id);
    } catch (error) {
      failed += 1;
      console.log(`${id}: ${String(error).slice(0, 200)}`);
    }
  }
}));

const [cost] = await sql<{ n: number; cost: string | null; estimated: number; tin: string | null; tout: string | null }[]>`
  SELECT count(*)::int AS n, sum(cost) AS cost, count(*) FILTER (WHERE cost_basis = 'estimated')::int AS estimated,
         sum(coalesce((usage->>'prompt_tokens')::int, 0)) AS tin, sum(coalesce((usage->>'completion_tokens')::int, 0)) AS tout
  FROM receipts WHERE id = ANY(${[...new Set(receiptIds)]}::bigint[])`;
const outcome = await sql<{ category: string | null; relevance: string; selected: boolean; promotion: boolean; n: number }[]>`
  SELECT an.category, an.relevance, coalesce(an.selected, false) AS selected, coalesce((an.output->>'promotion')::boolean, false) AS promotion, count(*)::int AS n
  FROM (SELECT DISTINCT ON (article_id) * FROM analyses WHERE article_id = ANY(${ids}::text[]) ORDER BY article_id, input_revision DESC, id DESC) an
  GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC`;
const per = ids.length - failed ? Number(cost?.cost ?? 0) / (ids.length - failed) : 0;
console.log(JSON.stringify({
  items: ids.length, failed, minutes: +((Date.now() - started) / 60000).toFixed(1),
  receipts: cost?.n, estimatedCost: cost?.estimated, tokensIn: Number(cost?.tin ?? 0), tokensOut: Number(cost?.tout ?? 0),
  cost: Number(cost?.cost ?? 0), costPerItem: +per.toFixed(5), projectedForRest: +(per * (set.length - ids.length)).toFixed(2),
}, null, 1));
console.table(outcome);
await stopBoss();
await closeDb();
