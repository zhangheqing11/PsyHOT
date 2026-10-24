// Finds the EveryInfra account id (ghid) of fixed WeChat accounts that have none, paid per call:
// one account search by name, then at most three candidate listings, accepted only when the listed
// articles carry the account's verified __biz. Prints what it found; --apply writes it (audited).
// node --env-file=.env scripts/resolve-wechat-accounts.ts [--apply]
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { DISCOVERY_POOL, everyInfraCall, everyInfraMpHistory } from "@aihot/backend/providers/everyinfra";
import { articleBiz } from "@aihot/backend/sources/mp";
import { candidates, matchingCandidate } from "./resolve-wechat-accounts-logic.ts";

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });
const MAX_LISTINGS = 3;

const sources = await sql<{ id: string; name: string; config: { nickname?: string; wechatBiz?: string } }[]>`
  SELECT id, name, config FROM sources WHERE kind = 'mp_account' AND enabled
    AND NOT (config ? 'ghid') AND NOT (config ? 'wxid') AND config ? 'wechatBiz' ORDER BY id`;
const day = new Date().toISOString().slice(0, 10);
try {
  for (const s of sources) {
    // A 503 for one account (frequent and not billed) leaves it for the next run.
    await resolve(s).catch((error: unknown) => console.log(JSON.stringify({ source: s.id, error: String(error instanceof Error ? error.message : error).slice(0, 200) })));
  }
} finally {
  await closeDb();
}

async function resolve(s: (typeof sources)[number]) {
  const name = s.config.nickname ?? s.name;
  const search = await everyInfraCall<unknown[]>({ platform: "wechat_oa", action: "account_search", params: { keyword: name },
    subject: s.id, purpose: "wechat_discovery", window: day, pool: DISCOVERY_POOL });
  const found = candidates(search.results);
  let match = matchingCandidate(found, s.config.wechatBiz);
  // Without a biz in the search result, a listing shows whose articles an account id returns.
  for (const c of match ? [] : found.slice(0, MAX_LISTINGS)) {
    const listing = await everyInfraMpHistory(c.ghid, { subject: s.id, window: `resolve:${day}`, pool: DISCOVERY_POOL });
    if (listing.posts.some((p) => articleBiz(p.url) === s.config.wechatBiz)) { match = c; break; }
  }
  console.log(JSON.stringify({ source: s.id, name, candidates: found.map((c) => `${c.ghid} ${c.name}`), match: match?.ghid ?? null }));
  if (match && values.apply) {
    await sql.begin(async (tx) => {
      await tx`UPDATE sources SET config = config || ${tx.json({ ghid: match.ghid })}, health = 'unknown', last_error = NULL,
                 cursor = coalesce(cursor, '{}'::jsonb) - 'retryAt', updated_at = now() WHERE id = ${s.id}`;
      await tx`INSERT INTO audit_log (actor, action, subject, reason, before, after)
               VALUES ('script:resolve-wechat-accounts', 'source.update', ${`source:${s.id}`}, 'ghid whose listing carries the verified __biz',
                       ${tx.json({ ghid: null })}, ${tx.json({ ghid: match.ghid })})`;
    });
  }
}
