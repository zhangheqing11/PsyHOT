import assert from "node:assert/strict";
import { test } from "node:test";
import { isAbstractCandidate } from "@aihot/backend/editorial/abstract-translate";
import { journalAbstractFromHtml } from "@aihot/backend/content/journal-abstract";
import { parseRss } from "@aihot/backend/sources/rss";
import { parseJsonList } from "@aihot/backend/sources/json-list";
import type { SourceRow } from "@aihot/backend/sources/types";

const ABSTRACT = "Objectives We investigated the relationship between sleep quality and emotional wellbeing in adolescents. Methods Participants completed standardised measures at baseline and follow-up. Results Sleep quality was associated with later wellbeing, with uncertainty remaining after adjustment. Conclusions These observational findings require replication and cannot establish a causal effect. ";
const STRENGTHS = "STRENGTHS AND LIMITATIONS OF THIS STUDY This study used a large sample. The cross-sectional design cannot establish causality. Introduction Depression and anxiety are common mental health conditions. ".repeat(3);
const METADATA = "Article title: Cognitive behavioral therapy and emotion-focused therapy for depression in a routine care setting: A randomized controlled pilot trialAuthors: Hanna Aardal, Elisabeth Schanche, Aslak...";
const LONG = `${ABSTRACT.repeat(7)}Trial registration number ISRCTN12345678.`;
const feed = (summary: string) => `<rss version="2.0"><channel><item><title>Study</title><link>https://example.org/study</link><description><![CDATA[${summary}]]></description></item></channel></rss>`;
const source = (tags: string[]) => ({ kind: "rss", tags, participation_mode: "editorial", config: {} }) as SourceRow;

test("journal translation rejects body sections, article metadata and legacy RSS truncation", () => {
  for (const excerpt of [STRENGTHS, METADATA, LONG.slice(0, 2000)]) {
    assert.equal(isAbstractCandidate({ excerpt, tags: ["期刊"], language: "en" }), false);
  }
  assert.equal(isAbstractCandidate({ excerpt: LONG.slice(0, 2000), tags: ["预印本"], language: "en" }), true,
    "the journal rule does not change the preprint path");
});

test("explicit HTML abstracts reject mislabeled body and metadata while preserving a full long abstract", () => {
  assert.equal(journalAbstractFromHtml(`<section class="abstract"><p>${STRENGTHS}</p></section>`), null);
  assert.equal(journalAbstractFromHtml(`<meta name="citation_abstract" content="${METADATA}">`), null);
  assert.equal(journalAbstractFromHtml(`<div class="abstract"><h2>Abstract</h2><p>${LONG}</p></div>`), LONG);
  assert.equal(journalAbstractFromHtml(`<div class="abstract"><h2>Abstract</h2><p>${LONG.slice(0, 2000)}</p></div>`), LONG.slice(0, 2000),
    "an explicitly bounded abstract may legitimately have exactly 2000 characters");
});

test("journal RSS summaries keep complete abstracts and discard known non-abstract descriptions", () => {
  assert.equal(parseRss(feed(LONG), source(["期刊"]), "https://example.org/rss")[0]!.excerpt, LONG);
  assert.equal(parseRss(feed(STRENGTHS), source(["期刊"]), "https://example.org/rss")[0]!.excerpt, null);
  assert.equal(parseRss(feed(METADATA), source(["期刊"]), "https://example.org/rss")[0]!.excerpt, null);
  assert.equal(parseRss(feed(LONG), source(["预印本"]), "https://example.org/rss")[0]!.excerpt, LONG.slice(0, 2000));
});

test("journal JSON summaries preserve complete abstracts while preprints retain their existing length limit", () => {
  const config = { itemsPath: "items", titlePaths: ["title"], summaryPaths: ["abstract"], urlTemplate: "https://example.org/{id}" };
  const data = { items: [{ id: "one", title: "Study", abstract: LONG }] };
  assert.equal(parseJsonList(data, { ...source(["期刊"]), config })[0]!.excerpt, LONG);
  assert.equal(parseJsonList(data, { ...source(["预印本"]), config })[0]!.excerpt, LONG.slice(0, 2000));
});
