import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { SITE } from "@aihot/industry/site";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { cleanAbstract, doiFromUrl, enrichThinAbstracts, findAbstract, invertedToText, piiFromUrl, sameTitle } from "@aihot/backend/content/abstracts";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const SOURCE = `test-abstracts-${T}`;
const ABSTRACT = `Attachment theory has been used to understand vulnerability to addictive behaviours (${T}). This systematic review synthesised 120 studies and found that anxious attachment was associated with problematic involvement across formally recognised addictions and other behaviours.`;
// ScienceDirect ids of this run: a link seen in an earlier run is the same article, already enriched.
const run = String(Date.now() % 1e7).padStart(7, "0");
const HIT = `S027273582${run}`;
const MISS = `S027273583${run}`;
const DOI = `10.1016/j.cpr.${T}`;
const words = ABSTRACT.split(" ");
const inverted = Object.fromEntries([...new Set(words)].map((w) => [w, words.flatMap((x, i) => (x === w ? [i] : []))]));

// One stub for the three services: the PII resolves to a DOI, OpenAlex has the found article only,
// Europe PMC and Crossref have nothing.
const seen: string[] = [];
const api = await stub((_hit, req) => {
  seen.push(req.url);
  if (req.url.startsWith(`/crossref/works?filter=alternative-id:${HIT}`)) return { message: { items: [{ DOI }] } };
  if (req.url.startsWith(`/openalex/works/doi:${DOI}`)) return { doi: `https://doi.org/${DOI}`, title: "x", abstract_inverted_index: inverted };
  if (req.url.startsWith("/epmc/")) return { resultList: { result: [] } };
  if (req.url.startsWith("/openalex/works?")) return { results: [] };
  return { message: { items: [] } };
});
process.env.OPENALEX_API_URL = `${api.url}/openalex`;
process.env.CROSSREF_API_URL = `${api.url}/crossref`;
process.env.EUROPEPMC_API_URL = `${api.url}/epmc`;
config.allowPrivateNetworkFetch = true;

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test abstracts', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await api.close();
  await stopBoss();
  await closeDb();
});

const META = "Publication date: Available online 2 October 2026 Source: Clinical Psychology Review Author(s): A. Author, B. Author";
const thinArticle = async (pii: string, title: string) =>
  (await upsertMaterial({ sourceId: SOURCE, url: `https://www.sciencedirect.com/science/article/pii/${pii}?dgcid=rss_sd_all`, title, excerpt: META, bodyStatus: "unconfirmed", via: "fetch", publishedAt: new Date() } as never)).articleId;

test("identifiers and titles: DOI in a link, a ScienceDirect PII, the same title in another typesetting", () => {
  assert.equal(doiFromUrl("https://www.tandfonline.com/doi/full/10.1080/10503307.2025.2561887?af=R"), "10.1080/10503307.2025.2561887");
  assert.equal(doiFromUrl("https://onlinelibrary.wiley.com/doi/10.1002/WPS.70012?af=R"), "10.1002/wps.70012");
  assert.equal(doiFromUrl("https://jamanetwork.com/journals/jamapsychiatry/fullarticle/2839123"), null);
  assert.equal(piiFromUrl("https://www.sciencedirect.com/science/article/pii/S0272735826001121?dgcid=rss_sd_all"), "S0272735826001121");
  assert.ok(sameTitle("Attachment styles and problematic involvement: A systematic review and meta-analysis", "attachment styles and problematic involvement — a systematic review and meta‐analysis"));
  assert.ok(!sameTitle("Attachment styles and gambling", "Attachment styles and problematic involvement in potentially addictive behaviours"));
  assert.equal(invertedToText({ world: [1], Hello: [0] }), "Hello world");
  assert.equal(cleanAbstract("<jats:p>Abstract: too short</jats:p>"), null);
  assert.ok(cleanAbstract(`<jats:title>Abstract</jats:title><jats:p>${ABSTRACT}</jats:p>`)!.startsWith("Attachment theory"));
});

test("a ScienceDirect item: PII → DOI through Crossref, the abstract from OpenAlex", async () => {
  const { found } = await findAbstract({ title: "Any title", url: `https://www.sciencedirect.com/science/article/pii/${HIT}` });
  assert.deepEqual([found?.provider, found?.doi, found?.text], ["openalex", DOI, ABSTRACT]);
  const polite = seen.filter((u) => /^\/(crossref|openalex)\//.test(u));
  assert.equal(polite.length, 2);
  for (const u of polite) assert.equal(new URL(u, api.url).searchParams.get("mailto"), SITE.contactEmail, "the contact address goes with Crossref and OpenAlex");
});

test("a found abstract becomes the excerpt in a new revision; a miss is tried again later", async () => {
  const hitId = await thinArticle(HIT, `Found ${T}`);
  const missId = await thinArticle(MISS, `Missing ${T}`);
  const [before] = await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${hitId}`;
  await enrichThinAbstracts(50);
  const [hit] = await sql<{ excerpt: string; revision: number; processing_state: string }[]>`SELECT excerpt, revision, processing_state FROM articles WHERE id = ${hitId}`;
  assert.equal(hit!.excerpt, ABSTRACT);
  assert.equal(hit!.revision, before!.revision + 1, "a new revision, so the title-only analysis is stale");
  const [found] = await sql<{ provider: string; found_at: Date | null; attempts: number }[]>`SELECT provider, found_at, attempts FROM abstract_lookups WHERE article_id = ${hitId}`;
  assert.deepEqual([found!.provider, !!found!.found_at, found!.attempts], ["openalex", true, 1]);
  const [miss] = await sql<{ found_at: Date | null; attempts: number; due_in_hours: number }[]>`
    SELECT found_at, attempts, round(extract(epoch from next_try_at - now()) / 3600) AS due_in_hours FROM abstract_lookups WHERE article_id = ${missId}`;
  assert.deepEqual([miss!.found_at, miss!.attempts, Number(miss!.due_in_hours)], [null, 1, 6], "retried in 6 hours");
  // Not due yet: a second run leaves both alone.
  await enrichThinAbstracts(50);
  const [missAgain] = await sql<{ attempts: number }[]>`SELECT attempts FROM abstract_lookups WHERE article_id = ${missId}`;
  assert.equal(missAgain!.attempts, 1);
});
