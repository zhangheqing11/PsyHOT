import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { enrichThinAbstracts } from "@aihot/backend/content/abstracts";
import { journalAbstractFromHtml } from "@aihot/backend/content/journal-abstract";
import { stripTags } from "@aihot/backend/lib/text";
import { stopBoss } from "@aihot/backend/jobs/queue";

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
const metadata = await stub((_hit, req) => {
  metadataSeen.push(req.url);
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
