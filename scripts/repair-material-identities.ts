// Audit by default; --apply also repairs and rebuilds all affected rankings and hourly heat.
import { parseArgs } from "node:util";
import { assertAdminActor } from "@aihot/backend/content/identity-repair";
import { auditMaterialIdentities, repairMaterialIdentities, rebuildMaterialIdentityRepairs } from "@aihot/backend/content/repair-identities";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";

const { values } = parseArgs({
  options: {
    actor: { type: "string" },
    apply: { type: "boolean" },
    reason: { type: "string" },
  },
});

try {
  if (!values.apply) {
    console.log(JSON.stringify({ audit: await auditMaterialIdentities() }, null, 2));
  } else {
    if (!values.actor || !/^admin:\d+$/.test(values.actor.trim())) {
      throw new Error("--apply requires --actor admin:<admin_users.id>");
    }
    if (!values.reason?.trim()) throw new Error("--apply requires --reason <reason>");
    await assertAdminActor(values.actor, sql);
    const result = { repair: await repairMaterialIdentities(), rebuild: await rebuildMaterialIdentityRepairs() };
    const subject = `material-identity-repair:legacy-${Date.now()}`;
    await sql`INSERT INTO audit_log (actor, action, subject, reason, before, after)
      VALUES (${values.actor.trim()}, 'material.identity_repair.legacy_apply', ${subject}, ${values.reason.trim()}, NULL, ${sql.json(result as never)})`;
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  await stopBoss();
  await closeDb();
}
