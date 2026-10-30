// Export pending scheduled WeChat checks before optionally cancelling them; active and manual jobs stay.
// Use a fresh --out path each time; existing snapshots are never overwritten.
// node --env-file=.env scripts/cancel-stale-mp-jobs.ts --out mp-jobs.json          # dry-run
// node --env-file=.env scripts/cancel-stale-mp-jobs.ts --out mp-jobs-apply.json --apply  # cancel exported jobs
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";

interface StaleMpJob {
  id: string;
  singleton_key: string | null;
  state: string;
  created_on: Date;
  start_after: Date;
  retry_count: number;
  data: Record<string, unknown>;
}

export function staleMpJobs() {
  return sql<StaleMpJob[]>`
    SELECT id, singleton_key, state, created_on, start_after, retry_count, data
    FROM pgboss.job
    WHERE name = ${QUEUES.mpCheck} AND state IN ('created', 'retry')
      AND coalesce(data->>'reason', 'schedule') = 'schedule'
    ORDER BY singleton_key, created_on, id`;
}

async function main() {
  try {
    const { values } = parseArgs({ options: { out: { type: "string" }, apply: { type: "boolean", default: false } } });
    if (!values.out) throw new Error("--out <path> is required (JSON export before cancellation)");
    const jobs = await staleMpJobs();
    const counts = new Map<string | null, number>();
    for (const job of jobs) counts.set(job.singleton_key, (counts.get(job.singleton_key) ?? 0) + 1);
    console.log(`Before: ${jobs.length} scheduled created/retry job(s)`);
    for (const [key, count] of counts) console.log(`${key ?? "(no singleton_key)"}: ${count}`);
    // Refuse to overwrite an earlier snapshot; cancellation only starts after a complete export.
    writeFileSync(values.out, JSON.stringify(jobs, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(`Dry-run exported to ${values.out}`);

    let cancelled = 0;
    if (values.apply && jobs.length) {
      const boss = await getBoss();
      for (let i = 0; i < jobs.length; i += 100) {
        const ids = jobs.slice(i, i + 100).map((j) => j.id);
        cancelled += await sql.begin(async (tx) => {
          // cancel() also accepts active jobs: recheck and lock so a worker cannot claim these rows.
          const pending = await tx<{ id: string }[]>`
            SELECT id FROM pgboss.job WHERE name = ${QUEUES.mpCheck} AND id IN ${tx(ids)}
              AND state IN ('created', 'retry') AND coalesce(data->>'reason', 'schedule') = 'schedule'
            ORDER BY id FOR UPDATE SKIP LOCKED`;
          if (pending.length) {
            const db = { executeSql: async (text: string, values?: unknown[]) => ({ rows: await tx.unsafe(text, (values ?? []) as never[]) }) };
            await boss.cancel(QUEUES.mpCheck, pending.map((j) => j.id), { db });
          }
          return pending.length;
        });
      }
    }
    console.log(`${cancelled} job(s) cancelled${values.apply ? "" : " (dry-run; run with --apply to cancel)"}`);
    console.log(`After: ${(await staleMpJobs()).length} scheduled created/retry job(s)`);
  } finally {
    await stopBoss();
    await closeDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
