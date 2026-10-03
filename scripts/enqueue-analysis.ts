// Enqueues analysis for articles (development helper). By default only editorial articles that have
// no live model analysis yet; --all re-runs everything (receipts make repeats free).
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { enqueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { waitForOffPeak } from "@aihot/backend/lib/offpeak";

const { values } = parseArgs({ options: { all: { type: "boolean", default: false }, limit: { type: "string", default: "1000" }, now: { type: "boolean", default: false } } });
// The worker starts on these at once, so they are sent off-peak.
await waitForOffPeak("enqueue-analysis");
const rows = await sql<{ id: string }[]>`
  SELECT a.id FROM articles a JOIN sources s ON s.id = a.source_id
  WHERE s.participation_mode = 'editorial'
    ${values.all ? sql`` : sql`AND NOT EXISTS (SELECT 1 FROM analyses an WHERE an.article_id = a.id AND an.origin = 'model')`}
  ORDER BY a.discovered_at DESC LIMIT ${Number(values.limit)}`;
for (const r of rows) await enqueue(QUEUES.analyze, { articleId: r.id }, { singletonKey: r.id });
console.log(`enqueued ${rows.length}`);
await stopBoss();
await closeDb();
