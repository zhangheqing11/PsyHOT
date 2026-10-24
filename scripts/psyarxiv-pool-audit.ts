// Production read-only snapshot; writes no judgement and never chooses/applies a score floor.
// node --env-file=.env scripts/psyarxiv-pool-audit.ts [--output /private/path/psyarxiv.json]
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";

const { values } = parseArgs({ options: { output: { type: "string" } } });
try {
  const snapshot = await sql.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    const [window] = await tx<{ as_of: Date; since: Date }[]>`SELECT now() AS as_of, now() - interval '14 days' AS since`;
    const rows = await tx<{ article_id: string; title: string; summary: string | null; score: number | null; eligible: boolean; url: string; timeline_at: Date }[]>`
      SELECT article_id, title, summary, score, eligible, url, timeline_at FROM publications
      WHERE source_id = 'json-psyarxiv' AND visibility = 'public'
        AND (NOT selected OR visible_after <= now())
        AND timeline_at >= now() - interval '14 days' AND timeline_at <= now()
      ORDER BY md5(article_id)`;
    const buckets = [[0, 30], [30, 35], [35, 40], [40, 45], [45, 50], [50, 101]].map(([min, max]) => {
      const all = rows.filter((r) => r.score !== null && r.score >= min! && r.score < max!);
      const pool = all.filter((r) => r.eligible);
      return { range: `[${min}, ${max})`, stored: all.length, inPool: pool.length, samples: pool.slice(0, 5) };
    });
    const days = await tx`
      SELECT (timeline_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day,
             count(*) FILTER (WHERE eligible)::int AS all_pool,
             count(*) FILTER (WHERE eligible AND source_id = 'json-psyarxiv')::int AS psyarxiv_pool
      FROM publications WHERE visibility = 'public'
        AND (NOT selected OR visible_after <= now())
        AND timeline_at >= now() - interval '14 days' AND timeline_at <= now()
      GROUP BY 1 ORDER BY 1`;
    const bluesky = await tx`
      SELECT (a.discovered_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day, count(*)::int AS collected,
             count(*) FILTER (WHERE a.duplicate_of IS NULL)::int AS distinct_materials
      FROM articles a JOIN sources s ON s.id = a.source_id
      WHERE s.config->>'adapter' = 'bluesky_feed' AND a.discovered_at >= now() - interval '14 days' AND a.discovered_at <= now()
      GROUP BY 1 ORDER BY 1`;
    return { ...window, definition: "14 rolling days by timeline_at; public publications; samples from currently eligible pool, deterministic md5(article_id) order; Shanghai calendar days; first/last days can be partial", stored: rows.length,
      unscored: rows.filter((r) => r.score === null).length, buckets,
      thresholds: [30, 35, 40, 45, 50].map((score) => ({ score, retained: rows.filter((r) => r.eligible && r.score !== null && r.score >= score).length })), days, bluesky };
  });
  const output = JSON.stringify(snapshot, null, 2) + "\n";
  if (values.output) writeFileSync(values.output, output, { encoding: "utf8", mode: 0o600 });
  else process.stdout.write(output);
} finally {
  await closeDb();
}
