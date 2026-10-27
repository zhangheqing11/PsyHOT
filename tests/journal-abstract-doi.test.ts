import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { enrichThinAbstracts, findAbstract } from "@aihot/backend/content/abstracts";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { abstractSourceHash } from "@aihot/backend/editorial/abstract-translate";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const SOURCE = `test-journal-doi-${T}`;
const ABSTRACT = "Introduction This trial examined whether a community intervention improved parental wellbeing and responsive interaction. Methods Families were randomly allocated to the intervention or usual care. Results The intervention was associated with improvements in the measured outcomes, with uncertainty remaining for some secondary outcomes. Conclusions The findings require replication in other populations.";
const inverted = Object.fromEntries(ABSTRACT.split(" ").map((word, index) => [word, ABSTRACT.split(" ").flatMap((w, i) => w === word ? [i] : [])]));
const terms = (title: string) => title.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 200);
interface Work { DOI: string; title: string[]; abstract?: string }
interface Scenario { title: string; works: Work[]; openalex?: boolean; epmc?: boolean; titleHit?: boolean; crossrefError?: boolean }
const scenarios: Scenario[] = [
  { title: "Common elements-based nurturing care intervention to improve mother-infant responsive interaction and maternal psychological wellbeing in rural Pakistan: findings of a single-blinded individual randomised controlled trial", works: [{ DOI: "10.1136/bmjopen-2026-119908", title: ["Common elements-based nurturing care intervention to improve mother–infant responsive interaction and maternal psychological wellbeing in rural Pakistan: findings of a single-blinded individual randomised controlled trial"] }], openalex: true },
  { title: "Supporting physical activity through co-production in people with severe mental illness (SPACES): study protocol for a pragmatic, parallel-group randomised controlled trial", works: [{ DOI: "10.1136/bmjopen-2025-115528", title: ["Supporting physical activity through co-production in people with severe mental illness (SPACES): study protocol for a pragmatic, parallel-group randomised controlled trial"] }], openalex: true },
];
function scenario(title: string, opts: Partial<Scenario> = {}): Scenario {
  const row = { title, works: [{ DOI: `10.1234/${title.toLowerCase().replaceAll(" ", "-")}`, title: [title] }], ...opts };
  scenarios.push(row);
  return row;
}
const epmc = scenario("DOI resolved Europe PMC fallback", { epmc: true });
const cached = scenario("Cached Crossref abstract fallback");
cached.works[0]!.abstract = `<jats:p>${ABSTRACT}</jats:p>`;
const wrong = scenario("Sleep treatment in adolescents", { works: [{ DOI: "10.1234/unrelated", title: ["Sleep treatment in older adults"], abstract: ABSTRACT }] });
const ambiguousTitle = "A longitudinal study of sleep quality and emotional wellbeing in adolescents";
const ambiguous = scenario(ambiguousTitle, { works: [
  { DOI: "10.1234/one", title: [`${ambiguousTitle}: trial protocol`], abstract: ABSTRACT },
  { DOI: "10.1234/two", title: [`${ambiguousTitle}: follow-up results`], abstract: ABSTRACT },
] });
const exact = scenario("Exact title selection despite a similar trial protocol", { openalex: true });
exact.works.unshift({ DOI: "10.1234/similar-protocol", title: [`${exact.title}: protocol`] });
const absent = scenario("An unindexed journal study with no available abstract");
const errorFallback = scenario("Crossref unavailable but title indexing works", { titleHit: true, crossrefError: true });
const seen: string[] = [];
const api = await stub((_hit, req) => {
  seen.push(req.url);
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/crossref/works") {
    const row = scenarios.find((s) => terms(s.title) === url.searchParams.get("query.bibliographic"));
    return row?.crossrefError ? new Reply(503, {}) : { message: { items: row?.works ?? [] } };
  }
  if (url.pathname.startsWith("/openalex/works/doi:")) {
    const doi = decodeURI(url.pathname.slice("/openalex/works/doi:".length));
    const row = scenarios.find((s) => s.works.some((w) => w.DOI === doi));
    return row?.openalex ? { doi: `https://doi.org/${doi}`, abstract_inverted_index: inverted } : new Reply(404, {});
  }
  if (url.pathname === "/openalex/works") {
    const title = url.searchParams.get("filter")?.replace(/^title.search:/, "");
    const row = scenarios.find((s) => terms(s.title) === title && s.titleHit);
    return { results: row ? [{ title: row.title, abstract_inverted_index: inverted }] : [] };
  }
  if (url.pathname === "/epmc/search") {
    const query = url.searchParams.get("query");
    const row = scenarios.find((s) => s.epmc && s.works.some((w) => query === `DOI:"${w.DOI}"`));
    return { resultList: { result: row ? [{ doi: "10.1234/wrong-hit", abstractText: "Wrong abstract" }, { doi: row.works[0]!.DOI, abstractText: ABSTRACT }] : [] } };
  }
  return { message: {} };
});
process.env.OPENALEX_API_URL = `${api.url}/openalex`;
process.env.CROSSREF_API_URL = `${api.url}/crossref`;
process.env.EUROPEPMC_API_URL = `${api.url}/epmc`;
config.allowPrivateNetworkFetch = true;
config.modelCallsEnabled = false;
config.abstractTranslationDays = 3;
const previousDispatcher = getGlobalDispatcher();
const offline = new MockAgent();
offline.disableNetConnect();
offline.enableNetConnect(/^127\.0\.0\.1:\d+$/);
offline.get("https://www.nature.com").intercept({ path: /.*/ }).reply(403, "blocked").persist();
setGlobalDispatcher(offline);
before(async () => {
  await sql`DELETE FROM articles WHERE source_id LIKE 'test-journal-doi-%'`;
  await sql`DELETE FROM sources WHERE id LIKE 'test-journal-doi-%'`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, tags, next_fetch_at)
    VALUES (${SOURCE}, 'Test journal DOI', 'rss', 'T1', 'editorial', ${["期刊"]}, '2100-01-01')`;
});
beforeEach(() => { seen.length = 0; });
after(async () => {
  setGlobalDispatcher(previousDispatcher);
  await offline.close();
  await api.close();
  await stopBoss();
  await closeDb();
});
const lookup = (s: Scenario, journal = true) => findAbstract({ title: s.title, url: "https://www.nature.com/articles/without-doi" }, { journal });
const crossrefRequests = () => seen.filter((u) => u.startsWith("/crossref/"));

test("journal titles resolve to a DOI before OpenAlex lookup even when title indexing is empty", async () => {
  for (const s of scenarios.slice(0, 2)) {
    seen.length = 0;
    const { found } = await lookup(s);
    assert.deepEqual([found?.provider, found?.doi, found?.text], ["openalex", s.works[0]!.DOI, ABSTRACT]);
    assert.equal(crossrefRequests().length, 1);
    assert.ok(seen.some((u) => u.startsWith(`/openalex/works/doi:${s.works[0]!.DOI}`)));
    assert.ok(!seen.some((u) => u.startsWith("/openalex/works?")));
  }
});
test("a resolved DOI also reaches Europe PMC and cached Crossref abstracts without duplicate requests", async () => {
  const pmc = await lookup(epmc);
  assert.deepEqual([pmc.found?.provider, pmc.found?.doi, pmc.found?.text], ["europepmc", epmc.works[0]!.DOI, ABSTRACT]);
  seen.length = 0;
  const result = await lookup(cached);
  assert.deepEqual([result.found?.provider, result.found?.doi, result.found?.text], ["crossref", cached.works[0]!.DOI, ABSTRACT]);
  assert.equal(crossrefRequests().length, 1, "the title response already contained this abstract");
});
test("unrelated and ambiguous Crossref titles never supply a DOI or an abstract", async () => {
  for (const s of [wrong, ambiguous]) {
    seen.length = 0;
    assert.equal((await lookup(s)).found, null);
    assert.ok(!seen.some((u) => u.includes("/works/doi:")));
    assert.equal(crossrefRequests().length, 1);
  }
});
test("an exact title wins over a similar protocol and Crossref errors retain the title fallback", async () => {
  assert.equal((await lookup(exact)).found?.doi, exact.works[1]!.DOI);
  const fallback = await lookup(errorFallback);
  assert.equal(fallback.found?.provider, "openalex");
  assert.match(fallback.errors.join(";"), /crossref.*503/);
});
test("preprints retain their previous title-only metadata path when the URL has no DOI", async () => {
  assert.equal((await lookup(scenarios[0]!, false)).found, null);
  assert.ok(seen[0]!.startsWith("/openalex/works?"));
  assert.ok(!seen.some((u) => u.includes("/works/doi:")));
});
test("the DOI recovery version retries failed journals once and leaves successful abstracts and translations intact", async () => {
  const ids: string[] = [];
  for (const s of [scenarios[0]!, absent]) {
    const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://www.nature.com/articles/${s.works[0]!.DOI.split("/")[1]}`, title: s.title,
      excerpt: null, bodyStatus: "unconfirmed", via: "fetch", publishedAt: new Date() });
    ids.push(articleId);
    await sql`INSERT INTO abstract_lookups (article_id, attempts, next_try_at, last_error)
      VALUES (${articleId}, 6, now() + interval '14 days', 'journal-abstract-quality-v1: publisher HTTP 403')`;
  }
  const { articleId: ready } = await upsertMaterial({ sourceId: SOURCE, url: `https://www.nature.com/articles/already-verified-${T}`, title: "Ready study",
    excerpt: ABSTRACT, bodyStatus: "unconfirmed", via: "fetch" });
  await sql`INSERT INTO abstract_lookups (article_id, attempts, found_at, provider, last_error)
    VALUES (${ready}, 1, now(), 'openalex', 'journal-abstract-quality-v1:')`;
  await sql`INSERT INTO abstract_translations (article_id, revision, lang, source_hash, status, text_zh)
    VALUES (${ready}, 1, 'zh', ${abstractSourceHash(ABSTRACT)}, 'translated', '已完成的翻译')`;
  assert.deepEqual(await enrichThinAbstracts(30), { tried: 2, found: 1 });
  const rows = await sql`SELECT a.id, a.revision, a.excerpt, l.attempts, l.found_at, l.last_error
    FROM articles a JOIN abstract_lookups l ON l.article_id = a.id WHERE a.id IN ${sql(ids)}`;
  assert.ok(rows.every((r) => r.attempts === 7 && r.last_error.startsWith("journal-abstract-quality-v2:")));
  assert.equal(rows.find((r) => r.id === ids[0])!.excerpt, ABSTRACT);
  assert.equal(rows.find((r) => r.id === ids[1])!.excerpt, null, "an unindexed DOI does not invent an abstract");
  const hits = seen.length;
  assert.deepEqual(await enrichThinAbstracts(30), { tried: 0, found: 0 });
  assert.equal(seen.length, hits);
  assert.equal((await sql`SELECT revision FROM articles WHERE id = ${ready}`)[0]!.revision, 1);
  assert.equal((await sql`SELECT text_zh FROM abstract_translations WHERE article_id = ${ready}`)[0]!.text_zh, "已完成的翻译");
});
