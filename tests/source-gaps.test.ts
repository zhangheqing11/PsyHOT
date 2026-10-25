// Offline source fixtures: parsing and filtering must be testable without HTTP, a database, a paid
// provider or a model call. These cases cover the date and noise configurations most likely to drift.
import assert from "node:assert/strict";
import { test } from "node:test";
import { noiseFilterReason, noiseFiltered } from "@aihot/backend/sources/collect";
import { assertSupportedConfig, unsupportedConfig } from "@aihot/backend/sources/config-keys";
import { parseJsonList, parseJsonListDetailed } from "@aihot/backend/sources/json-list";
import { parseRss } from "@aihot/backend/sources/rss";
import type { SourceRow } from "@aihot/backend/sources/types";

const source = (config: Record<string, unknown>) => ({ config, participation_mode: "editorial" }) as SourceRow;
const datePaths = ["published-online.date-parts.0", "published-print.date-parts.0", "issued.date-parts.0"];
const jsonConfig = { itemsPath: "message.items", titlePaths: ["title.0"], urlTemplate: "https://doi.org/{raw:DOI}", publishedAtPaths: datePaths };
const work = (extra: Record<string, unknown> = {}) => ({ title: ["A cognitive study"], DOI: "10.1037/test0001", ...extra });
const json = (items: unknown[], config: Record<string, unknown> = jsonConfig) => parseJsonList({ message: { items } }, source(config));

const rss = (description: string, date = "") => parseRss(`<rss version="2.0"><channel><title>Journal</title><item>
  <title>A cognitive study</title><link>https://example.org/article</link>
  ${date}<description><![CDATA[${description}]]></description></item></channel></rss>`, source({}), "https://example.org/feed")[0]!;

test("RSS pure parser uses a strict publication-description fallback", () => {
  assert.equal(rss("<p>Publication date: Available online 21 October 2026</p><p>Source: Cognition</p>").publishedAt?.toISOString(), "2026-10-21T00:00:00.000Z");
  assert.equal(rss("Publication date: 1 February 2026").publishedAt?.toISOString(), "2026-02-01T00:00:00.000Z");
  assert.equal(rss("Publication date: 15 November 2026<p>Available online 21 October 2026</p>").publishedAt?.toISOString(), "2026-10-21T00:00:00.000Z");
  assert.equal(rss("Publication date: Available online 21 October 2026", "<pubDate>Tue, 20 Oct 2026 15:30:00 GMT</pubDate>").publishedAt?.toISOString(), "2026-10-20T15:30:00.000Z");
  assert.equal(rss("Publication date: 1 February 2026", "<pubDate>Tue, 30 Feb 2026 15:30:00 GMT</pubDate>").publishedAt?.toISOString(), "2026-02-01T00:00:00.000Z");
  for (const text of ["Accepted 21 October 2026", "Updated 21 October 2026", "Available online 21 October 2026", "Publication date: February 2026", "Publication date: 30 February 2026", "Publication date: forthcoming"]) {
    assert.equal(rss(text).publishedAt, null, text);
  }
});

test("JSON date paths fall back in order and validate Crossref calendar arrays", () => {
  const items = [
    work({ "published-online": { "date-parts": [[2026, 10, 21]] }, "published-print": { "date-parts": [[2026, 11, 1]] } }),
    work({ "published-online": { "date-parts": [[]] }, "published-print": { "date-parts": [[2026, 10, 20]] } }),
    work({ "published-online": { "date-parts": [[2026, 2, 30]] }, issued: { "date-parts": [[2026, 10, 19]] } }),
    work({ created: { "date-time": "2026-10-23T12:00:00Z" } }),
  ];
  assert.deepEqual(json(items).map((c) => c.publishedAt?.toISOString() ?? null), [
    "2026-10-21T00:00:00.000Z", "2026-10-20T00:00:00.000Z", "2026-10-19T00:00:00.000Z", null,
  ]);
  assert.deepEqual(json([[2026, 10, 21], [2026, 10], [2026], [2024, 2, 29]].map((parts) => work({ issued: { "date-parts": [parts] } }))).map((c) => c.publishedAt?.toISOString()), [
    "2026-10-21T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2024-02-29T00:00:00.000Z",
  ]);
  for (const parts of [[], [2026, 0, 1], [2026, 13, 1], [2026, 2, 29], [2026, 10, 0], [2026, 10, 32], [2026, 1.5, 1], ["2026", 10, 1], [2026, 10, 1, 2]]) {
    assert.equal(json([work({ issued: { "date-parts": [parts] } })])[0]!.publishedAt, null, JSON.stringify(parts));
  }
});

test("legacy JSON date paths and units remain compatible", () => {
  for (const [value, unit, expected] of [
    ["2026-10-21T12:30:00+08:00", undefined, "2026-10-21T04:30:00.000Z"],
    [0, "epoch_s", "1970-01-01T00:00:00.000Z"], [0, "epoch_ms", "1970-01-01T00:00:00.000Z"],
    ["20261021", "yyyymmdd", "2026-10-21T00:00:00.000Z"], [[2026, 10, 21], undefined, "2026-10-21T00:00:00.000Z"],
  ] as const) {
    const [got] = parseJsonList([work({ date: value })], source({ titlePaths: ["title.0"], urlTemplate: "https://doi.org/{raw:DOI}", publishedAtPath: "date", publishedAtUnit: unit }));
    assert.equal(got!.publishedAt?.toISOString(), expected);
  }
});

test("JSON exclude patterns produce clear evidence and keep mapping errors visible", () => {
  const config = { ...jsonConfig, excludePatterns: { "title.0": "^Supplemental Material\\b", DOI: "\\.supp$" } };
  assertSupportedConfig("json_list", config);
  const result = parseJsonListDetailed({ message: { items: [work({ DOI: "10.1037/test.supp" })] } }, source(config));
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.exclusions, [{ index: 0, reason: "exclude-pattern", path: "DOI" }]);
  assert.throws(() => json([{ DOI: "10.1037/research" }], config), /no items mapped/);
  assert.throws(() => json([work()], { ...config, excludePatterns: { DOI: "[" } }), /regular expression/i);
});

test("Xiaohongshu goods notes are excluded before mapping, and requireMarkers works for MP rules", () => {
  const xhs = source({ adapter: "everyinfra_xhs", summaryIsBody: true });
  const found = parseJsonList({ results: [
    { id: "n1", url: "https://www.xiaohongshu.com/explore/n1", title: "Nature 子刊：心理健康研究", text: "一项纵向研究", posted_at: "2026-10-16T08:00:00Z" },
    { id: "n2", url: "https://www.xiaohongshu.com/explore/n2", title: "商品推广", text: "买它", posted_at: "2026-10-16T08:00:00Z", is_goods_note: true },
  ] }, xhs);
  assert.deepEqual(found.map((c) => c.url), ["https://www.xiaohongshu.com/explore/n1"]);
  assert.deepEqual(parseJsonList({ results: [{ id: "n3", url: "https://www.xiaohongshu.com/explore/n3", title: "商品推广", is_goods_note: true }] }, xhs), [], "a batch of known goods notes is a successful empty listing");
  const broadAccount = source({ ingestNoiseFilter: { requireMarkers: ["心理", "研究"], dropMarkers: ["课程"] } });
  const keep = { title: "心理健康研究进展", excerpt: "一项研究", url: "https://example.org/1" } as never;
  const reject = { title: "秋天莫名难过？", excerpt: "收藏起来", url: "https://example.org/2" } as never;
  assert.equal(noiseFilterReason(keep, broadAccount), null);
  assert.equal(noiseFilterReason(reject, broadAccount), "requireMarkers");
  assert.equal(noiseFiltered(reject, broadAccount), true);
});

test("new source keys are strict while old single-date configs remain valid", () => {
  assert.deepEqual(unsupportedConfig("json_list", { publishedAtPath: "date", publishedAtPaths: ["a", "b"], excludePatterns: { DOI: "\\.supp$" } }), []);
  assert.deepEqual(unsupportedConfig("rss", { userAgent: "PsyHOTBot/1.0" }), []);
  assert.throws(() => assertSupportedConfig("json_list", { publishedAtPaths: "date" }), /publishedAtPaths/);
  assert.throws(() => assertSupportedConfig("json_list", { excludePatterns: { DOI: 42 } }), /excludePatterns/);
  assert.throws(() => assertSupportedConfig("rss", { userAgent: "   " }), /userAgent/);
  assert.throws(() => assertSupportedConfig("json_list", { publishedAtUnit: "created" }), /publishedAtUnit/);
});
