// Export the existing public WeChat corpus for local analysis only.
// Refuses non-local databases and never calls a collector or model.
// Example:
//   DATABASE_URL=postgres://psyhot:psyhot@127.0.0.1:55432/psyhot_prodcopy_test \
//     node scripts/export-wechat-corpus.ts --output .data/wechat-corpus-2026-10-25.jsonl
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";

interface Row {
  id: string;
  revision: number;
  title: string;
  original_title: string | null;
  summary: string | null;
  url: string;
  published_at: Date | null;
  discovered_at: Date;
  timeline_at: Date;
  visible_after: Date | null;
  backfill: boolean;
  body_status: string;
  body_text: string | null;
  category: string | null;
  tags: string[];
  score: number | null;
  selected: boolean;
  eligible: boolean;
  promotion: boolean;
  analysis_id: number | null;
  source_id: string;
  source_name: string;
  source_kind: string;
  source_tags: string[];
  source_track: string;
  source_region: string | null;
  source_enabled: boolean;
  source_health: string;
  source_interval_minutes: number;
  source_first_party: boolean;
}

function localTestDatabase(): { name: string; host: string } {
  const url = new URL(config.databaseUrl);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const host = url.hostname;
  if (!/(?:_test|_ci)$/.test(name)) throw new Error(`Refusing export from non-test database: ${name}`);
  if (!(host === "127.0.0.1" || host === "localhost" || host === "::1")) throw new Error(`Refusing export from non-local host: ${host}`);
  return { name, host };
}

function iso(date: Date | null): string | null {
  return date?.toISOString() ?? null;
}

const { values } = parseArgs({ options: { output: { type: "string" } } });
if (!values.output) throw new Error("Use --output <local .jsonl path>");

const db = localTestDatabase();
const output = path.resolve(values.output);
try {
  const rows = await sql<Row[]>`
    SELECT
      p.article_id AS id, p.revision, p.title, p.original_title, p.summary, p.url,
      p.published_at, p.discovered_at, p.timeline_at, p.visible_after, p.backfill,
      a.body_status, a.body_text,
      p.category, p.tags, p.score, p.selected, p.eligible, p.promotion, p.analysis_id,
      s.id AS source_id, s.name AS source_name, s.kind AS source_kind, s.tags AS source_tags,
      s.track AS source_track, s.region AS source_region, s.enabled AS source_enabled,
      s.health AS source_health, s.interval_minutes AS source_interval_minutes, s.first_party AS source_first_party
    FROM publications p
    JOIN sources s ON s.id = p.source_id AND s.kind = 'mp_account'
    JOIN articles a ON a.id = p.article_id
    WHERE p.visibility = 'public'
      AND p.eligible
      AND (NOT p.selected OR p.visible_after <= now())
    ORDER BY coalesce(p.published_at, p.discovered_at) DESC, p.article_id DESC`;

  const lines = rows.map((row) => JSON.stringify({
    id: row.id,
    revision: row.revision,
    title: row.title,
    originalTitle: row.original_title,
    summary: row.summary,
    bodyText: row.body_text,
    bodyChars: row.body_text?.length ?? 0,
    bodyStatus: row.body_status,
    url: row.url,
    publishedAt: iso(row.published_at),
    discoveredAt: iso(row.discovered_at),
    timelineAt: iso(row.timeline_at),
    visibleAfter: iso(row.visible_after),
    backfill: row.backfill,
    category: row.category,
    tags: row.tags,
    score: row.score,
    selected: row.selected,
    eligible: row.eligible,
    promotion: row.promotion,
    analysisId: row.analysis_id,
    source: {
      id: row.source_id,
      name: row.source_name,
      kind: row.source_kind,
      tags: row.source_tags,
      track: row.source_track,
      region: row.source_region,
      enabled: row.source_enabled,
      health: row.source_health,
      intervalMinutes: row.source_interval_minutes,
      firstParty: row.source_first_party,
    },
  }));

  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o600 });

  const sourceCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  let bodyMissing = 0;
  let summaryMissing = 0;
  let selected = 0;
  let promotion = 0;
  let backfill = 0;
  let firstAt: Date | null = null;
  let lastAt: Date | null = null;
  for (const row of rows) {
    sourceCounts.set(row.source_name, (sourceCounts.get(row.source_name) ?? 0) + 1);
    if (row.category) categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1);
    for (const tag of row.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    if (!row.body_text?.trim()) bodyMissing += 1;
    if (!row.summary?.trim()) summaryMissing += 1;
    if (row.selected) selected += 1;
    if (row.promotion) promotion += 1;
    if (row.backfill) backfill += 1;
    const at = row.published_at ?? row.discovered_at;
    if (!firstAt || at < firstAt) firstAt = at;
    if (!lastAt || at > lastAt) lastAt = at;
  }

  console.log(JSON.stringify({
    database: db,
    output,
    generatedAt: new Date().toISOString(),
    rows: rows.length,
    distinctArticleIds: new Set(rows.map((row) => row.id)).size,
    sourceCount: sourceCounts.size,
    dateRange: { first: iso(firstAt), last: iso(lastAt) },
    bodyMissing,
    summaryMissing,
    selected,
    promotion,
    backfill,
    sourceCounts: Object.fromEntries([...sourceCounts].sort((a, b) => b[1] - a[1])),
    categoryCounts: Object.fromEntries([...categoryCounts].sort((a, b) => b[1] - a[1])),
    topTags: Object.fromEntries([...tagCounts].sort((a, b) => b[1] - a[1]).slice(0, 50)),
  }, null, 2));
} finally {
  await closeDb();
}
