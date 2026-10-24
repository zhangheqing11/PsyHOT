// Full probe CLI against a fresh *_test / *_ci database and local EveryInfra stub only.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";

const T = tag();
const dir = await mkdtemp(join(tmpdir(), "x-story-probe-"));
const provider = await stub((hit, req) => {
  const { params } = JSON.parse(req.body);
  const text = params.keyword.split(" since:")[0].replace(/^url:/, "https://").replace(/^"|"$/g, "");
  return { id: `probe-${T}-${hit}`, billing: { charged_usd: 0.000556 }, results: [
    { id: String(hit), url: `https://x.com/research/status/${hit}`, text, posted_at: new Date(Date.now() - 3600_000).toISOString() },
    { id: String(hit + 100), url: `https://x.com/research/status/${hit + 100}`, text: "A different paper", posted_at: new Date(Date.now() - 3600_000).toISOString() },
  ] };
});
const cli = async (...args: string[]) => promisify(execFile)(process.execPath, ["scripts/probe-x-story-lookup.ts", ...args], {
  env: { ...process.env, EVERYINFRA_BASE_URL: provider.url, EVERYINFRA_API_KEY: "test-key", ALLOW_PRIVATE_NETWORK_FETCH: "true",
    COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false" }, timeout: 30_000,
});
after(async () => { await provider.close(); await closeDb(); await rm(dir, { recursive: true, force: true }); });

test("probe CLI samples reports read-only, reuses paid receipts, and respects budgets and the lifetime cap", async () => {
  const budgets = await sql`SELECT * FROM budgets WHERE service IN ('everyinfra', 'everyinfra:twitter')`;
  await sql`UPDATE budgets SET per_minute = 10000, per_hour = 10000, per_day = 10000 WHERE service IN ('everyinfra', 'everyinfra:twitter')`;
  try {
    const sourceId = `x-probe-paper-${T}`;
    await sql`INSERT INTO sources (id, name, kind, tier, participation_mode) VALUES (${sourceId}, 'Probe paper', 'external', 'T1', 'editorial')`;
    const { articleId } = await upsertMaterial({ sourceId, url: `https://doi.org/10.1000/probe-${T}`,
      title: "Sleep changes emotional memory processing across human adolescence", bodyText: "An abstract with enough context.", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
      VALUES (${articleId}, 1, 'rule', 'pass', 'research', '睡眠与记忆', '摘要', 80, false, '{}'::jsonb)`;
    await publishArticle(articleId);
    const [story] = await sql`INSERT INTO stories (public_id, title, latest_at) VALUES (${randomUUID()}, 'Probe story', now()) RETURNING id`;
    const [fact] = await sql`INSERT INTO facts (public_id, story_id, title) VALUES (${`probe-${T}`}, ${story!.id}, 'Probe fact') RETURNING id`;
    await sql`INSERT INTO fact_articles (fact_id, article_id) VALUES (${fact!.id}, ${articleId})`;
    await sql`INSERT INTO hot_rankings (rule_version, entries) VALUES ('test-x-probe', ${sql.json([{ storyId: story!.id, rank: 1, track: 'combined' }])})`;
    const counts = async () => (await sql`SELECT (SELECT count(*) FROM articles) AS articles, (SELECT count(*) FROM story_signals) AS signals,
      (SELECT count(*) FROM processing_state) AS processing, (SELECT count(*) FROM analyses) AS analyses`)[0];
    const before = await counts();
    const path = join(dir, "plan.json");
    await cli("--plan", path);
    assert.equal(provider.hits(), 0, "plan creation makes no paid calls");
    const plan = JSON.parse(await readFile(path, "utf8"));
    assert.equal(plan.stories.length, 1);
    assert.equal(plan.stories[0].reports[0].id, articleId);
    await cli("--plan", path, "--run");
    assert.equal(provider.hits(), 3);
    const report = JSON.parse(await readFile(`${path}.results.json`, "utf8"));
    assert.ok(report.results.every((r: { received: number; matched: number }) => r.received === 2 && r.matched === 1));
    const attempts = await sql`SELECT ra.pool FROM receipt_attempts ra JOIN receipts r ON r.id = ra.receipt_id WHERE r.subject = ${`x-probe:${report.planId}`}`;
    assert.equal(attempts.length, 3);
    assert.ok(attempts.every((r) => r.pool === "everyinfra:twitter"));
    await cli("--plan", path, "--run");
    assert.equal(provider.hits(), 3, "recovery reuses all three responses");
    const replayed = JSON.parse(await readFile(`${path}.results.json`, "utf8"));
    assert.ok(replayed.results.every((r: { reused: boolean; newCostUsd: number }) => r.reused && r.newCostUsd === 0));
    assert.deepEqual(await counts(), before, "no materials, signals, analyses or processing work created");

    // Different frozen plan: no cached answers, pool stopped. It must finish cleanly without a request.
    const stoppedPath = join(dir, "stopped.json");
    await cli("--plan", stoppedPath);
    await sql`UPDATE budgets SET per_day = 0 WHERE service = 'everyinfra:twitter'`;
    await cli("--plan", stoppedPath, "--run");
    assert.equal(JSON.parse(await readFile(`${stoppedPath}.results.json`, "utf8")).state.stopped, "budget");
    assert.equal(provider.hits(), 3);
    await sql`UPDATE budgets SET per_day = 10000 WHERE service = 'everyinfra:twitter'`;

    const capPath = join(dir, "cap.json");
    await cli("--plan", capPath);
    const capPlan = JSON.parse(await readFile(capPath, "utf8"));
    const capSubject = `x-probe:${createHash('sha256').update(JSON.stringify(capPlan)).digest('hex').slice(0, 24)}`;
    const [receipt] = await sql`INSERT INTO receipts (logical_key, service, purpose, subject, status, attempts)
      VALUES (${`x-probe-cap-${T}`}, 'everyinfra', 'x_story_probe', ${capSubject}, 'unknown', 30) RETURNING id`;
    await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, pool, status)
      SELECT ${receipt!.id}, n, 'everyinfra', 'everyinfra:twitter', 'unknown' FROM generate_series(1, 30) n`;
    await cli("--plan", capPath, "--run");
    assert.equal(JSON.parse(await readFile(`${capPath}.results.json`, "utf8")).state.stopped, "budget");
    assert.equal(provider.hits(), 3, "thirty existing attempts prevent a 31st call");
  } finally {
    for (const b of budgets) await sql`UPDATE budgets SET per_minute = ${b.per_minute}, per_hour = ${b.per_hour}, per_day = ${b.per_day} WHERE service = ${b.service}`;
  }
});
