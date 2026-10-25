import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { tag } from "./setup.ts";
import { closeDb, sql } from "@aihot/backend/db";
import { runIdentityRepair, scanIdentityCandidates } from "@aihot/backend/content/identity-repair";
import { identityKeyForUrl } from "@aihot/backend/lib/url";

const T = tag();
const SOURCE = `test-identity-${T}`;
const A = `ira${T}`;
const B = `irb${T}`;
const C = `irc${T}`;
const LEDGER_SEQ = 900000 + (Date.now() % 90000);
let ADMIN_ID: number;

before(async () => {
  const [admin] = await sql<{ id: number }[]>`INSERT INTO admin_users (email, display_name) VALUES (${`identity-${T}@test.local`}, 'Identity repair test admin') RETURNING id`;
  ADMIN_ID = admin!.id;
  await sql`INSERT INTO sources (id, name, kind, next_fetch_at) VALUES (${SOURCE}, 'Identity repair fixture', 'rss', '2100-01-01')`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, revision, content_hash, body_text, body_status, processing_state)
    VALUES (${A}, ${SOURCE}, ${identityKeyForUrl(`https://publisher.example/${T}/a?doi=10.9999/${T}`)}, ${`https://publisher.example/${T}/a?doi=10.9999/${T}`}, 'same title', now() - interval '2 days', now() - interval '2 days', 1, 'ha', 'body a', 'ok', 'analyzed'),
           (${B}, ${SOURCE}, ${identityKeyForUrl(`https://publisher.example/${T}/b?doi=10.9999/${T}&utm_source=feed`)}, ${`https://publisher.example/${T}/b?doi=10.9999/${T}&utm_source=feed`}, 'different rendering', now() - interval '1 day', now() - interval '1 day', 1, 'hb', 'body b', 'ok', 'analyzed'),
           (${C}, ${SOURCE}, ${identityKeyForUrl(`https://other.example/${T}/c`)}, ${`https://other.example/${T}/c`}, 'same title', now(), now(), 1, 'hc', 'body c', 'ok', 'analyzed')`;
  await sql`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text) VALUES
    (${A}, 1, 'ha', 'same title', 'body a'), (${B}, 1, 'hb', 'different rendering', 'body b')`;
  await sql`INSERT INTO article_discoveries (article_id, source_id, via) VALUES (${B}, ${SOURCE}, 'fetch')`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, title_zh, summary_zh, selected)
    VALUES (${B}, 1, 'rule', 'pass', '中文标题', '摘要', true)`;
  await sql`INSERT INTO publications (article_id, title, source_id, channel, discovered_at, timeline_at, eligible, selected, visibility, url, sort_at)
    VALUES (${B}, '中文标题', ${SOURCE}, 'news', now(), now(), true, true, 'public', ${`https://publisher.example/${T}/b?doi=10.9999/${T}`}, now())`;
  await sql`INSERT INTO selected_ledger (seq, article_id, op, payload) VALUES (${LEDGER_SEQ}, ${B}, 'upsert', '{}')`;
  await sql`INSERT INTO selected_state (article_id, in_set, payload_hash, last_seq) VALUES (${B}, true, 'hash-b', ${LEDGER_SEQ})`;
});

after(async () => {
  await sql`DELETE FROM material_identity_repair_runs WHERE actor = ${`admin:${ADMIN_ID}`}`;
  await sql`DELETE FROM admin_users WHERE id = ${ADMIN_ID}`;
  await sql`DELETE FROM selected_ledger WHERE article_id = ANY(${[A, B, C]}::text[])`;
  await sql`DELETE FROM selected_state WHERE article_id = ANY(${[A, B, C]}::text[])`;
  await sql`DELETE FROM articles WHERE id = ANY(${[A, B, C]}::text[])`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await closeDb();
});

test("dry-run reports exact DOI candidates and leaves articles untouched", async () => {
  const candidates = await scanIdentityCandidates();
  const candidate = candidates.find((c) => c.articleIds.includes(A));
  assert.ok(candidate);
  assert.equal(candidate.identityKind, "doi");
  assert.deepEqual(candidate.articleIds, [A, B]);
  assert.equal(candidates.some((c) => c.articleIds.includes(C)), false, "matching titles never form an identity candidate");
  const run = await runIdentityRepair({ mode: "dry-run", actor: `admin:${ADMIN_ID}`, reason: "verify deterministic dry run" });
  assert.equal(run.status, "dry-run");
  assert.equal((await sql`SELECT duplicate_of FROM articles WHERE id = ${B}`)[0]!.duplicate_of, null);
});

test("apply is retired without creating a repair run", async () => {
  const before = Number((await sql`SELECT count(*)::int AS n FROM material_identity_repair_runs`)[0]!.n);
  await assert.rejects(
    () => runIdentityRepair({ mode: "apply", actor: `admin:${ADMIN_ID}`, reason: "x" }),
    /identity repair apply is retired/,
  );
  const after = Number((await sql`SELECT count(*)::int AS n FROM material_identity_repair_runs`)[0]!.n);
  assert.equal(after, before);
});
