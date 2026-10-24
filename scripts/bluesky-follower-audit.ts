// Read-only: free public profile lookup + a 30-day heat snapshot, never paid calls or source updates.
// node --env-file=.env scripts/bluesky-follower-audit.ts [--output /private/path/bluesky.csv]
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export interface AuditSource {
  id: string;
  name: string;
  tier: string;
  config: { url?: string };
  signals_30d: number;
}

export function actorDid(source: AuditSource): string {
  const actor = new URL(source.config.url ?? "").searchParams.get("actor");
  if (!actor?.startsWith("did:")) throw new Error(`Missing actor DID: ${source.id}`);
  return actor;
}

export function recommendation(tier: string, followers: number, signals: number): "保留" | "停用" {
  return tier === "T1" || followers >= 5000 || signals > 0 ? "保留" : "停用";
}

export async function followerCounts(actors: string[], request: typeof fetch = fetch): Promise<Map<string, number>> {
  const unique = [...new Set(actors)];
  const counts = new Map<string, number>();
  for (let i = 0; i < unique.length; i += 25) {
    const batch = unique.slice(i, i + 25);
    const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles");
    for (const actor of batch) url.searchParams.append("actors", actor);
    const response = await request(url, { signal: AbortSignal.timeout(20_000), redirect: "error" });
    if (!response.ok) throw new Error(`Bluesky profiles HTTP ${response.status}`);
    const data = await response.json() as { profiles?: Array<{ did: string; followersCount?: number }> };
    if (!Array.isArray(data.profiles)) throw new Error("Bluesky profiles missing");
    for (const profile of data.profiles) {
      const count = profile.followersCount;
      if (batch.includes(profile.did) && typeof count === "number" && Number.isSafeInteger(count) && count >= 0) counts.set(profile.did, count);
    }
    // A missing/deactivated account or an incomplete response is not evidence of zero followers.
    for (const actor of batch) if (!counts.has(actor)) throw new Error(`Bluesky follower count unavailable: ${actor}`);
  }
  return counts;
}

export function auditCsv(sources: AuditSource[], followers: Map<string, number>): string {
  const cell = (v: string | number) => {
    const s = String(v);
    // Quote CSV delimiters and keep imported names from becoming spreadsheet formulas.
    return `"${(/^[=+@\-\t\r]/.test(s) ? "'" + s : s).replaceAll('"', '""')}"`;
  };
  const rows: Array<Array<string | number>> = [["id", "名称", "tier", "粉丝数", "30天热度记录数", "建议"]];
  for (const source of sources) {
    const count = followers.get(actorDid(source));
    if (count === undefined) throw new Error(`Missing followers: ${source.id}`);
    rows.push([source.id, source.name, source.tier, count, source.signals_30d, recommendation(source.tier, count, source.signals_30d)]);
  }
  return "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

async function main() {
  const { values } = parseArgs({ options: { output: { type: "string" } } });
  const { closeDb, sql } = await import("@aihot/backend/db");
  try {
    const sources = await sql.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;
      return tx<AuditSource[]>`
        SELECT s.id, s.name, s.tier, s.config, count(ss.article_id)::int AS signals_30d
        FROM sources s LEFT JOIN story_signals ss ON ss.source_id = s.id
          AND ss.observed_at >= now() - interval '30 days' AND ss.observed_at <= now()
        WHERE s.config->>'adapter' = 'bluesky_feed'
        GROUP BY s.id ORDER BY s.tier, s.id`;
    });
    const followers = await followerCounts(sources.map(actorDid));
    const csv = auditCsv(sources, followers);
    if (values.output) writeFileSync(values.output, csv, { encoding: "utf8", mode: 0o600 });
    else process.stdout.write(csv);
    console.error(JSON.stringify({ asOf: new Date().toISOString(), accounts: sources.length, keep: sources.filter((s) => recommendation(s.tier, followers.get(actorDid(s))!, s.signals_30d) === "保留").length }));
  } finally {
    await closeDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
