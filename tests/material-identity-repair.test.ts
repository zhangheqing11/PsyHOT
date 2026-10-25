// The historical repair entry point used to move/delete article-linked records. It is now
// read-only/deprecated; apply is covered by identity-repair.test.ts and requires an admin actor.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { tag } from "./setup.ts";
import { closeDb, sql } from "@aihot/backend/db";
import { auditMaterialIdentities, repairMaterialIdentities } from "@aihot/backend/content/repair-identities";
import { identityKeyForUrl } from "@aihot/backend/lib/url";

const T = tag();
const SOURCE = `legacy-repair-${T}`;
const A = `legacy-a-${T}`;
const B = `legacy-b-${T}`;
const URL_A = `https://publisher.example/${T}/article?doi=10.9999/${T}`;
const URL_B = `https://publisher.example/${T}/mirror?doi=10.9999/${T}&utm_source=feed`;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, next_fetch_at) VALUES (${SOURCE}, 'Legacy repair fixture', 'rss', '2100-01-01')`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, body_text, body_status, processing_state)
    VALUES (${A}, ${SOURCE}, ${identityKeyForUrl(URL_A)}, ${URL_A}, 'same title', now() - interval '2 days', now() - interval '2 days', 'canonical body', 'ok', 'analyzed'),
           (${B}, ${SOURCE}, ${identityKeyForUrl(URL_B)}, ${URL_B}, 'different rendering', now() - interval '1 day', now() - interval '1 day', 'duplicate body', 'ok', 'analyzed')`;
  await sql`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text) VALUES (${B}, 1, 'hb', 'different rendering', 'duplicate body')`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, title_zh, summary_zh, selected)
    VALUES (${B}, 1, 'rule', 'pass', '中文标题', '摘要', true)`;
  await sql`INSERT INTO publications (article_id, title, source_id, channel, discovered_at, timeline_at, eligible, selected, visibility, url, sort_at)
    VALUES (${B}, '中文标题', ${SOURCE}, 'news', now(), now(), true, true, 'public', ${URL_B}, now())`;
});

after(async () => {
  await sql`DELETE FROM articles WHERE id = ANY(${[A, B]}::text[])`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await closeDb();
});

test("legacy audit delegates to deterministic candidates and never uses titles", async () => {
  const rows = await auditMaterialIdentities();
  assert.deepEqual(rows.find((row) => row.keep === A), { identity: `doi:10.9999/${T}`.toLowerCase(), keep: A, duplicates: [B], sources: [SOURCE] });
});

test("legacy apply entry point is retired behind the authenticated CLI", async () => {
  await assert.rejects(() => repairMaterialIdentities(), /retired.*authenticated admin actor/);
  assert.equal((await sql`SELECT duplicate_of FROM articles WHERE id = ${B}`)[0]!.duplicate_of, null);
  assert.equal((await sql`SELECT count(*)::int AS n FROM analyses WHERE article_id = ${B}`)[0]!.n, 1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM publications WHERE article_id = ${B}`)[0]!.n, 1);
});
