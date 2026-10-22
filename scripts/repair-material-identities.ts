// Audit by default; --apply also repairs and rebuilds all affected rankings and hourly heat.
import { auditMaterialIdentities, repairMaterialIdentities, rebuildMaterialIdentityRepairs } from "@aihot/backend/content/repair-identities";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";

try {
  console.log(JSON.stringify({ audit: await auditMaterialIdentities() }, null, 2));
  if (process.argv.includes("--apply")) {
    console.log(JSON.stringify({ repair: await repairMaterialIdentities(), rebuild: await rebuildMaterialIdentityRepairs() }, null, 2));
  }
} finally {
  await stopBoss();
  await closeDb();
}
