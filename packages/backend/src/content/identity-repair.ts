// Deterministic material identity repair.  This module never calls a provider: it only inspects
// stored URL/DOI/X identities and writes an auditable duplicate tombstone in a short transaction.
import { sql, type Db, type Tx } from "../db.ts";
import { doiFromUrl, identityKeyForUrl, identityRepairLockKeys, tweetIdFromUrl } from "../lib/url.ts";

export type RepairMode = "dry-run" | "apply";
export type RepairRunStatus = "running" | "dry-run" | "applied" | "failed" | "cancelled";
export type RepairCheckpointStatus = "pending" | "applied" | "skipped" | "failed";

type IdentityKind = "url" | "doi" | "x";

export interface IdentityCandidate {
  candidateKey: string;
  identityKind: IdentityKind;
  articleIds: string[];
  survivorId: string;
  duplicateIds: string[];
  evidence: Array<{ articleId: string; url: string; identityKey: string }>;
  manualConflict: boolean;
}

export interface RepairRunOptions {
  mode: RepairMode;
  /** The authenticated admin identity (`admin:<admin_users.id>`). */
  actor: string;
  reason: string;
  runId?: number;
}

export interface RepairRunReport {
  runId: number;
  mode: RepairMode;
  status: RepairRunStatus;
  candidates: number;
  applied: number;
  skipped: number;
  failed: number;
  mergedArticles: number;
  candidateDetails: IdentityCandidate[];
  error?: string;
}

export interface RepairRunStatusView {
  run: Record<string, unknown> | null;
  checkpoints: Array<Record<string, unknown>>;
}

interface CandidateRow {
  id: string;
  url: string;
  identity_key: string;
  discovered_at: Date;
  duplicate_of: string | null;
}

interface CandidateKey {
  key: string;
  kind: IdentityKind;
}

/** Pure deterministic identity extraction. Titles and model output are never considered. */
export function deterministicIdentityKey(url: string, storedIdentityKey?: string): CandidateKey | null {
  if (storedIdentityKey?.startsWith("url:") && storedIdentityKey.includes("#")) return { key: storedIdentityKey, kind: "url" };
  const tweet = tweetIdFromUrl(url);
  if (tweet) return { key: `x:${tweet}`, kind: "x" };
  const doi = doiFromUrl(url);
  if (doi) return { key: `doi:${doi}`, kind: "doi" };
  if (storedIdentityKey?.startsWith("url:") && storedIdentityKey.length > 4) return { key: storedIdentityKey, kind: "url" };
  const urlKey = identityKeyForUrl(url);
  return urlKey ? { key: urlKey, kind: "url" } : null;
}

function survivorFirst(a: CandidateRow, b: CandidateRow): boolean {
  const at = new Date(a.discovered_at).getTime();
  const bt = new Date(b.discovered_at).getTime();
  return at < bt || (at === bt && a.id < b.id);
}

function groupRows(rows: CandidateRow[]): IdentityCandidate[] {
  const groups = new Map<string, { kind: IdentityKind; rows: CandidateRow[] }>();
  for (const row of rows) {
    if (row.duplicate_of) continue;
    const key = deterministicIdentityKey(row.url, row.identity_key);
    if (!key) continue;
    const group = groups.get(key.key) ?? { kind: key.kind, rows: [] };
    group.rows.push(row);
    groups.set(key.key, group);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.rows.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([candidateKey, group]) => {
      const rowsSorted = [...group.rows].sort((a, b) => survivorFirst(a, b) ? -1 : 1);
      const survivor = rowsSorted[0]!;
      return {
        candidateKey,
        identityKind: group.kind,
        articleIds: rowsSorted.map((r) => r.id),
        survivorId: survivor.id,
        duplicateIds: rowsSorted.slice(1).map((r) => r.id),
        evidence: rowsSorted.map((r) => ({ articleId: r.id, url: r.url, identityKey: r.identity_key })),
        manualConflict: false,
      };
    });
}

async function candidateRows(db: Db): Promise<CandidateRow[]> {
  return db<CandidateRow[]>`SELECT id, url, identity_key, discovered_at, duplicate_of FROM articles WHERE duplicate_of IS NULL ORDER BY discovered_at, id`;
}

async function markManualConflicts(db: Db, candidates: IdentityCandidate[]): Promise<void> {
  for (const candidate of candidates) {
    const ids = candidate.articleIds;
    const [overrides, grouping] = await Promise.all([
      db<{ article_id: string }[]>`SELECT article_id FROM editorial_overrides WHERE article_id = ANY(${ids}::text[])`,
      db<{ article_id: string }[]>`SELECT article_id FROM grouping_overrides WHERE article_id = ANY(${ids}::text[])`,
    ]);
    candidate.manualConflict = new Set(overrides.map((r) => r.article_id)).size > 1 || new Set(grouping.map((r) => r.article_id)).size > 1;
  }
}

/** Scans all current articles without title similarity, model calls, or source configuration changes. */
export async function scanIdentityCandidates(db: Db = sql): Promise<IdentityCandidate[]> {
  const candidates = groupRows(await candidateRows(db));
  await markManualConflicts(db, candidates);
  return candidates;
}

export async function identityRepairRunStatus(runId: number, db: Db = sql): Promise<RepairRunStatusView> {
  const [run] = await db<Record<string, unknown>[]>`SELECT * FROM material_identity_repair_runs WHERE id = ${runId}`;
  const checkpoints = await db<Record<string, unknown>[]>`SELECT candidate_key, identity_kind, article_ids, survivor_id, duplicate_ids, status, detail, updated_at
    FROM material_identity_repair_checkpoints WHERE run_id = ${runId} ORDER BY candidate_key`;
  return { run: run ?? null, checkpoints };
}

async function assertAdminActor(actor: string, db: Db): Promise<void> {
  const match = /^admin:(\d+)$/.exec(actor.trim());
  if (!match) throw new Error("identity repair requires an authenticated admin actor (admin:<admin_users.id>)");
  const [row] = await db<{ id: number }[]>`SELECT id FROM admin_users WHERE id = ${Number(match[1])}`;
  if (!row) throw new Error(`identity repair admin ${match[1]} was not found`);
}

async function createRun(options: RepairRunOptions): Promise<number> {
  if (!options.actor.trim()) throw new Error("identity repair actor is required");
  if (!options.reason.trim()) throw new Error("identity repair reason is required");
  await assertAdminActor(options.actor, sql);
  if (options.runId !== undefined) {
    const [row] = await sql<{ id: number; mode: RepairMode; status: RepairRunStatus }[]>`SELECT id, mode, status FROM material_identity_repair_runs WHERE id = ${options.runId} FOR UPDATE`;
    if (!row) throw new Error(`identity repair run ${options.runId} not found`);
    if (row.mode !== options.mode) throw new Error(`identity repair run ${options.runId} mode mismatch`);
    if (row.status === "applied" || row.status === "dry-run") return row.id;
    await sql`UPDATE material_identity_repair_runs SET status = 'running', error = NULL, finished_at = NULL WHERE id = ${row.id}`;
    return row.id;
  }
  const [row] = await sql<{ id: number }[]>`INSERT INTO material_identity_repair_runs (mode, actor, reason) VALUES (${options.mode}, ${options.actor.trim()}, ${options.reason.trim()}) RETURNING id`;
  return row!.id;
}

async function upsertCheckpoint(tx: Tx, runId: number, candidate: IdentityCandidate, status: RepairCheckpointStatus, detail: unknown, survivorId = candidate.survivorId, duplicateIds = candidate.duplicateIds) {
  await tx`INSERT INTO material_identity_repair_checkpoints (run_id, candidate_key, identity_kind, article_ids, survivor_id, duplicate_ids, status, detail, updated_at)
    VALUES (${runId}, ${candidate.candidateKey}, ${candidate.identityKind}, ${candidate.articleIds}, ${survivorId}, ${duplicateIds}, ${status}, ${detail == null ? null : tx.json(detail as never)}, now())
    ON CONFLICT (run_id, candidate_key) DO UPDATE SET identity_kind = EXCLUDED.identity_kind, article_ids = EXCLUDED.article_ids,
      survivor_id = EXCLUDED.survivor_id, duplicate_ids = EXCLUDED.duplicate_ids, status = EXCLUDED.status, detail = EXCLUDED.detail, updated_at = now()`;
}

async function lockCandidate(tx: Tx, candidate: IdentityCandidate, rows: CandidateRow[]): Promise<void> {
  const keys = [...new Set(candidate.articleIds.flatMap((id) => {
    const row = rows.find((r) => r.id === id);
    return row ? identityRepairLockKeys(row.url) : [];
  }))].sort();
  for (const key of keys) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

async function applyCandidate(tx: Tx, runId: number, candidateKey: string): Promise<{ candidate: IdentityCandidate | null; detail: Record<string, unknown> }> {
  let rows = await candidateRows(tx);
  let candidate = groupRows(rows).find((c) => c.candidateKey === candidateKey) ?? null;
  if (!candidate) return { candidate: null, detail: { status: "skipped", reason: "candidate disappeared or was already repaired" } };
  await lockCandidate(tx, candidate, rows);
  rows = await candidateRows(tx);
  candidate = groupRows(rows).find((c) => c.candidateKey === candidateKey) ?? null;
  if (!candidate) return { candidate: null, detail: { status: "skipped", reason: "candidate disappeared or was already repaired" } };
  await markManualConflicts(tx, [candidate]);
  if (candidate.manualConflict) return { candidate, detail: { status: "skipped", reason: "manual override conflict" } };
  const locked = await tx<CandidateRow[]>`SELECT id, url, identity_key, discovered_at, duplicate_of FROM articles WHERE id = ANY(${candidate.articleIds}::text[]) ORDER BY id FOR UPDATE`;
  const byId = new Map(locked.map((row) => [row.id, row]));
  const survivor = byId.get(candidate.survivorId);
  const duplicates = candidate.duplicateIds.map((id) => byId.get(id)).filter((row): row is CandidateRow => !!row && !row.duplicate_of);
  if (!survivor || survivor.duplicate_of) return { candidate, detail: { status: "skipped", reason: "survivor changed" } };
  if (!duplicates.length) return { candidate, detail: { status: "skipped", reason: "duplicates changed" } };
  for (const duplicate of duplicates) {
    // Tombstone only. Every article-linked row stays on the duplicate id for audit and rollback.
    await tx`UPDATE articles SET duplicate_of = ${survivor.id}, processing_error = coalesce(processing_error, 'duplicate material; canonical article retained'), updated_at = now()
      WHERE id = ${duplicate.id} AND duplicate_of IS NULL`;
  }
  const detail = { status: "applied", tombstoned: duplicates.length, survivor: survivor.id, associationsPreserved: true };
  await upsertCheckpoint(tx, runId, candidate, "applied", detail, survivor.id, duplicates.map((row) => row.id));
  return { candidate, detail };
}

async function writeAudit(tx: Tx, runId: number, options: RepairRunOptions, before: unknown, after: unknown) {
  await tx`INSERT INTO audit_log (actor, action, subject, reason, before, after) VALUES (${options.actor.trim()}, 'material.identity_repair', ${`material-identity-repair:${runId}`}, ${options.reason.trim()},
    ${before == null ? null : tx.json(before as never)}, ${after == null ? null : tx.json(after as never)})`;
}

export async function runIdentityRepair(options: RepairRunOptions): Promise<RepairRunReport> {
  const runId = await createRun(options);
  const candidates = await scanIdentityCandidates();
  const report: RepairRunReport = { runId, mode: options.mode, status: "running", candidates: candidates.length, applied: 0, skipped: 0, failed: 0, mergedArticles: 0, candidateDetails: candidates };
  if (options.mode === "dry-run") {
    await sql.begin(async (tx) => {
      for (const candidate of candidates) await upsertCheckpoint(tx, runId, candidate, "pending", { status: "planned", manualConflict: candidate.manualConflict });
      report.status = "dry-run";
      await tx`UPDATE material_identity_repair_runs SET status = 'dry-run', finished_at = now(), checkpoint = ${tx.json({ candidates: candidates.length } as never)}, report = ${tx.json(report as never)} WHERE id = ${runId}`;
      await writeAudit(tx, runId, options, null, report);
    });
    return report;
  }
  for (const candidate of candidates) {
    try {
      const result = await sql.begin((tx) => applyCandidate(tx, runId, candidate.candidateKey));
      if (result.detail.status === "applied") { report.applied += 1; report.mergedArticles += Number(result.detail.tombstoned ?? 0); }
      else report.skipped += 1;
      if (result.candidate && result.detail.status !== "applied") await sql.begin((tx) => upsertCheckpoint(tx, runId, result.candidate!, "skipped", result.detail));
    } catch (error) {
      report.failed += 1;
      report.status = "failed";
      report.error = String(error);
      await sql.begin(async (tx) => {
        await upsertCheckpoint(tx, runId, candidate, "failed", { status: "failed", error: String(error) });
        await tx`UPDATE material_identity_repair_runs SET status = 'failed', finished_at = now(), error = ${String(error).slice(0, 2000)}, report = ${tx.json(report as never)} WHERE id = ${runId}`;
        await writeAudit(tx, runId, options, null, report);
      });
      return report;
    }
  }
  report.status = "applied";
  await sql.begin(async (tx) => {
    await tx`UPDATE material_identity_repair_runs SET status = 'applied', finished_at = now(), checkpoint = ${tx.json({ candidates: candidates.length, applied: report.applied } as never)}, report = ${tx.json(report as never)} WHERE id = ${runId}`;
    await writeAudit(tx, runId, options, null, report);
  });
  return report;
}
