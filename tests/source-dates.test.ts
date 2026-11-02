// Published dates and ordering of three live sources, on pages as they were served on 2026-11-03
// (tests/fixtures/source-dates, trimmed):
//  - Taylor & Francis feeds are not ordered by time: Psychology, Crime & Law (173 entries, the newest 169th)
//    lost every new article after the first 60. Sorting by date before the per-run cut keeps the newest.
//  - 心理学报 prints no day on its list, only the issue ("2026, 58 (11)"); the article's meta tells the day
//    it went online.
//  - 健康报 prints no date on its list; the day is in every article's address, the time in its page, and
//    the pages of 52 stored articles were never read (a run reads at most 12) or no longer exist.
// The configs under test are read from industry/sources.json, so the file cannot drift from the tests.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { allowed, fetchDetail, fromHtml } from "@aihot/backend/sources/web-list";
import { collectSource } from "@aihot/backend/sources/collect";

type Seed = { id: string; kind: string; config: Record<string, any>; tags?: string[] };
const { sources } = JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8")) as { sources: Seed[] };
const seed = (id: string) => structuredClone(sources.find((s) => s.id === id)!);
const fixture = (name: string) => readFileSync(new URL(`./fixtures/source-dates/${name}`, import.meta.url), "utf8");
const T = tag();

// A local stand-in for the three sites: `pages` maps a path to a body; anything else is a 404.
const pages = new Map<string, string>();
const server = http.createServer((req, res) => {
  const body = pages.get((req.url ?? "").split("?")[0]!);
  res.writeHead(body === undefined ? 404 : 200, { "content-type": body?.trimStart().startsWith("<?xml") ? "application/rss+xml" : "text/html; charset=utf-8" });
  res.end(body ?? "");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await stopBoss(); await closeDb(); });

/** Inserts a source as the seed describes it, its host replaced by the local stub (an initialized one: not a first import). */
async function insertSource(id: string, s: Seed, replaceHost: Record<string, string> = {}) {
  let text = JSON.stringify(s.config);
  for (const [from, to] of Object.entries(replaceHost)) text = text.replaceAll(from, to);
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, tags, cursor, next_fetch_at)
    VALUES (${id}, ${`source-dates ${T}`}, ${s.kind}, ${sql.json(JSON.parse(text))}, 'T1', 'editorial', ${s.tags ?? []},
      ${sql.json({ initializedAt: new Date().toISOString() })}, '2100-01-01')`;
}
const stored = async (id: string) => (await sql<{ url: string; published_at: Date | null; backfill: boolean }[]>`
  SELECT url, published_at, backfill FROM articles WHERE source_id = ${id} ORDER BY url`).map((r) => ({ url: r.url, at: r.published_at?.toISOString() ?? null, backfill: r.backfill }));

// ---- Taylor & Francis (and any feed whose entries are not in time order) ----

/** An RSS feed whose entries are in no time order: day `days[i]` before 2026-11-02 for entry i; null is an entry with no date. */
function feed(days: Array<number | null>, ns: string): string {
  const items = days.map((d, i) =>
    `<item><title>Article ${i}</title><link>https://example.org/${ns}/a/${i}</link>` +
    (d === null ? "" : `<pubDate>${new Date(Date.UTC(2026, 10, 2) - d * 86400e3).toUTCString()}</pubDate>`) + `</item>`).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${items}</channel></rss>`;
}

test("every Taylor & Francis feed sorts by date, as do the other feeds over the cut of 60 that are not strictly ordered", () => {
  const tandf = sources.filter((s) => s.kind === "rss" && String(s.config.feedUrl).includes("tandfonline.com/feed/"));
  assert.deepEqual(tandf.map((s) => s.id).sort(), [
    "rss-educational-psychologist", "rss-health-psychology-review", "rss-journal-positive-psychology", "rss-psychology-crime-law", "rss-psychotherapy-research",
  ]);
  for (const s of tandf) assert.equal(s.config.sortByPublishedAt, true, s.id);
  // In order on 2026-11-03 (0 inversions in 60-74 entries): switched on so a change of order cannot lose articles.
  for (const id of ["rss-jcpp", "rss-bjep", "rss-journal-organizational-behavior", "rss-biological-psychiatry", "rss-openai-news"]) assert.equal(seed(id).config.sortByPublishedAt, true, id);
});

test("a feed longer than the cut keeps its newest entries only when sorted: Psychology, Crime & Law's shape", async () => {
  // 100 dated entries, newest at positions 70 and 90 like the live feed; the rest in a scrambled older order.
  const days = Array.from({ length: 100 }, (_, i) => 40 + ((i * 37) % 100));
  days[70] = 0;
  days[90] = 1;
  const unsorted = `rss-source-dates-unsorted-${T}`;
  const sorted = `rss-source-dates-sorted-${T}`;
  pages.set(`/${unsorted}.xml`, feed(days, unsorted));
  pages.set(`/${sorted}.xml`, feed(days, sorted));
  const pcl = seed("rss-psychology-crime-law");
  await insertSource(unsorted, { ...pcl, config: { ...pcl.config, feedUrl: `${base}/${unsorted}.xml`, sortByPublishedAt: false } });
  await insertSource(sorted, { ...pcl, config: { ...pcl.config, feedUrl: `${base}/${sorted}.xml` } });
  const before = await collectSource(unsorted, { force: true });
  assert.deepEqual([before.status, before.found, before.created], ["ok", 100, 60]);
  const urls = (rows: Awaited<ReturnType<typeof stored>>) => rows.map((r) => r.url);
  assert.ok(!urls(await stored(unsorted)).includes(`https://example.org/${unsorted}/a/70`), "unsorted: the newest article is cut off");
  const after = await collectSource(sorted, { force: true });
  assert.deepEqual([after.status, after.found, after.created], ["ok", 100, 60]);
  const got = urls(await stored(sorted));
  assert.ok(got.includes(`https://example.org/${sorted}/a/70`) && got.includes(`https://example.org/${sorted}/a/90`), "sorted: both newest articles are collected");
});

test("entries without a date sort last: kept when the cut leaves room, cut first when it does not", async () => {
  // Today no T&F or SAGE feed we read has an undated entry (the audit of 2026-11-03: 0 of 173, 127, 69, 73).
  const room = `rss-source-dates-room-${T}`;
  const full = `rss-source-dates-full-${T}`;
  const feedOf = (id: string, dated: number) => pages.set(`/${id}.xml`, feed([null, ...Array.from({ length: dated }, (_, i) => 10 + i), null], id));
  feedOf(room, 30);
  feedOf(full, 70);
  const s = seed("rss-psychology-crime-law");
  await insertSource(room, { ...s, config: { ...s.config, feedUrl: `${base}/${room}.xml` } });
  await insertSource(full, { ...s, config: { ...s.config, feedUrl: `${base}/${full}.xml` } });
  assert.equal((await collectSource(room, { force: true })).created, 32, "30 dated and 2 undated: all kept");
  assert.equal((await collectSource(full, { force: true })).created, 60, "70 dated and 2 undated: the 60 newest");
  const undatedStored = (await stored(full)).filter((r) => r.at === null);
  assert.equal(undatedStored.length, 0, "the undated entries are the ones lost once the dated ones fill the cut");
});

// ---- 心理学报 ----

test("心理学报: the list has no day, the article's meta gives the day it went online", async () => {
  const s = seed("web-xinlixuebao");
  const rows = fromHtml(fixture("xlxb-home-rows.html"), s.config.url, { id: s.id, config: s.config } as never);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.publishedAt), [null, null, null], "the list prints the issue only (2026, 58 (11))");
  assert.equal(rows[0]!.url, "https://journal.psych.ac.cn/xlxb/CN/10.3724/SP.J.1041.2026.2167");

  pages.set("/xlxb/CN/10.3724/SP.J.1041.2026.2167", fixture("xlxb-article-2167.html"));
  pages.set("/xlxb/CN/10.3724/SP.J.1041.2026.1919", fixture("xlxb-article-1919.html"));
  const rule = { id: s.id, participation_mode: "editorial", config: s.config } as never;
  const need = { date: true, title: false, summary: false, body: false };
  // November issue: online 2026-09-10, issue dated 2026-11-25 (a future day, which meta citation_publication_date would give).
  const nov = await fetchDetail(`${base}/xlxb/CN/10.3724/SP.J.1041.2026.2167`, rule, need);
  assert.equal(nov.publishedAt?.toISOString(), "2026-09-10T00:00:00.000Z");
  // October issue: online 2026-08-04, issue dated 2026-10-25.
  const oct = await fetchDetail(`${base}/xlxb/CN/10.3724/SP.J.1041.2026.1919`, rule, need);
  assert.equal(oct.publishedAt?.toISOString(), "2026-08-04T00:00:00.000Z");
});

test("心理学报: a collection run dates what its detail pages date, and leaves the rest undated", async () => {
  const id = `web-source-dates-xlxb-${T}`;
  const s = seed("web-xinlixuebao");
  pages.set("/xlxb/CN/home", fixture("xlxb-home-rows.html").replaceAll("https://journal.psych.ac.cn", base));
  pages.set("/xlxb/CN/10.3724/SP.J.1041.2026.2167", fixture("xlxb-article-2167.html"));
  await insertSource(id, s, { "https://journal.psych.ac.cn": base });
  const run = await collectSource(id, { force: true });
  assert.deepEqual([run.status, run.found, run.created], ["ok", 3, 3]);
  const got = await stored(id);
  assert.deepEqual(got.map((r) => [r.url.slice(-4), r.at]), [["2167", "2026-09-10T00:00:00.000Z"], ["2178", null], ["2200", null]], "two pages are unreachable (404): no date, not a wrong one");
  // 49 days before it was found: archived by its date, never pushed as today's news.
  assert.equal(got[0]!.backfill, true);
});

test("心理学报 online first: the list prints the day each article went online, at the same address the issue later lists", () => {
  // The issue lists an article 5–8 weeks after it went online; the online-first list is where it is new.
  const s = seed("web-xinlixuebao-asap");
  const rows = fromHtml(fixture("xlxb-asap-rows.html"), s.config.url, { id: s.id, config: s.config } as never);
  assert.deepEqual(rows.map((r) => [r.url, r.publishedAt?.toISOString() ?? null]), [
    ["https://journal.psych.ac.cn/xlxb/CN/10.3724/SP.J.1041.2026.089", "2026-11-02T00:00:00.000Z"],
    ["https://journal.psych.ac.cn/xlxb/CN/10.3724/SP.J.1041.2026.090", "2026-10-29T00:00:00.000Z"],
    ["https://journal.psych.ac.cn/xlxb/CN/10.3724/SP.J.1041.2026.105", "2026-10-23T00:00:00.000Z"],
  ]);
  assert.equal(rows[0]!.title, "错误记忆影响决策偏好的双重意识机制");
});

// ---- 健康报 ----

test("健康报: the list gives each article's day from its address, even where the page cannot be read", () => {
  const s = seed("web-jkb-news");
  const rows = fromHtml(fixture("jkb-news-list.html"), s.config.url, { id: s.id, config: s.config } as never);
  const dated = Object.fromEntries(rows.map((r) => [r.url.replace("http://www.jkb.com.cn", ""), r.publishedAt?.toISOString() ?? null]));
  // The list has 7 rows; the 2 character rows are left out by the section rule.
  assert.deepEqual(dated, {
    "/industryNews/2026/1029/515042.html": "2026-10-28T16:00:00.000Z",
    "/industryNews/2026/1028/515003.html": "2026-10-27T16:00:00.000Z",
    "/publicHealth/2026/1029/515025.html": "2026-10-28T16:00:00.000Z",
    "/publicHealth/2026/1022/514823.html": "2026-10-21T16:00:00.000Z",
    "/publicHealth/2026/0929/514244.html": "2026-09-28T16:00:00.000Z",
  });
});

test("健康报: the person section is left out under both of its addresses", () => {
  const s = { id: "web-jkb-news", config: seed("web-jkb-news").config } as never;
  // The list now links /character/... (a 404 there: the page lives under /news/character/), which the old rule never matched.
  assert.equal(allowed("http://www.jkb.com.cn/character/2026/0106/508230.html", s), false);
  assert.equal(allowed("http://www.jkb.com.cn/news/character/2026/0106/508230.html", s), false);
  assert.equal(allowed("http://www.jkb.com.cn/industryNews/2026/1029/515042.html", s), true);
  assert.equal(allowed("http://www.jkb.com.cn/publicHealth/2026/1022/514823.html", s), true);
});

test("健康报: a path's year, month and day read as the day; a day that does not exist does not", () => {
  const read = (path: string) => fromHtml(`<li><a href="${path}">Post</a></li>`, "http://example.org/", { id: "t", config: { itemSelector: "li", publishedAtRegex: "/(\\d{4})/(\\d{2})(\\d{2})/\\d+\\.html" } } as never)[0]!.publishedAt?.toISOString() ?? null;
  assert.equal(read("/a/2026/1029/5.html"), "2026-10-28T16:00:00.000Z");
  assert.equal(read("/a/2026/0229/5.html"), null, "2026 is no leap year");
  assert.equal(read("/a/2026/1329/5.html"), null);
  assert.equal(read("/a/2026/1000/5.html"), null);
  assert.equal(read("/a/2028/0229/5.html"), "2028-02-28T16:00:00.000Z", "2028 is");
  // One group is still the date as printed.
  const one = fromHtml(`<li><a href="/x/2026/10/29/5.html">Post</a></li>`, "http://example.org/", { id: "t", config: { itemSelector: "li", publishedAtRegex: "/x/(\\d{4}/\\d{2}/\\d{2})/" } } as never)[0]!;
  assert.equal(one.publishedAt?.toISOString(), "2026-10-28T16:00:00.000Z");
});

test("健康报: the article page's time replaces the list's day when it is read, the day stays when it is not", async () => {
  const id = `web-source-dates-jkb-${T}`;
  const s = seed("web-jkb-news");
  s.config.detail.maxFetches = 1; // a run reads one page: the burst of 36 new articles on 2026-10-27 left 27 of them unread
  pages.set("/news/", fixture("jkb-news-list.html"));
  pages.set("/industryNews/2026/1029/515042.html", fixture("jkb-article-515042.html"));
  await insertSource(id, s, { "http://www.jkb.com.cn": base });
  const run = await collectSource(id, { force: true });
  // 7 rows on the list; the 2 character rows are left out by the section rule.
  assert.deepEqual([run.status, run.found, run.created], ["ok", 5, 5]);
  const got = Object.fromEntries((await stored(id)).map((r) => [r.url.replace(base, ""), r.at]));
  assert.deepEqual(got, {
    "/industryNews/2026/1028/515003.html": "2026-10-27T16:00:00.000Z", // not read (over the budget): its day
    "/industryNews/2026/1029/515042.html": "2026-10-29T00:48:17.000Z", // read: crtime 2026-10-29 08:48:17 in +08:00
    "/publicHealth/2026/0929/514244.html": "2026-09-28T16:00:00.000Z",
    "/publicHealth/2026/1022/514823.html": "2026-10-21T16:00:00.000Z",
    "/publicHealth/2026/1029/515025.html": "2026-10-28T16:00:00.000Z",
  });
});

// ---- the migration that brings the stored sources in line ----

test("migration 0058 gives the stored sources these rules, leaves what an admin set alone, and runs twice to the same result", async () => {
  const migration = readFileSync(new URL("../database/migrations/0058_source_collection_rules.sql", import.meta.url), "utf8");
  // The stored configs as they were before (origin/main's industry/sources.json), cut to what the migration reads.
  const old: Record<string, Record<string, unknown>> = {
    "rss-psychology-crime-law": { feedUrl: "https://www.tandfonline.com/feed/rss/gpcl20" },
    "rss-bjep": { feedUrl: "https://bpspsychub.onlinelibrary.wiley.com/feed/20448279/most-recent", sortByPublishedAt: false },
    "rss-psychological-science": { feedUrl: "https://journals.sagepub.com/action/showFeed?jc=pssa" },
    "web-xinlixuebao": { url: "https://journal.psych.ac.cn/xlxb/CN/home", itemSelector: "div.noselectrow" },
    "web-jkb-news": {
      url: "http://www.jkb.com.cn/news/", itemSelector: "div.news li", denyUrlPrefixes: ["http://www.jkb.com.cn/news/character/"],
      detail: { maxFetches: 12, publishedAtRegex: '"crtime":"([^"]+)"', titleAuthoritative: true },
    },
  };
  const ids = Object.keys(old);
  const kinds: Record<string, string> = { "web-xinlixuebao": "web_list", "web-jkb-news": "web_list" };
  const configs = async () => Object.fromEntries((await sql<{ id: string; config: Record<string, any> }[]>`SELECT id, config FROM sources WHERE id IN ${sql(ids)}`).map((r) => [r.id, r.config]));
  await sql`DELETE FROM sources WHERE id IN ${sql(ids)}`;
  for (const id of ids) {
    await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, next_fetch_at)
      VALUES (${id}, 'migration test', ${kinds[id] ?? "rss"}, ${sql.json(old[id] as never)}, 'T1', 'editorial', '2100-01-01')`;
  }
  try {
    await sql.unsafe(migration);
    const after = await configs();
    assert.equal(after["rss-psychology-crime-law"]!.sortByPublishedAt, true);
    assert.equal(after["rss-bjep"]!.sortByPublishedAt, false, "a value that is set stays");
    assert.equal(after["rss-psychological-science"]!.sortByPublishedAt, undefined, "SAGE feeds are another change's (0057)");
    // What the migration writes is what industry/sources.json says.
    assert.deepEqual(after["web-xinlixuebao"]!.detail, seed("web-xinlixuebao").config.detail);
    const jkb = seed("web-jkb-news").config;
    assert.equal(after["web-jkb-news"]!.publishedAtRegex, jkb.publishedAtRegex);
    assert.deepEqual(after["web-jkb-news"]!.denyUrlPrefixes, jkb.denyUrlPrefixes);
    assert.deepEqual(after["web-jkb-news"]!.detail, { ...old["web-jkb-news"]!.detail as object, upgradeDatePrecision: true });
    await sql.unsafe(migration);
    assert.deepEqual(await configs(), after, "a second run changes nothing");
  } finally {
    await sql`DELETE FROM sources WHERE id IN ${sql(ids)}`;
  }
});
