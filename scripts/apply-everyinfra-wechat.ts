// Moves the WeChat accounts registered for WeRSS (kind external, never received an article) onto
// EveryInfra: their rows take the mp_account definition of industry/sources.json (the seed only inserts
// new sources, so it leaves them as they are). A row that has articles, or is not external, is left
// alone and listed. Each change is audited like an edit in the admin.
//   node --env-file=.env scripts/apply-everyinfra-wechat.ts            # list the changes
//   node --env-file=.env scripts/apply-everyinfra-wechat.ts --apply    # make them
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { audit } from "@aihot/backend/admin/auth";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";

const ACTOR = "ops-script";
const REASON = "公众号改由 EveryInfra 抓取（industry/sources.json）";
const apply = process.argv.includes("--apply");

interface Seed { id: string; name: string; kind: string; config: Record<string, unknown>; tier: string; first_party: boolean; track: string; region: string | null; interval_minutes: number; tags: string[]; enabled?: boolean }
const { sources } = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")) as { sources: Seed[] };
const wanted = sources.filter((s) => s.kind === "mp_account");

let changed = 0;
for (const s of wanted) {
  assertSupportedConfig("mp_account", s.config);
  const [row] = await sql<{ kind: string; articles: number }[]>`
    SELECT kind, (SELECT count(*)::int FROM articles WHERE source_id = ${s.id}) AS articles FROM sources WHERE id = ${s.id}`;
  if (!row || row.kind === "mp_account") continue; // new ones come from the seed; converted ones are done
  if (row.kind !== "external" || row.articles > 0) {
    console.log(`${s.id}（${s.name}）: left alone (${row.kind}, ${row.articles} articles)`);
    continue;
  }
  changed += 1;
  console.log(`${s.id}（${s.name}）: external → mp_account ${JSON.stringify(s.config)}`);
  if (!apply) continue;
  await sql.begin(async (tx) => {
    const [before] = await tx`SELECT * FROM sources WHERE id = ${s.id} FOR UPDATE`;
    const after = { kind: "mp_account", config: s.config, name: s.name, tier: s.tier, first_party: s.first_party, track: s.track, region: s.region, interval_minutes: s.interval_minutes, tags: s.tags, enabled: s.enabled ?? true };
    await tx`UPDATE sources SET kind = 'mp_account', config = ${tx.json(s.config as never)}, name = ${s.name}, tier = ${s.tier}, first_party = ${s.first_party},
               track = ${s.track}, region = ${s.region}, interval_minutes = ${s.interval_minutes}, tags = ${s.tags}, enabled = ${after.enabled},
               health = 'unknown', fail_count = 0, last_error = NULL, cursor = NULL, next_fetch_at = now(), updated_at = now()
             WHERE id = ${s.id}`;
    await audit(ACTOR, "source.update", `source:${s.id}`, REASON, { kind: before!.kind, config: before!.config }, after);
  });
}
console.log(`${changed} of ${wanted.length} WeChat accounts ${apply ? "moved" : "would move (run with --apply)"}`);
await closeDb();
