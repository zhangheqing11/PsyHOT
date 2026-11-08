import { FEATURES } from "@aihot/industry/features";

/** Scope the role-scoring switch to one test and restore it even when the test fails. */
export async function withRoleScoring<T>(on: boolean, fn: () => T | Promise<T>): Promise<T> {
  const switches = FEATURES as { industryRoleScoring: boolean };
  const before = switches.industryRoleScoring;
  switches.industryRoleScoring = on;
  try {
    return await fn();
  } finally {
    switches.industryRoleScoring = before;
  }
}
