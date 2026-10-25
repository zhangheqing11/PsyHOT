// Compatibility wrapper. Prefer scripts/identity-repair.ts directly.
import { parseArgs } from "node:util";
import { closeDb } from "@aihot/backend/db";
import { identityRepairRunStatus, runIdentityRepair, scanIdentityCandidates } from "@aihot/backend/content/identity-repair";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { actor: { type: "string" }, reason: { type: "string" }, run: { type: "string" } } });
const command = positionals[0] ?? "dry-run";
if (!["audit", "dry-run", "apply", "status"].includes(command)) throw new Error("usage: repair-material-identities.ts audit|dry-run|apply|status");
try {
  if (command === "audit") console.log(JSON.stringify(await scanIdentityCandidates(), null, 2));
  else if (command === "status") {
    if (!values.run) throw new Error("status requires --run <id>");
    console.log(JSON.stringify(await identityRepairRunStatus(Number(values.run)), null, 2));
  } else {
    if (!values.actor || !values.reason) throw new Error("--actor and --reason are required");
    console.log(JSON.stringify(await runIdentityRepair({ mode: command, actor: values.actor, reason: values.reason, runId: values.run ? Number(values.run) : undefined }), null, 2));
  }
} finally {
  await closeDb();
}
