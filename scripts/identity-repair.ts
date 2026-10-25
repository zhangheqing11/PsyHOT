// Deterministic material identity repair.
//
//   node --env-file=.env scripts/identity-repair.ts dry-run --actor admin:... --reason "..."
//   node --env-file=.env scripts/identity-repair.ts status --run <id>
//
// Apply is retired here; approved historical consolidation runs through
// scripts/repair-material-identities.ts --apply after a dry-run review.
import { parseArgs } from "node:util";
import { closeDb } from "@aihot/backend/db";
import { identityRepairRunStatus, runIdentityRepair } from "@aihot/backend/content/identity-repair";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    actor: { type: "string" },
    reason: { type: "string" },
    run: { type: "string" },
  },
});

const command = positionals[0];
if (command !== "dry-run" && command !== "apply" && command !== "status") throw new Error("usage: identity-repair.ts dry-run|apply --actor <admin> --reason <reason> [--run <id>] | status --run <id>");
if (command === "status") {
  if (!values.run) throw new Error("status requires --run <id>");
  try {
    console.log(JSON.stringify(await identityRepairRunStatus(Number(values.run)), null, 2));
  } finally {
    await closeDb();
  }
  process.exit(0);
}
if (!values.actor || !values.reason) throw new Error("--actor and --reason are required");

try {
  const report = await runIdentityRepair({
    mode: command,
    actor: values.actor,
    reason: values.reason,
    runId: values.run ? Number(values.run) : undefined,
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "failed") process.exitCode = 1;
} finally {
  await closeDb();
}
