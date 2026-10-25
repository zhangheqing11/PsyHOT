// @deprecated Legacy identity-repair entry point.  Historical versions moved or deleted
// article-linked records here.  That path is intentionally inert now: use content/identity-repair.ts
// and scripts/identity-repair.ts, whose apply operation writes only articles.duplicate_of.
import { sql } from "../db.ts";
import { scanIdentityCandidates } from "./identity-repair.ts";

export interface LegacyIdentityAudit {
  identity: string;
  keep: string;
  duplicates: string[];
  sources: string[];
}

/** Read-only compatibility report for operators of the retired command. */
export async function auditMaterialIdentities(): Promise<LegacyIdentityAudit[]> {
  const candidates = await scanIdentityCandidates();
  return Promise.all(candidates.map(async (candidate) => {
    const rows = await sql<{ source_id: string }[]>`SELECT DISTINCT source_id FROM articles WHERE id = ANY(${candidate.articleIds}::text[]) ORDER BY source_id`;
    return { identity: candidate.candidateKey, keep: candidate.survivorId, duplicates: candidate.duplicateIds, sources: rows.map((row) => row.source_id) };
  }));
}

/**
 * @deprecated Applying from this legacy API is forbidden because it has no authenticated admin
 * boundary.  Run `scripts/identity-repair.ts apply --actor admin:<id> --reason <reason>` instead.
 */
export async function repairMaterialIdentities(): Promise<never> {
  throw new Error("repairMaterialIdentities is retired; use scripts/identity-repair.ts with an authenticated admin actor");
}

/** @deprecated The retired consolidating repair no longer creates rebuild checkpoints. */
export async function rebuildMaterialIdentityRepairs(): Promise<{ rebuilt: 0 }> {
  return { rebuilt: 0 };
}
