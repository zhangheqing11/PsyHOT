// Loads the reviewed unit prices in industry/service-prices.json into service_prices (receipts and the
// admin models page turn them into estimates). Upserts the rows the file lists, audits each change, and
// never deletes rows it does not list. Prices are entered from the provider's price page; a field left
// null means "not priced" and a running process picks up changes within a minute.
//   node --env-file=.env scripts/apply-service-prices.ts            # list the changes
//   node --env-file=.env scripts/apply-service-prices.ts --apply    # upsert and audit
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";

const ACTOR = "ops-script";
const REASON = "服务单价（industry/service-prices.json）";
const money = z.number().nonnegative().nullable();
const rowSchema = z.object({
  service: z.string().min(1),
  model: z.string().default(""),
  currency: z.enum(["CNY", "USD"]),
  input_per_mtok: money,
  cached_per_mtok: money,
  output_per_mtok: money,
  per_request: money,
  source_url: z.string().url().nullable(),
  verified_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  note: z.string().nullable(),
});
export type PriceRow = z.infer<typeof rowSchema>;
const FIELDS = ["currency", "input_per_mtok", "cached_per_mtok", "output_per_mtok", "per_request", "source_url", "verified_on", "note"] as const;

/** Returns the number of rows that differ; preview is the default and writes nothing. */
export async function applyServicePrices(input: unknown, opts: { apply?: boolean; report?: (line: string) => void } = {}): Promise<number> {
  const rows = z.array(rowSchema).parse(input);
  const report = opts.report ?? console.log;
  let changed = 0;
  for (const row of rows) {
    await sql.begin(async (tx) => {
      const [old] = await tx<Record<string, string | number | null>[]>`
        SELECT currency, input_per_mtok::float8 AS input_per_mtok, cached_per_mtok::float8 AS cached_per_mtok, output_per_mtok::float8 AS output_per_mtok,
               per_request::float8 AS per_request, source_url, verified_on::text AS verified_on, note
        FROM service_prices WHERE service = ${row.service} AND model = ${row.model} ${opts.apply ? tx`FOR UPDATE` : tx``}`;
      const diff = FIELDS.filter((f) => !old || old[f] !== row[f]);
      if (!diff.length) return;
      changed += 1;
      report(`${row.service}/${row.model || "*"}: ${old ? `更新 ${diff.join(", ")}` : "新增"}（${row.currency} 输入 ${row.input_per_mtok ?? "-"} 缓存 ${row.cached_per_mtok ?? "-"} 输出 ${row.output_per_mtok ?? "-"}）`);
      if (!opts.apply) return;
      await tx`
        INSERT INTO service_prices (service, model, currency, input_per_mtok, cached_per_mtok, output_per_mtok, per_request, source_url, verified_on, note)
        VALUES (${row.service}, ${row.model}, ${row.currency}, ${row.input_per_mtok}, ${row.cached_per_mtok}, ${row.output_per_mtok}, ${row.per_request}, ${row.source_url}, ${row.verified_on}, ${row.note})
        ON CONFLICT (service, model) DO UPDATE SET currency = EXCLUDED.currency, input_per_mtok = EXCLUDED.input_per_mtok, cached_per_mtok = EXCLUDED.cached_per_mtok,
          output_per_mtok = EXCLUDED.output_per_mtok, per_request = EXCLUDED.per_request, source_url = EXCLUDED.source_url, verified_on = EXCLUDED.verified_on,
          note = EXCLUDED.note, updated_at = now()`;
      await tx`INSERT INTO audit_log (actor, action, subject, reason, before, after)
        VALUES (${ACTOR}, 'service_prices.set', ${`price:${row.service}/${row.model}`}, ${REASON}, ${old ? tx.json(old as never) : null}, ${tx.json(row as never)})`;
    });
  }
  report(`${changed} of ${rows.length} prices ${opts.apply ? "applied" : "would change (run with --apply)"}`);
  return changed;
}

if (import.meta.main) {
  try {
    await applyServicePrices(JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/service-prices.json"), "utf8")), { apply: process.argv.includes("--apply") });
  } finally {
    await stopBoss();
    await closeDb();
  }
}
