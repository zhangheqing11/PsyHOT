// What agents read: the guide and Markdown answers under /api/v1/agent (external data fenced off,
// answer hints and the crisis line at the end, bad parameters refused), and the Agent Skill package:
// its files match their manifest, and the installer checks them, installs, updates in place, leaves
// another Skill's folder alone and gives Claude Code a link to the one copy.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { isApiOwned } from "@aihot/contracts/http-policy";
import { SKILL_FILES, SKILL_NAME, SKILL_PATH } from "@aihot/contracts/skill";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `test-agent-${T}`;
const DAILY_KEY = `2099-10-${String(10 + Math.floor(Math.random() * 19))}`;
const app = await buildApp();
const get = async (url: string) => {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.body, type: String(res.headers["content-type"] ?? ""), location: res.headers.location };
};

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test agent', 'rss', 'T1', 'editorial', '2100-01-01')`;
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/agent-${T}`, title: `Mindfulness ${T}`, bodyText: `Body ${T} `.repeat(40), bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  } as never);
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'clinical', ${`正念干预研究-${T}`}, '一项随机对照试验。', '样本量大', 85, true)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  const item = { itemId: articleId, title: `正念干预研究-${T}`, summary: "一项随机对照试验。", sourceName: "Test agent", sourceUrl: `https://example.com/agent-${T}`, sourceId: SOURCE, firstParty: false, role: null, storyPublicId: null, publishedAt: new Date().toISOString() };
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, model, origin)
            VALUES ('daily', ${DAILY_KEY}, now() - interval '1 day', now(), ${sql.json({ date: DAILY_KEY, lead: { title: `导语-${T}`, leadParagraph: "今天的研究。" }, highlights: [], sections: [{ label: "临床与干预", items: [item] }], flashes: [], metrics: {} } as never)}, now(), 'test', 'model')`;
});
after(async () => {
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key = ${DAILY_KEY}`;
  await app.close();
  await stopBoss();
  await closeDb();
});

test("the guide lists every ability; unknown parameters are refused", async () => {
  const guide = await get("/api/v1/agent");
  assert.equal(guide.status, 200);
  assert.match(guide.type, /text\/markdown/);
  for (const p of ["/api/v1/agent/latest", "/api/v1/agent/search?q=", "/api/v1/agent/hot", "/api/v1/agent/daily", "/api/v1/agent/weekly", "/api/v1/agent/monthly", "category=clinical", "12356"]) {
    assert.ok(guide.body.includes(p), `the guide mentions ${p}`);
  }
  assert.equal((await get("/api/v1/agent?x=1")).status, 400);
});

test("answers fence the external data and end with hints, the crisis line among them", async () => {
  const latest = await get("/api/v1/agent/latest?window=7d&category=clinical&limit=30");
  assert.equal(latest.status, 200);
  const start = latest.body.indexOf("不可信外部资料开始");
  const end = latest.body.indexOf("不可信外部资料结束");
  const title = latest.body.indexOf(`正念干预研究-${T}`);
  assert.ok(start > 0 && start < title && title < end, "the item sits inside the fence");
  assert.ok(latest.body.indexOf("## 回答提示") > end && latest.body.includes("12356"), "hints after the data, with the crisis line");
  assert.ok(latest.body.includes("推荐理由：样本量大"));

  const found = await get(`/api/v1/agent/search?q=${encodeURIComponent(`正念干预研究-${T}`)}`);
  assert.equal(found.status, 200);
  assert.ok(found.body.includes(`正念干预研究-${T}`));
  for (const bad of ["/api/v1/agent/latest?window=30d", "/api/v1/agent/latest?limit=31", "/api/v1/agent/search?q=x", "/api/v1/agent/daily/2026-02-30", "/api/v1/agent/weekly/2026-40"]) {
    assert.equal((await get(bad)).status, 400, bad);
  }
});

test("the daily of a date, and an honest 404 for a date without one", async () => {
  const daily = await get(`/api/v1/agent/daily/${DAILY_KEY}`);
  assert.equal(daily.status, 200);
  assert.ok(daily.body.includes(`导语：导语-${T}`) && daily.body.includes("【临床与干预】") && daily.body.includes(`正念干预研究-${T}`));
  const none = await get("/api/v1/agent/daily/2000-01-01");
  assert.equal(none.status, 404);
  assert.match(none.body, /没有 2000-01-01 的日报/);
});

test("the Skill package: the files match their manifest; the path belongs to the api", async () => {
  assert.equal((await get(SKILL_PATH)).location, `${SKILL_PATH}/README.md`);
  const readme = await get(`${SKILL_PATH}/README.md`);
  assert.equal(readme.status, 200);
  assert.ok(readme.body.includes(`${SKILL_PATH}/install.sh`));
  const manifest = (await get(`${SKILL_PATH}/manifest.sha256`)).body.trim().split("\n").map((l) => l.split(/\s+/));
  assert.deepEqual(manifest.map(([, f]) => f), [...SKILL_FILES]);
  for (const [hash, file] of manifest) {
    const served = await get(`${SKILL_PATH}/${file}`);
    assert.equal(createHash("sha256").update(served.body, "utf8").digest("hex"), hash, file);
  }
  const skill = (await get(`${SKILL_PATH}/SKILL.md`)).body;
  assert.match(skill, new RegExp(`^---\\nname: ${SKILL_NAME}\\n`));
  assert.ok(skill.includes("/api/v1/agent") && skill.includes("12356"));
  assert.equal((await get(`${SKILL_PATH}/../.env`)).status, 404);
  assert.ok(isApiOwned(`${SKILL_PATH}/SKILL.md`) && isApiOwned(SKILL_PATH) && !isApiOwned(`${SKILL_PATH}s`));
});

test("the installer checks the package, installs, updates in place and leaves another Skill alone", async () => {
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const work = mkdtempSync(path.join(tmpdir(), "skill-"));
  try {
    const script = path.join(work, "install.sh");
    writeFileSync(script, (await get(`${SKILL_PATH}/install.sh`)).body);
    execFileSync("bash", ["-n", script]);
    const home = path.join(work, "home");
    const env = { PATH: process.env.PATH!, HOME: home, [`${SKILL_NAME.toUpperCase()}_SKILL_BASE`]: `${address}${SKILL_PATH}`, NO_PROXY: "*" };
    // Asynchronous: the server answering the installer runs in this process.
    const run = (...args: string[]) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
      execFile("bash", [script, ...args], { env, encoding: "utf8", timeout: 30_000 }, (error, stdout, stderr) =>
        resolve({ status: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }));
    });

    assert.match((await run()).stdout, /用法/, "no arguments: help only");
    const first = await run("--target", "claude");
    assert.equal(first.status, 0, first.stderr);
    const dir = path.join(home, ".agents/skills", SKILL_NAME);
    for (const f of SKILL_FILES) assert.equal(readFileSync(path.join(dir, f), "utf8"), (await get(`${SKILL_PATH}/${f}`)).body);
    const link = path.join(home, ".claude/skills", SKILL_NAME);
    assert.ok(lstatSync(link).isSymbolicLink() && readlinkSync(link) === dir, "Claude Code gets a link to the one copy");
    assert.equal((await run("--target", "claude")).status, 0, "running again updates in place");

    const other = path.join(work, "other");
    mkdirSync(other);
    writeFileSync(path.join(other, "SKILL.md"), "---\nname: someone-else\n---\n");
    const refused = await run("--dir", other);
    assert.equal(refused.status, 3);
    assert.equal(readFileSync(path.join(other, "SKILL.md"), "utf8"), "---\nname: someone-else\n---\n", "another Skill is untouched");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
