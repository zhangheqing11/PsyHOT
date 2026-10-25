// Converts MediaCrawler contents JSONL. Dry-run by default; --import registers and ingests on one DB.
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { zhihuSignal, mergeZhihuSignals, type ZhihuSignal } from "@aihot/backend/ingest/zhihu";
import { normalizeUrl } from "@aihot/backend/lib/url";

const { values } = parseArgs({ options: {
  input: { type: "string" }, output: { type: "string" }, import: { type: "boolean", default: false },
  backfill: { type: "boolean", default: false },
} });
if (!values.input) throw new Error("Use --input <MediaCrawler contents.jsonl>; --output previews batches; --import imports to DATABASE_URL.");
const signals = new Map<string, ZhihuSignal>();
let skipped = 0;
for (const [index, line] of (await readFile(values.input, "utf8")).split("\n").entries()) {
  if (!line.trim()) continue;
  let record: unknown;
  try { record = JSON.parse(line); } catch { throw new Error(`Invalid JSON at line ${index + 1}; nothing was sent`); }
  const signal = zhihuSignal(record);
  if (signal) {
    const key = `${signal.item.raw.contentType}:${signal.item.raw.contentId}`;
    signals.set(key, signals.has(key) ? mergeZhihuSignals(signals.get(key)!, signal) : signal);
  }
  else skipped += 1;
}
const sources = new Map<string, { sourceId: string; sourceName: string; items: ZhihuSignal["item"][] }>();
for (const s of signals.values()) {
  const source = sources.get(s.sourceId) ?? { sourceId: s.sourceId, sourceName: s.sourceName, items: [] };
  source.items.push(s.item);
  sources.set(s.sourceId, source);
}
const batches = [...sources.values()].flatMap((source) => {
  const batches = [];
  for (let i = 0; i < source.items.length; i += 50) {
    batches.push({ sourceId: source.sourceId, sourceName: source.sourceName, items: source.items.slice(i, i + 50).map((item) =>
      values.backfill ? { ...item, raw: { ...item.raw, _aihot: { backfill: true } } } : item) });
  }
  return batches;
});
if (values.output) await writeFile(values.output, JSON.stringify(batches, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ records: signals.size, sources: sources.size, skipped, batches: batches.length, output: values.output ?? null }));

if (values.import) {
  const { createSource } = await import("@aihot/backend/admin/sources");
  const { ingestItems } = await import("@aihot/backend/ingest/items");
  const { stopBoss } = await import("@aihot/backend/jobs/queue");
  const { sql, closeDb } = await import("@aihot/backend/db");
  try {
    const known = await sql<{ source_id: string; url: string; raw: ZhihuSignal["item"]["raw"] }[]>`
      SELECT source_id, url, raw FROM articles WHERE source_id = ANY(${[...sources.keys()]})
        AND raw->>'collector' = 'mediacrawler' AND raw->>'platform' = 'zhihu'
        AND raw->>'contentId' = ANY(${[...signals.values()].map((s) => s.item.raw.contentId)})`;
    for (const signal of signals.values()) {
      const existing = known.find((r) => r.source_id === signal.sourceId && r.raw.contentId === signal.item.raw.contentId
        && (r.raw.contentType ?? (r.url.includes('/question/') ? 'answer' : 'article')) === signal.item.raw.contentType);
      if (existing && existing.url !== normalizeUrl(signal.item.url)) throw new Error("Conflicting stored Zhihu content identity; nothing was imported");
    }
    for (const source of sources.values()) {
      const [existing] = await sql<{ kind: string; participation_mode: string }[]>`SELECT kind, participation_mode FROM sources WHERE id = ${source.sourceId}`;
      if (existing) {
        if (existing.kind !== "external" || existing.participation_mode !== "hot_signal") throw new Error(`${source.sourceId}: existing source is not an external hot_signal; review it in admin`);
        continue;
      }
      await createSource({ id: source.sourceId, name: source.sourceName, kind: "external", config: {}, tier: "T2", participation_mode: "hot_signal", interval_minutes: 1440, tags: ["知乎", "讨论"], first_party: false, site_fulltext: false, syndicate_fulltext: false }, "cli:zhihu-trial");
    }
    let created = 0;
    for (const batch of batches) created += (await ingestItems(batch)).created;
    console.log(JSON.stringify({ imported: signals.size, created, mode: "hot_signal" }));
  } finally { await stopBoss(); await closeDb(); }
}
