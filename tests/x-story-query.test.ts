import assert from "node:assert/strict";
import { test } from "node:test";
import { lookupQuery, probeQueries, matchingXPosts } from "../packages/backend/src/events/x-story-query.ts";

const at = new Date("2026-10-24T12:00:00Z");
const reports = [{ id: "paper", url: "https://www.nature.com/articles/s41562-026-01234-5?utm_source=rss",
  title: "New study reveals how sleep changes emotional memory across adolescence",
  body: "Original paper: https://doi.org/10.1038/s41562-026-01234-5." }];
const post = (id: number, text: string, patch: Record<string, unknown> = {}) => ({
  id: String(id), url: `https://x.com/research/status/${id}`, text,
  posted_at: "2026-10-23T12:00:00Z", like_count: id, retweet_count: 0, reply_count: 0, ...patch,
});

test("probe keeps three distinct formats, strips URL tracking, and preserves a contiguous English phrase", () => {
  const queries = probeQueries(reports, at);
  assert.deepEqual(queries.map((q) => q.format), ["doi", "url", "phrase"]);
  assert.equal(queries[0].needle, "10.1038/s41562-026-01234-5");
  assert.equal(queries[1].needle, "nature.com/articles/s41562-026-01234-5");
  assert.ok(queries[1].keyword.startsWith("url:nature.com/"));
  assert.ok(reports[0].title.toLowerCase().includes(queries[2].needle.toLowerCase()));
  assert.ok(queries[2].needle.split(/\s+/).length >= 6);
  assert.ok(!/^new study/i.test(queries[2].needle));
  for (const q of queries) assert.ok(q.keyword.endsWith("since:2026-10-17 -filter:replies"));
});

test("a DOI in a reporting URL takes priority over incidental citations in body text", () => {
  const queries = probeQueries([{ ...reports[0], url: "https://doi.org/10.1000/primary", body: "References: 10.1000/citation" }], at);
  assert.equal(queries[0].needle, "10.1000/primary");
});

test("unusable URLs and non-English or short titles do not invent search formats", () => {
  assert.deepEqual(probeQueries([{ id: "x", url: "https://mp.weixin.qq.com/s?__biz=a&mid=1", title: "中文标题", body: null }], at), []);
  assert.deepEqual(probeQueries([{ id: "x", url: "https://example.com/", title: "Short title", body: null }], at), []);
});

test("DOI matches are exact, case insensitive, and limited to text and explicit links", () => {
  const doi = probeQueries(reports, at)[0];
  const rows = [post(1, "Read 10.1038/S41562-026-01234-5."),
    post(2, "Different paper 10.1038/s41562-026-01234-50"),
    post(3, "Unrelated text", { author_name: doi.needle }),
    post(4, "Read this", { entities: { urls: [{ expanded_url: `https://doi.org/${doi.needle}` }] } }),
    post(5, "Read this", { links: [`https://doi.org/${doi.needle}`] })];
  assert.deepEqual(matchingXPosts(rows, doi, at).map((p) => p.identityKey), ["x:5", "x:4", "x:1"]);
});

test("URL match rejects path prefixes, lookalike hosts, and addresses buried in another URL's query", () => {
  const url = probeQueries(reports, at)[1];
  const rows = [post(1, `Read https://www.${url.needle}?utm_source=x`),
    post(2, `Read https://${url.needle}-unrelated`),
    post(3, `Read https://evil.test/?next=https://${url.needle}`),
    post(4, `Read https://evil.${url.needle}`), post(5, `Read ${url.needle}`)];
  assert.deepEqual(matchingXPosts(rows, url, at).map((p) => p.identityKey), ["x:5", "x:1"]);
});

test("quoted phrase requires all words in order with word boundaries", () => {
  const phrase = probeQueries(reports, at)[2];
  const rows = [post(1, phrase.needle.toUpperCase()), post(2, phrase.needle.split(" ").reverse().join(" ")),
    post(3, `prefix${phrase.needle}suffix`), post(4, phrase.needle.replace(/ /g, "\n"))];
  assert.deepEqual(matchingXPosts(rows, phrase, at).map((p) => p.identityKey), ["x:4", "x:1"]);
});

test("verified posts are unique and capped at five by likes + twice reposts + replies", () => {
  const query = probeQueries(reports, at)[0];
  const rows = Array.from({ length: 8 }, (_, i) => post(i + 1, query.needle));
  rows.push(post(1, query.needle, { retweet_count: 20 }));
  assert.deepEqual(matchingXPosts(rows, query, at).map((p) => p.identityKey), ["x:1", "x:8", "x:7", "x:6", "x:5"]);
});

test("untrusted timestamps and unsafe post identities cannot become event evidence", () => {
  const query = probeQueries(reports, at)[0];
  const rows = [post(1, query.needle, { posted_at: "2026-10-16T23:59:59Z" }),
    post(2, query.needle, { posted_at: "2026-10-25T00:00:00Z" }),
    post(3, query.needle, { posted_at: null }), post(4, query.needle, { id: 4 }),
    post(5, query.needle, { url: "https://evil.test/research/status/5" })];
  assert.equal(matchingXPosts(rows, query, at).length, 0);
});

test("lookup runs the phrase query only, the same one the probe builds, and nothing without an English title", () => {
  const query = lookupQuery(reports, at)!;
  assert.equal(query.format, "phrase");
  assert.deepEqual(query, probeQueries(reports, at).find((q) => q.format === "phrase"));
  assert.equal(lookupQuery([{ ...reports[0], title: "睡眠与记忆的新研究" }], at), null);
  assert.equal(lookupQuery([{ id: "x", url: reports[0].url, title: "Short title", body: null }], at), null);
  assert.equal(lookupQuery([{ id: "x", url: "https://example.com/", title: "短", body: null }, reports[0]], at)!.articleId, "paper");
});
