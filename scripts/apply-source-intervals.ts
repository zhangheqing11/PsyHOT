// Restores configured interval floors from industry/sources.json for existing sources (seed only
// inserts new ones), only for sources managed by automatic interval adaptation (paused ones too).
// EveryInfra, X shards and other manually scheduled kinds are skipped. Raises the actual interval
// only when it is below that floor. Each write and its before/after audit are atomic; next_fetch_at
// is never changed, preserving staggered fetch times.
//   node --env-file=.env scripts/apply-source-intervals.ts            # list changes only
//   node --env-file=.env scripts/apply-source-intervals.ts --apply    # apply and audit
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { assertPaidInterval } from "@aihot/backend/sources/config-keys";
import { sourceIntervalMode } from "@aihot/backend/sources/collect";
import type { SourceRow } from "@aihot/backend/sources/types";

interface ConfiguredSource { id: string; interval_minutes?: number }
const intervalSchema = z.number().int().min(1).max(10080).default(60);
const ACTOR = "ops-script";
const REASON = "恢复配置的最短抓取间隔（industry/sources.json）";

/** Returns the number of existing sources that differ; preview is the default and writes no rows. */
export async function applySourceIntervals(sources: ConfiguredSource[], opts: { apply?: boolean; report?: (line: string) => void } = {}): Promise<number> {
  const wanted = new Map(sources.map((s) => [s.id, intervalSchema.parse(s.interval_minutes)]));
  const report = opts.report ?? console.log;
  const rows = wanted.size ? await sql<{ id: string }[]>`SELECT id FROM sources WHERE id IN ${sql([...wanted.keys()])} ORDER BY id` : [];
  let changed = 0;
  let skipped = 0;
  for (const { id } of rows) {
    changed += await sql.begin(async (tx) => {
      const [r] = await tx<Array<Pick<SourceRow, "name" | "kind" | "config" | "cursor" | "interval_minutes"> & { min_interval_minutes: number | null }>>`
        SELECT name, kind, config, cursor, interval_minutes, min_interval_minutes FROM sources WHERE id = ${id} ${opts.apply ? tx`FOR UPDATE` : tx``}`;
      if (!r) return 0;
      if (sourceIntervalMode(r) !== "adaptive") { skipped += 1; return 0; }
      const minimum = wanted.get(id)!;
      const actual = Math.max(r.interval_minutes, minimum);
      assertPaidInterval(r.kind, r.config, minimum);
      if (r.min_interval_minutes === minimum && r.interval_minutes === actual) return 0;
      report(`${id}（${r.name}）: 配置 ${r.min_interval_minutes ?? "未设置"} → ${minimum} 分；实际 ${r.interval_minutes} → ${actual} 分`);
      if (opts.apply) {
        await tx`UPDATE sources SET min_interval_minutes = ${minimum}, interval_minutes = ${actual}, updated_at = now() WHERE id = ${id}`;
        await tx`INSERT INTO audit_log (actor, action, subject, reason, before, after)
          VALUES (${ACTOR}, 'source.update', ${`source:${id}`}, ${REASON},
            ${tx.json({ interval_minutes: r.interval_minutes, min_interval_minutes: r.min_interval_minutes })},
            ${tx.json({ interval_minutes: actual, min_interval_minutes: minimum })})`;
      }
      return 1;
    });
  }
  report(`${changed} sources ${opts.apply ? "updated" : "would change (run with --apply)"}`);
  report(`跳过 ${skipped} 个由站长手动设定间隔的源`);
  return changed;
}

if (import.meta.main) {
  try {
    const { sources } = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")) as { sources: ConfiguredSource[] };
    const apply = process.argv.includes("--apply");
    await applySourceIntervals(sources, { apply });
  } finally {
    await stopBoss();
    await closeDb();
  }
}
