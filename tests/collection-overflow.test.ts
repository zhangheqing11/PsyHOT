import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";

const T = tag();
let listing: Array<{ title: string; url: string }> = [];
let notModified = false;
let broken = false;
const entries = (label: string, n = 6) => Array.from({ length: n }, (_, i) => ({ title: `Study ${label} ${i}`, url: `https://example.org/overflow-${T}/${label}/${i}` }));
const server = http.createServer((req, res) => {
  const path = req.url ?? "";
  if (broken) {
    res.writeHead(503);
    res.end("unavailable");
  } else if (notModified && req.headers["if-none-match"]) {
    res.writeHead(304, { etag: '"overflow"' });
    res.end();
  } else if (path.startsWith("/http")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`Title: Listing\nURL Source: ${path.slice(1)}\nMarkdown Content:\n${listing.map((c) => `[${c.title}](${c.url})`).join("\n\n")}`);
  } else if (path.endsWith(".xml")) {
    res.writeHead(200, { "content-type": "application/rss+xml", etag: '"overflow"' });
    res.end(`<rss version="2.0"><channel><title>Overflow</title>${listing.map((c) => `<item><title>${c.title}</title><link>${c.url}</link></item>`).join("")}</channel></rss>`);
  } else if (path.endsWith(".json")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: listing }));
  } else {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(listing.map((c) => `<article><a href="${c.url}">${c.title}</a></article>`).join(""));
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const provider = await stub((hit) => ({ id: `overflow-${T}-${hit}`, billing: { charged: true, charged_usd: 0.005556 }, results: listing }));
config.allowPrivateNetworkFetch = true;
process.env.JINA_BASE_URL = base;
process.env.JINA_API_KEY = "test-key";
process.env.EVERYINFRA_BASE_URL = provider.url;
process.env.EVERYINFRA_API_KEY = "test-key";
let budgets: Array<{ service: string; per_minute: number; per_hour: number; per_day: number }> = [];
before(async () => {
  budgets = await sql`SELECT service, per_minute, per_hour, per_day FROM budgets WHERE service = 'jina' OR service LIKE 'everyinfra%'`;
  await sql`UPDATE budgets SET per_minute = 10000, per_hour = 10000, per_day = 100000 WHERE service = 'jina' OR service LIKE 'everyinfra%'`;
});
after(async () => {
  for (const b of budgets) await sql`UPDATE budgets SET per_minute = ${b.per_minute}, per_hour = ${b.per_hour}, per_day = ${b.per_day} WHERE service = ${b.service}`;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await provider.close();
  await stopBoss();
  await closeDb();
});

async function source(label: string, kind = "rss", cfg: Record<string, unknown> = {}, minutes = 360) {
  const id = `overflow-${label}-${T}`;
  const defaults = kind === "rss" ? { feedUrl: `${base}/${id}.xml` }
    : kind === "web_list" ? { url: `${base}/${id}.html`, itemSelector: "article", linkSelector: "a" }
    : { url: `${base}/${id}.json`, itemsPath: "items", titlePaths: ["title"], urlTemplate: "{raw:url}" };
  await sql`INSERT INTO sources (id, name, kind, config, interval_minutes, min_interval_minutes, next_fetch_at)
    VALUES (${id}, ${id}, ${kind}, ${sql.json({ ...defaults, ...cfg })}, ${minutes}, ${minutes}, '2100-01-01')`;
  return id;
}
const state = async (id: string) => (await sql`SELECT cursor, interval_minutes, min_interval_minutes,
  extract(epoch FROM next_fetch_at - last_ok_at) / 60 AS minutes FROM sources WHERE id = ${id}`)[0]!;
const detail = async (id: string) => (await sql`SELECT detail FROM fetch_runs WHERE source_id = ${id} ORDER BY id DESC LIMIT 1`)[0]!.detail;
function scheduled(s: Awaited<ReturnType<typeof state>>, minutes: number) {
  assert.ok(Math.abs(s.minutes - minutes) < 0.01, `expected ${minutes} minutes, got ${s.minutes}`);
}

for (const kind of ["rss", "web_list", "json_list"]) {
  test(`${kind}: first import is exempt, a wholly new page accelerates once, overlap resumes the configured cadence`, async () => {
    const id = await source(kind, kind);
    listing = entries(`${kind}-first`);
    assert.equal((await collectSource(id)).created, 6);
    let s = await state(id);
    scheduled(s, 360);
    assert.equal(s.cursor.overflowCount, undefined);
    assert.equal(s.cursor.listingKeys.length, 6);
    listing = entries(`${kind}-second`);
    const second = await collectSource(id);
    assert.deepEqual([second.status, second.found, second.created], ["ok", 6, 6]);
    s = await state(id);
    scheduled(s, 15);
    assert.equal(s.cursor.overflowCount, 1);
    assert.ok(Math.abs(Date.parse(s.cursor.overflowAt) - Date.now()) < 5000);
    assert.equal((await detail(id)).overflow, true);
    assert.deepEqual([s.interval_minutes, s.min_interval_minutes], [360, 360]);
    const overflowAt = s.cursor.overflowAt;
    listing = [...entries(`${kind}-third`, 5), { ...listing[0]!, title: "A revised study title" }];
    const third = await collectSource(id);
    assert.deepEqual([third.status, third.found, third.created, third.revised], ["ok", 6, 5, 1]);
    s = await state(id);
    scheduled(s, 360);
    assert.equal(s.cursor.overflowCount, 1);
    assert.equal(s.cursor.overflowAt, overflowAt);
    assert.equal((await detail(id))?.overflow, undefined);
    listing = entries(`${kind}-short`, 4);
    await collectSource(id);
    scheduled(await state(id), 360);
    listing = entries(`${kind}-again`, 5);
    await collectSource(id);
    s = await state(id);
    scheduled(s, 15);
    assert.equal(s.cursor.overflowCount, 2, "five entries suffice and the count accumulates");
  });

  test(`${kind}: an initialized source without listingKeys establishes a baseline before checking overflow`, async () => {
    const id = await source(`${kind}-baseline`, kind);
    await sql`UPDATE sources SET cursor = ${sql.json({ initializedAt: new Date().toISOString() })} WHERE id = ${id}`;
    listing = entries(`${kind}-baseline-first`);
    assert.equal((await collectSource(id)).created, 6);
    let s = await state(id);
    scheduled(s, 360);
    assert.equal(s.cursor.overflowCount, undefined);
    assert.equal(s.cursor.listingKeys.length, 6);
    listing = entries(`${kind}-baseline-next`);
    await collectSource(id);
    s = await state(id);
    scheduled(s, 15);
    assert.equal(s.cursor.overflowCount, 1);
  });
}

test("previous-page overlap before noise filtering and beyond the store cap prevents false overflow warnings", async () => {
  const id = await source("uncapped");
  listing = entries("uncapped-first");
  await collectSource(id);
  const known = listing[0]!;
  listing = [...entries("uncapped-next", 60), known];
  assert.equal((await collectSource(id)).created, 60);
  scheduled(await state(id), 360);
  assert.equal((await state(id)).cursor.overflowCount, undefined);
  await sql`UPDATE sources SET config = config || ${sql.json({ ingestNoiseFilter: { dropMarkersTitleOnly: ["blocked"] } })} WHERE id = ${id}`;
  listing = [...entries("filtered-next", 6), { ...known, title: "blocked entry" }];
  assert.equal((await collectSource(id)).created, 6);
  scheduled(await state(id), 360);
  assert.equal((await state(id)).cursor.overflowCount, undefined);
});

test("a wholly excluded page does not overflow when the same page is fetched again", async () => {
  const id = await source("all-excluded", "rss", { ingestNoiseFilter: { requireMarkers: ["eligible"] } });
  listing = entries("all-excluded");
  for (let run = 0; run < 2; run++) {
    const result = await collectSource(id);
    assert.deepEqual([result.status, result.found, result.created], ["ok", 6, 0]);
    scheduled(await state(id), 360);
    assert.equal((await state(id)).cursor.overflowCount, undefined);
    assert.equal((await detail(id))?.overflow, undefined);
  }
  assert.equal((await sql`SELECT 1 FROM articles WHERE source_id = ${id}`).length, 0);
  assert.equal((await state(id)).cursor.listingKeys.length, 6, "excluded candidates still form the source's listing baseline");
});

test("an article stored by another source cannot hide this source's listing overflow", async () => {
  const id = await source("own-page");
  listing = entries("own-page-first");
  await collectSource(id);
  const other = await source("other-page");
  listing = entries("other-page-first");
  assert.equal((await collectSource(other)).created, 6);
  const result = await collectSource(id);
  assert.deepEqual([result.status, result.found, result.created], ["ok", 6, 0]);
  const s = await state(id);
  scheduled(s, 15);
  assert.equal(s.cursor.overflowCount, 1);
});

test("listing memory is capped at 200 short hashes, while overlap checks use the complete current page", async () => {
  const id = await source("large-page");
  listing = entries("large-page-first", 210);
  const overlap = listing[199]!;
  assert.equal((await collectSource(id)).created, 30, "first import keeps its ordinary storage cap");
  const keys = (await state(id)).cursor.listingKeys;
  assert.equal(keys.length, 200);
  assert.equal(new Set(keys).size, 200);
  assert.ok(keys.every((key: string) => /^[a-f0-9]{12}$/.test(key)));
  listing = [...entries("large-page-next", 210), overlap];
  assert.equal((await collectSource(id)).created, 60);
  const s = await state(id);
  scheduled(s, 360);
  assert.equal(s.cursor.overflowCount, undefined, "overlap beyond both storage and current-page memory caps still counts");
  assert.equal(s.cursor.listingKeys.length, 200);
});

test("RSS 304, successful empty pages and failures preserve the last listing baseline", async () => {
  const id = await source("retained");
  listing = entries("retained-first");
  await collectSource(id);
  await collectSource(id); // The ordinary run saves the RSS validator after first import.
  const keys = (await state(id)).cursor.listingKeys;
  assert.equal(keys.length, 6);
  try {
    notModified = true;
    const cached = await collectSource(id);
    assert.deepEqual([cached.status, cached.found], ["ok", 0]);
    assert.equal((await detail(id)).httpStatus, 304);
    assert.deepEqual((await state(id)).cursor.listingKeys, keys);
    notModified = false;
    listing = [];
    const empty = await collectSource(id);
    assert.deepEqual([empty.status, empty.found], ["ok", 0]);
    assert.deepEqual((await state(id)).cursor.listingKeys, keys);
    broken = true;
    assert.equal((await collectSource(id)).status, "failed");
    assert.deepEqual((await state(id)).cursor.listingKeys, keys);
  } finally { notModified = false; broken = false; }
  listing = entries("retained-next");
  await collectSource(id);
  scheduled(await state(id), 15);
  assert.equal((await state(id)).cursor.overflowCount, 1);
});

test("overflow retries keep Jina's hourly floor and EveryInfra's paid interval floor", async () => {
  for (const [label, kind, cfg, floor] of [
    ["jina", "web_list", { url: `https://r.jina.ai/https://example.org/overflow-${T}/`, parseMode: "markdown" }, 60],
    ["paid", "json_list", { adapter: "everyinfra_xhs", everyinfraAction: "search", everyinfraParams: { keyword: T }, itemsPath: "" }, 720],
  ] as const) {
    const id = await source(label, kind, cfg, 1440);
    listing = entries(`${label}-old`);
    assert.equal((await collectSource(id)).status, "ok");
    scheduled(await state(id), 1440);
    if (label === "paid") {
      // A new logical request makes the local provider return the next page rather than replaying its receipt.
      await sql`UPDATE sources SET config = jsonb_set(config, '{everyinfraParams,keyword}', ${sql.json(`${T}-next`)}) WHERE id = ${id}`;
    }
    listing = entries(`${label}-new`);
    const result = await collectSource(id);
    assert.equal(result.status, "ok", result.error ?? "collection should succeed");
    assert.equal(result.found, 6);
    const s = await state(id);
    scheduled(s, floor);
    assert.equal(s.cursor.overflowCount, 1);
    assert.deepEqual([s.interval_minutes, s.min_interval_minutes], [1440, 1440]);
    assert.equal((await detail(id)).overflow, true);
  }
});
