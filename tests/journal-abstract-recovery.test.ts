import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { enrichThinAbstracts } from "@aihot/backend/content/abstracts";
import { journalAbstractFromHtml } from "@aihot/backend/content/journal-abstract";
import { stripTags } from "@aihot/backend/lib/text";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const JOURNAL = `test-journal-recovery-journal-${T}`;
const NEWS = `test-journal-recovery-news-${T}`;
const WECHAT = `test-journal-recovery-wechat-${T}`;
const PREPRINT = `test-journal-recovery-preprint-${T}`;
const ABSTRACT = `This longitudinal study examined executive functioning and adaptive behaviour in young children. Participants completed performance-based tasks and caregivers reported everyday skills. More complex executive functioning was associated with adaptive behaviour after accounting for developmental level, while the observational design did not establish a causal effect. (${T})`;
const STRUCTURED = `<h2>Background</h2><p>Adaptive behaviour is associated with developmental outcomes in young children.</p><h2>Methods</h2><p>Children completed executive functioning tasks and caregivers reported everyday skills.</p><h2>Results</h2><p>Complex executive functioning was associated with adaptive behaviour after accounting for developmental level.</p><h2>Conclusions</h2><p>The observational findings identify a potential target for further research and do not establish a causal effect. (${T})</p>`;
const FULL_BODY = `<h2>Main</h2><p>${"The full paper describes its data, results and limitations. ".repeat(800)}</p><h2>References</h2><p>An abstract mentioned in a cited title is not this article's abstract.</p>`;
const metadataSeen: string[] = [];
let publisherHits = 0;
let delayedLookup: { match: string; ready: () => void; release: Promise<void>; seen: boolean } | null = null;
const metadata = await stub(async (_hit, req) => {
  metadataSeen.push(req.url);
  if (delayedLookup && req.url.startsWith("/openalex/") && req.url.includes(delayedLookup.match)) {
    if (!delayedLookup.seen) {
      delayedLookup.seen = true;
      delayedLookup.ready();
      await delayedLookup.release;
      return { results: [] };
    }
    const words = ABSTRACT.split(" ");
    return { abstract_inverted_index: Object.fromEntries([...new Set(words)].map((w) => [w, words.flatMap((word, i) => word === w ? [i] : [])])) };
  }
  if (req.url.startsWith("/openalex/") && req.url.includes("fallback")) {
    const words = ABSTRACT.split(" ");
    const inverted = Object.fromEntries([...new Set(words)].map((w) => [w, words.flatMap((word, i) => word === w ? [i] : [])]));
    const work = { title: `Metadata fallback ${T}`, abstract_inverted_index: inverted };
    return req.url.startsWith("/openalex/works?") ? { results: [work] } : work;
  }
  if (req.url.startsWith("/epmc/")) return { resultList: { result: [] } };
  if (req.url.startsWith("/openalex/")) return { results: [] };
  return { message: { items: [] } };
});
process.env.OPENALEX_API_URL = `${metadata.url}/openalex`;
process.env.CROSSREF_API_URL = `${metadata.url}/crossref`;
process.env.EUROPEPMC_API_URL = `${metadata.url}/epmc`;
process.env.MODEL_CALLS_ENABLED = "false";
config.modelCallsEnabled = false;
config.allowPrivateNetworkFetch = true;
config.abstractTranslationDays = 3;

// Every publisher response is local, and any accidental external request fails closed.
const previousDispatcher = getGlobalDispatcher();
const offline = new MockAgent();
offline.disableNetConnect();
offline.enableNetConnect(/^127\.0\.0\.1:\d+$/);
setGlobalDispatcher(offline);

function publisher(path: string, html: string, status = 200): string {
  offline.get("https://www.nature.com").intercept({ path }).reply(() => {
    publisherHits += 1;
    return { statusCode: status, data: html, responseOptions: { headers: { "content-type": "text/html; charset=utf-8" } } };
  });
  return `https://www.nature.com${path}`;
}

async function article(source: string, url: string, opts: { title?: string; body?: string; excerpt?: string | null; discoveredAt?: Date; bodyStatus?: "ok" | "unconfirmed" | "pending" } = {}) {
  return (await upsertMaterial({
    sourceId: source, url, title: opts.title ?? `Journal recovery ${T}`, excerpt: opts.excerpt ?? null,
    bodyHtml: opts.body, bodyText: opts.body ? stripTags(opts.body) : null,
    bodyStatus: opts.bodyStatus ?? (opts.body ? "ok" : "unconfirmed"), language: "en",
    discoveredAt: opts.discoveredAt, publishedAt: opts.discoveredAt ?? new Date(), via: "fetch",
  })).articleId;
}

before(async () => {
  await sql`DELETE FROM articles WHERE source_id LIKE 'test-journal-recovery-%'`;
  await sql`DELETE FROM sources WHERE id LIKE 'test-journal-recovery-%'`;
  for (const [id, kind, tags] of [[JOURNAL, "rss", ["期刊"]], [NEWS, "rss", ["媒体"]], [WECHAT, "mp_account", ["期刊"]], [PREPRINT, "rss", ["预印本"]]] as const) {
    await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, tags, interval_minutes, next_fetch_at)
      VALUES (${id}, 'Test recovery', ${kind}, 'T1', 'editorial', ${[...tags]}, 1440, '2100-01-01')`;
  }
});

after(async () => {
  setGlobalDispatcher(previousDispatcher);
  await offline.close();
  await metadata.close();
  await stopBoss();
  await closeDb();
});

test("HTML recovery requires an abstract boundary, rejects oversized sections, and decodes citation metadata", () => {
  assert.equal(journalAbstractFromHtml(`<section data-title="Abstract"><p>${"Long full paper. ".repeat(500)}</p></section>`), null);
  assert.equal(journalAbstractFromHtml(`${STRUCTURED}<h2>References</h2><p>A full paper continues.</p>`, {
    storedBody: true, url: "https://acamh.onlinelibrary.wiley.com/doi/10.1111/jcpp.test",
  }), null, "an extra full-paper section disqualifies Wiley's heading-only exception");
  assert.equal(journalAbstractFromHtml(STRUCTURED, { storedBody: true, url: "https://example.org/article" }), null);
  assert.equal(journalAbstractFromHtml(`<h2>Abstract</h2><p>${ABSTRACT}</p><div><h2>Main</h2><p>Full paper text.</p></div>`), ABSTRACT);
  const citation = `Abstract representations &amp; task performance &#8212; ${ABSTRACT}`;
  assert.equal(journalAbstractFromHtml(`<meta name="citation_abstract" content="${citation}">`), `Abstract representations & task performance — ${ABSTRACT}`);
  assert.equal(journalAbstractFromHtml(`<meta property="og:description" content="${ABSTRACT}">`), null, "a generic page description is not identified as an abstract");
});

test("a Wiley structured abstract is recovered from a confirmed stored body and its revision keeps that body", async () => {
  const id = await article(JOURNAL, `https://acamh.onlinelibrary.wiley.com/doi/10.1111/jcpp.${T}`, {
    body: STRUCTURED, excerpt: "Journal of Child Psychology and Psychiatry, EarlyView.",
  });
  const hitCount = metadataSeen.length;
  await enrichThinAbstracts();
  const [row] = await sql<{ excerpt: string; body_html: string; body_text: string; body_status: string; revision: number }[]>`
    SELECT excerpt, body_html, body_text, body_status, revision FROM articles WHERE id = ${id}`;
  assert.equal(row!.excerpt, stripTags(STRUCTURED));
  assert.equal(row!.body_html, STRUCTURED);
  assert.equal(row!.body_status, "ok");
  assert.equal(row!.revision, 2);
  const [revision] = await sql<{ body_text: string }[]>`SELECT body_text FROM article_revisions WHERE article_id = ${id} AND revision = 2`;
  assert.equal(revision!.body_text, row!.body_text, "recovering an abstract must not erase the body's revision history");
  assert.equal(metadataSeen.length, hitCount, "a stored abstract requires no network lookup");
  const [lookup] = await sql<{ provider: string; found_at: Date | null }[]>`SELECT provider, found_at FROM abstract_lookups WHERE article_id = ${id}`;
  assert.deepEqual([lookup!.provider, !!lookup!.found_at], ["stored_html", true]);
});

test("a Nature full paper uses only the publisher's explicitly marked abstract", async () => {
  const url = publisher(`/articles/publisher-${T}`, `<html><body><section data-title="Abstract" aria-labelledby="Abs1"><h2 id="Abs1">Abstract</h2><div id="Abs1-content"><p>${ABSTRACT}</p></div></section><section>${FULL_BODY}</section></body></html>`);
  const id = await article(JOURNAL, url, { body: FULL_BODY });
  await enrichThinAbstracts();
  const [row] = await sql<{ excerpt: string; body_html: string }[]>`SELECT excerpt, body_html FROM articles WHERE id = ${id}`;
  assert.equal(row!.excerpt, ABSTRACT);
  assert.equal(row!.body_html, FULL_BODY);
  assert.ok(!row!.excerpt.includes("The full paper"));
});

test("public metadata remains a fallback for journal articles that already have a full body", async () => {
  const url = publisher(`/articles/fallback-${T}`, "<html><body>Access unavailable</body></html>", 403);
  const id = await article(JOURNAL, url, { body: FULL_BODY, title: `Metadata fallback ${T}` });
  await enrichThinAbstracts();
  const [row] = await sql<{ excerpt: string }[]>`SELECT excerpt FROM articles WHERE id = ${id}`;
  assert.equal(row!.excerpt, ABSTRACT);
  const [lookup] = await sql<{ provider: string }[]>`SELECT provider FROM abstract_lookups WHERE article_id = ${id}`;
  assert.equal(lookup!.provider, "openalex");
});

test("a full paper without an identified abstract never becomes its own abstract", async () => {
  const url = publisher(`/articles/missing-${T}`, `<html><body>${FULL_BODY}</body></html>`);
  const id = await article(JOURNAL, url, { body: FULL_BODY });
  await enrichThinAbstracts();
  const [row] = await sql<{ excerpt: string | null; revision: number }[]>`SELECT excerpt, revision FROM articles WHERE id = ${id}`;
  assert.deepEqual([row!.excerpt, row!.revision], [null, 1]);
  const [lookup] = await sql<{ found_at: Date | null }[]>`SELECT found_at FROM abstract_lookups WHERE article_id = ${id}`;
  assert.equal(lookup!.found_at, null);
});

test("news, journal-tagged WeChat, pending bodies and journals outside the recent window are not recovered", async () => {
  const ids = await Promise.all([
    article(NEWS, `https://www.nature.com/articles/fallback-news-${T}`),
    article(WECHAT, `https://mp.weixin.qq.com/s/${T}`),
    article(JOURNAL, `https://www.nature.com/articles/fallback-pending-${T}`, { bodyStatus: "pending" }),
    article(JOURNAL, `https://www.nature.com/articles/fallback-old-${T}`, { discoveredAt: new Date(Date.now() - 4 * 86400_000) }),
  ]);
  const hits = [publisherHits, metadataSeen.length];
  await enrichThinAbstracts();
  const rows = await sql<{ excerpt: string | null; revision: number }[]>`SELECT excerpt, revision FROM articles WHERE id IN ${sql(ids)}`;
  assert.ok(rows.every((row) => row.excerpt === null && row.revision === 1));
  assert.deepEqual([publisherHits, metadataSeen.length], hits);
  const lookups = await sql`SELECT article_id FROM abstract_lookups WHERE article_id IN ${sql(ids)}`;
  assert.equal(lookups.length, 0);
});

test("existing preprint metadata recovery keeps its body-less lookback behaviour", async () => {
  const id = await article(PREPRINT, `https://doi.org/10.1234/fallback-preprint-${T}`, { discoveredAt: new Date(Date.now() - 10 * 86400_000) });
  const hits = publisherHits;
  await enrichThinAbstracts();
  const [row] = await sql<{ excerpt: string }[]>`SELECT excerpt FROM articles WHERE id = ${id}`;
  assert.equal(row!.excerpt, ABSTRACT);
  assert.equal(publisherHits, hits, "preprints retain their metadata-only recovery path");
});

test("ready excerpts before the batch boundary do not starve a missing journal abstract", async () => {
  const url = publisher(`/articles/behind-ready-${T}`, `<html><head><meta name="citation_abstract" content="${ABSTRACT}"></head><body>${FULL_BODY}</body></html>`);
  const id = await article(JOURNAL, url, { body: FULL_BODY, discoveredAt: new Date(Date.now() - 60_000) });
  for (let n = 0; n < 100; n += 1) {
    await article(JOURNAL, `https://example.org/ready-${T}-${n}`, { body: FULL_BODY, excerpt: ABSTRACT });
  }
  await enrichThinAbstracts(30);
  const [row] = await sql<{ excerpt: string }[]>`SELECT excerpt FROM articles WHERE id = ${id}`;
  assert.equal(row!.excerpt, ABSTRACT);
});

test("an invalid long journal excerpt is repaired and subsequent RSS updates preserve the verified abstract", async () => {
  const bad = `STRENGTHS AND LIMITATIONS OF THIS STUDY ${"This section discusses study limitations rather than the abstract. ".repeat(8)}`;
  const url = `https://www.nature.com/articles/invalid-stored-${T}`;
  const body = `<h2>Abstract</h2><p>${ABSTRACT}</p><h2>Main</h2>${FULL_BODY}`;
  const id = await article(JOURNAL, url, { body, excerpt: bad });
  await enrichThinAbstracts();
  assert.equal((await sql`SELECT excerpt FROM articles WHERE id = ${id}`)[0]!.excerpt, ABSTRACT);
  const result = await upsertMaterial({ sourceId: JOURNAL, url, title: `Updated title ${T}`, excerpt: bad, via: "fetch" });
  assert.equal(result.revised, true, "a real title change still creates a revision");
  const [row] = await sql`SELECT title, excerpt, revision FROM articles WHERE id = ${id}`;
  assert.deepEqual([row!.title, row!.excerpt, row!.revision], [`Updated title ${T}`, ABSTRACT, 3]);
  const newFeedAbstract = `${ABSTRACT} A feed rendering changed.`;
  await upsertMaterial({ sourceId: JOURNAL, url, title: row!.title, excerpt: newFeedAbstract, via: "fetch" });
  assert.equal((await sql`SELECT excerpt FROM articles WHERE id = ${id}`)[0]!.excerpt, ABSTRACT,
    "even a plausible feed rendering cannot replace a verified recovered abstract");
});

test("legacy deferred or exhausted journal lookups get one quality recovery pass without endless retries", async () => {
  const url = publisher(`/articles/legacy-miss-${T}`, "<html><body>Access unavailable</body></html>", 403);
  const bad = `Article title: Which emotion regulation strategies mediate treatment outcomes? Authors: ${"A. Author, ".repeat(30)}`;
  const id = await article(JOURNAL, url, { title: "Correction", excerpt: bad });
  await sql`INSERT INTO abstract_lookups (article_id, attempts, next_try_at, found_at, provider)
    VALUES (${id}, 6, now() + interval '14 days', now(), 'crossref')`;
  const hits = publisherHits;
  await enrichThinAbstracts();
  const [lookup] = await sql`SELECT attempts, found_at, last_error FROM abstract_lookups WHERE article_id = ${id}`;
  assert.equal(publisherHits, hits + 1);
  assert.equal(lookup!.attempts, 7);
  assert.equal(lookup!.found_at, null);
  assert.match(lookup!.last_error, /^journal-abstract-quality-v2:/);
  await enrichThinAbstracts();
  assert.equal(publisherHits, hits + 1);
  assert.equal((await sql`SELECT attempts FROM abstract_lookups WHERE article_id = ${id}`)[0]!.attempts, 7);
});

test("a legacy truncated journal abstract is recovered in full despite a deferred missing lookup", async () => {
  const full = `${ABSTRACT.repeat(7)}Trial registration ISRCTN12345678.`;
  const url = publisher(`/articles/truncated-${T}`, `<section id="abstract"><h2>Abstract</h2><p>${full}</p></section>`);
  const id = await article(JOURNAL, url, { excerpt: full.slice(0, 2000) });
  await sql`INSERT INTO abstract_lookups (article_id, attempts, next_try_at) VALUES (${id}, 3, now() + interval '7 days')`;
  await enrichThinAbstracts();
  const [row] = await sql`SELECT excerpt, revision FROM articles WHERE id = ${id}`;
  assert.equal(row!.excerpt, full);
  assert.equal(row!.revision, 2);
  assert.equal((await sql`SELECT attempts FROM abstract_lookups WHERE article_id = ${id}`)[0]!.attempts, 4,
    "the mechanism pass preserves the retry budget rather than resetting it");
});

test("publisher-confirmed absence is recorded, while a correction with an abstract is recovered normally", async () => {
  const missingUrl = publisher(`/articles/no-abstract-${T}`, '<html><body><section id="abstract"><h2>Abstract</h2><p>No abstract available.</p></section></body></html>');
  const missing = await article(JOURNAL, missingUrl, { title: "Correction" });
  const presentUrl = publisher(`/articles/correction-abstract-${T}`, `<section id="abstract"><h2>Abstract</h2><p>${ABSTRACT}</p></section>`);
  const present = await article(JOURNAL, presentUrl, { title: "Correction" });
  await enrichThinAbstracts();
  assert.equal((await sql`SELECT provider FROM abstract_lookups WHERE article_id = ${missing}`)[0]!.provider, "publisher_no_abstract");
  assert.equal((await sql`SELECT excerpt FROM articles WHERE id = ${present}`)[0]!.excerpt, ABSTRACT);
});

test("recovery marks the abstract verified before queueing so an intervening RSS update cannot replace it", async () => {
  const url = publisher(`/articles/atomic-verification-${T}`, `<section id="abstract"><p>${ABSTRACT}</p></section>`);
  const id = await article(JOURNAL, url, { discoveredAt: new Date(Date.now() + 86400_000) });
  const boss = await getBoss();
  const send = boss.send.bind(boss);
  const hook = mock.method(boss, "send", async (name: string, data: { articleId?: string } | null = null, options = {}) => {
    if (data?.articleId === id) {
      const [lookup] = await sql`SELECT found_at FROM abstract_lookups WHERE article_id = ${id}`;
      assert.ok(lookup?.found_at, "verification must be visible alongside the recovered article");
      await upsertMaterial({ sourceId: JOURNAL, url, title: `Journal recovery ${T}`, excerpt: `${ABSTRACT} A different plausible feed rendering.`, via: "fetch" });
    }
    return send(name, data, options);
  });
  try { await enrichThinAbstracts(1); } finally { hook.mock.restore(); }
  assert.equal((await sql`SELECT excerpt FROM articles WHERE id = ${id}`)[0]!.excerpt, ABSTRACT);
});

test("a stale concurrent miss cannot clear another recovery's successful verification", async () => {
  const path = `/doi/10.1234/concurrent-${T}`;
  offline.get("https://www.nature.com").intercept({ path }).reply(403, "Blocked").persist();
  const id = await article(JOURNAL, `https://www.nature.com${path}`, { discoveredAt: new Date(Date.now() + 2 * 86400_000) });
  const ready = gate();
  const release = gate();
  delayedLookup = { match: `concurrent-${T}`, ready: () => ready.open(), release: release.promise, seen: false };
  const stale = enrichThinAbstracts(1);
  try {
    await ready.promise;
    assert.equal((await enrichThinAbstracts(1)).found, 1);
    release.open();
    assert.equal((await stale).found, 0);
    const [lookup] = await sql`SELECT found_at, provider, attempts FROM abstract_lookups WHERE article_id = ${id}`;
    assert.ok(lookup!.found_at);
    assert.deepEqual([lookup!.provider, lookup!.attempts], ["openalex", 1]);
    assert.equal((await sql`SELECT excerpt FROM articles WHERE id = ${id}`)[0]!.excerpt, ABSTRACT);
  } finally {
    release.open();
    await stale;
    delayedLookup = null;
  }
});
