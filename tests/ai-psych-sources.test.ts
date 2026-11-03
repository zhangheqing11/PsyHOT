// Psychology-side AI journals and filtered arXiv feeds (industry/sources.json), offline: the configs under
// test are the seed's own, the feeds are trimmed copies of what the publishers served on 2026-11-03
// (tests/fixtures/ai-psych-sources). Parsing and the ingest rules run through the collector's own functions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { noiseFilterReason } from "@aihot/backend/sources/collect";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";
import { parseJsonList } from "@aihot/backend/sources/json-list";
import { parseRss } from "@aihot/backend/sources/rss";
import type { SourceRow } from "@aihot/backend/sources/types";

type Seed = { id: string; kind: string; config: Record<string, any>; tier: string; track: string; region: string; participation_mode: string; interval_minutes: number; tags: string[]; signal_group_id?: string; enabled?: boolean };
const { sources } = JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8")) as { sources: Seed[] };
const seed = (id: string) => {
  const s = sources.find((x) => x.id === id);
  assert.ok(s, `${id} is in industry/sources.json`);
  return s as Seed;
};
const row = (id: string) => seed(id) as unknown as SourceRow;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/ai-psych-sources/${name}`, import.meta.url), "utf8");
const feed = (id: string, name: string) => parseRss(fixture(name), row(id), seed(id).config.feedUrl);

const ARXIV = ["rss-arxiv-cs-hc", "rss-arxiv-cs-cy", "rss-arxiv-cs-cl", "rss-arxiv-cs-ai"];
const JOURNALS = ["json-jmir-mental-health", "rss-npj-mental-health-research", "rss-npj-digital-medicine", "json-jmir-ai"];

test("the eight sources are valid seed entries with the intended attributes", () => {
  for (const id of [...JOURNALS, ...ARXIV]) {
    const s = seed(id);
    assert.deepEqual(unsupportedConfig(s.kind as never, s.config), [], id);
    assert.equal(s.track, "academic", id);
    assert.equal(s.region, "international", id);
    assert.equal(s.participation_mode, "editorial", id);
    assert.equal(s.config._aihot.initialBackfillLimit, 5, id);
    assert.notEqual(s.enabled, false, id);
  }
  for (const id of JOURNALS) {
    assert.equal(seed(id).tier, "T1", id);
    assert.ok(seed(id).tags.includes("期刊"), `${id}: a journal, so a feed abstract that is a fragment is not taken for one`);
  }
  for (const id of ARXIV) {
    const s = seed(id);
    assert.equal(s.kind, "rss", id);
    assert.equal(s.tier, "T2", id);
    assert.equal(s.interval_minutes, 360, id);
    assert.equal(s.config.poolMinScore, 53, id);
    assert.deepEqual(s.tags, ["预印本", "计算机"], id);
    assert.equal(s.signal_group_id, "arxiv", `${id}: one participant in heat, however many feeds list a paper`);
    assert.deepEqual(s.config.ingestNoiseFilter.dropMarkers, ["announce type: replace", "announce type: cross"], id);
  }
  assert.deepEqual(ARXIV.map((id) => seed(id).config.feedUrl), ["cs.HC", "cs.CY", "cs.CL", "cs.AI"].map((c) => `https://rss.arxiv.org/rss/${c}`));
  // Only the feeds with a large share of unrelated papers carry the psychology gate.
  assert.equal(seed("rss-arxiv-cs-hc").config.ingestNoiseFilter.requireMarkers, undefined);
  assert.equal(seed("rss-arxiv-cs-cy").config.ingestNoiseFilter.requireMarkers, undefined);
  assert.ok(seed("rss-arxiv-cs-cl").config.ingestNoiseFilter.requireMarkers.length > 50);
  assert.deepEqual(seed("rss-arxiv-cs-ai").config.ingestNoiseFilter.requireMarkers, seed("rss-arxiv-cs-cl").config.ingestNoiseFilter.requireMarkers);
  const journalMarkers = seed("rss-npj-digital-medicine").config.ingestNoiseFilter.requireMarkers as string[];
  assert.deepEqual(seed("json-jmir-ai").config.ingestNoiseFilter.requireMarkers, journalMarkers);
  assert.ok(journalMarkers.includes("psychiatr") && journalMarkers.includes("chatbot"));
  for (const word of ["stress", "emotional", "cognition"]) assert.ok(!journalMarkers.includes(word), `${word} is too common in medical AI`);
  // The two psychology journals take everything; JMIR Mental Health reads Crossref because its RSS is refused from the server.
  assert.equal(seed("json-jmir-mental-health").config.ingestNoiseFilter, undefined);
  assert.equal(seed("rss-npj-mental-health-research").config.ingestNoiseFilter, undefined);
  assert.equal(seed("json-jmir-mental-health").config.url, "https://api.crossref.org/journals/2368-7959/works?sort=created&order=desc&rows=25&select=title,DOI,URL,created,abstract");
  assert.equal(seed("json-jmir-ai").config.url, "https://api.crossref.org/journals/2817-1705/works?sort=created&order=desc&rows=25&select=title,DOI,URL,created,abstract");
});

test("arXiv: the feed text the filter reads starts with the announce type, so only new papers pass", () => {
  const items = feed("rss-arxiv-cs-ai", "arxiv-cs-ai.xml");
  assert.equal(items.length, 5);
  // The RSS description (arXiv:ID vN Announce Type: … / Abstract: …) is the candidate's excerpt.
  const types = items.map((c) => /^arXiv:\S+ Announce Type: ([a-z-]+)/.exec(c.excerpt ?? "")?.[1]);
  assert.deepEqual(types, ["new", "cross", "replace", "replace-cross", "new"]);
  assert.ok(items.every((c) => c.url.startsWith("https://arxiv.org/abs/") && c.publishedAt));
  // Four of the five carry psychology words, so only the announce type separates them.
  assert.deepEqual(items.map((c) => noiseFilterReason(c, row("rss-arxiv-cs-ai"))), [null, "dropMarkers", "dropMarkers", "dropMarkers", "requireMarkers"]);
  // Without the drop markers the cross and replace papers would have come in: the markers are what keeps them out.
  const withoutDrop = { ...row("rss-arxiv-cs-ai"), config: { ...seed("rss-arxiv-cs-ai").config, ingestNoiseFilter: { requireMarkers: seed("rss-arxiv-cs-ai").config.ingestNoiseFilter.requireMarkers } } } as SourceRow;
  assert.deepEqual(items.map((c) => noiseFilterReason(c, withoutDrop)), [null, null, null, null, "requireMarkers"]);
});

test("arXiv feeds without a psychology gate keep every new paper and still drop the others", () => {
  const items = feed("rss-arxiv-cs-hc", "arxiv-cs-hc.xml");
  assert.deepEqual(items.map((c) => /Announce Type: ([a-z-]+)/.exec(c.excerpt ?? "")?.[1]), ["new", "cross", "replace", "replace-cross"]);
  for (const id of ["rss-arxiv-cs-hc", "rss-arxiv-cs-cy"]) {
    assert.deepEqual(items.map((c) => noiseFilterReason(c, row(id))), [null, "dropMarkers", "dropMarkers", "dropMarkers"], id);
  }
});

test("npj Digital Medicine keeps psychiatry titles and rejects other medical AI; npj Mental Health Research takes all", () => {
  const got = Object.fromEntries(feed("rss-npj-digital-medicine", "npj-digital-medicine.xml").map((c) => [c.title.slice(0, 25), noiseFilterReason(c, row("rss-npj-digital-medicine"))]));
  assert.deepEqual(got, {
    "Implementation strategies": null,
    "Generation of synthetic c": "requireMarkers",
  });
  // The Nature feed gives a title and a date, not an abstract, so the gate reads the title alone.
  assert.ok(feed("rss-npj-digital-medicine", "npj-digital-medicine.xml").every((c) => !c.excerpt));
  for (const c of feed("rss-npj-digital-medicine", "npj-digital-medicine.xml")) assert.equal(noiseFilterReason(c, row("rss-npj-mental-health-research")), null);
});

test("JMIR AI (Crossref) keeps items naming a psychology marker and rejects the rest", () => {
  const items = parseJsonList(JSON.parse(fixture("jmir-ai-crossref.json")), row("json-jmir-ai"));
  assert.equal(items.length, 3);
  assert.ok(items.every((c) => c.url.startsWith("https://doi.org/10.2196/") && c.publishedAt));
  const verdict = Object.fromEntries(items.map((c) => [c.title.slice(0, 25), noiseFilterReason(c, row("json-jmir-ai"))]));
  assert.deepEqual(verdict, {
    "Rethinking Health Care Re": "requireMarkers",
    "Quality Assessment of Art": null,
    "Nonlinear Feature Modelin": null,
  });
  // The Crossref abstract is stored as text, not JATS markup.
  assert.ok(items.every((c) => !c.excerpt || !/<\/?jats:/.test(c.excerpt)));
  assert.equal(items.filter((c) => noiseFilterReason(c, row("json-jmir-mental-health"))).length, 0);
});
