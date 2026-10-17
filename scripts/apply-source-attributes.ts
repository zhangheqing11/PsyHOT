// Brings existing sources' track and region in line with industry/sources.json (the seed only inserts
// new sources). Sources the file does not list keep their values, except WeChat accounts (wechat-*),
// which are mixed and domestic until set one by one. Each change goes through the admin update, so it
// is audited like an edit in the admin.
//   node --env-file=.env scripts/apply-source-attributes.ts            # list the changes
//   node --env-file=.env scripts/apply-source-attributes.ts --apply    # make them
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { updateSource } from "@aihot/backend/admin/sources";
import { stopBoss } from "@aihot/backend/jobs/queue";

const ACTOR = "ops-script";
const REASON = "学界 / 业界视角：信源的视角和地区（industry/sources.json）";
const apply = process.argv.includes("--apply");

const { sources } = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")) as {
  sources: Array<{ id: string; track?: string; region?: string | null }>;
};
const wanted = new Map(sources.map((s) => [s.id, { track: s.track ?? "mixed", region: s.region ?? null }]));

const rows = await sql<{ id: string; name: string; track: string; region: string | null; updated_at: Date }[]>`
  SELECT id, name, track, region, updated_at FROM sources ORDER BY id`;
let changed = 0;
for (const r of rows) {
  const want = wanted.get(r.id) ?? (r.id.startsWith("wechat-") ? { track: "mixed", region: "domestic" } : null);
  if (!want) continue;
  const patch: Record<string, string | null> = {};
  if (want.track !== r.track) patch.track = want.track;
  if (want.region !== r.region) patch.region = want.region;
  if (!Object.keys(patch).length) continue;
  changed += 1;
  console.log(`${r.id}（${r.name}）: ${r.track}/${r.region ?? "-"} → ${want.track}/${want.region ?? "-"}`);
  if (apply) await updateSource(r.id, { patch, version: r.updated_at.toISOString(), reason: REASON }, ACTOR);
}
console.log(`${changed} of ${rows.length} sources ${apply ? "updated" : "would change (run with --apply)"}`);
await stopBoss();
await closeDb();
