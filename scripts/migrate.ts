// Applies database/migrations/*.sql in order, each in its own transaction. Safe to re-run.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { repairMaterialIdentities, rebuildMaterialIdentityRepairs } from "@aihot/backend/content/repair-identities";
import { stopBoss } from "@aihot/backend/jobs/queue";

const dir = path.join(REPO_ROOT, "database/migrations");

await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));

let count = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  if (applied.has(file)) continue;
  const text = readFileSync(path.join(dir, file), "utf8");
  await sql.begin(async (tx) => {
    await tx.unsafe(text);
    await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
  });
  console.log(`applied ${file}`);
  count += 1;
}
console.log(count === 0 ? "database is up to date" : `${count} migration(s) applied`);
// Idempotent data repair follows schema changes before collectors start. It also resumes a rebuild
// interrupted after its consolidation transaction committed.
console.log("material identity repair", await repairMaterialIdentities(), await rebuildMaterialIdentityRepairs());
await stopBoss();
await closeDb();
