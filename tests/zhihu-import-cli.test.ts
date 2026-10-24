import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sql, closeDb } from "@aihot/backend/db";
import { REPO_ROOT } from "@aihot/backend/config";

const exec = promisify(execFile);
const creator = createHash("sha256").update(tag()).digest("hex").slice(0, 16);
const contentId = String(Date.now());
const record = { content_id: contentId, content_type: "article", content_url: `https://zhuanlan.zhihu.com/p/${contentId}`, title: "研究讨论", creator_hash: creator, created_time: Math.floor(Date.now() / 1000), updated_time: 10 };
after(closeDb);

test("CLI previews repeated rows without losing citations and imports into the same DB as its signal registration", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "zhihu-cli-"));
  try {
    const input = path.join(dir, "contents.jsonl");
    const output = path.join(dir, "preview.json");
    const full = { ...record, content_text: "完整论文讨论。".repeat(30), content_links: ["https://doi.org/10.9999/example"] };
    const snippet = { ...record, content_text: "论文讨论" };
    const run = (extra: string[] = []) => exec(process.execPath, ["scripts/import-zhihu.ts", "--input", input, "--output", output, ...extra], { cwd: REPO_ROOT, env: { ...process.env, MODEL_CALLS_ENABLED: "false", COLLECT_ENABLED: "false" }, timeout: 15_000 });
    await writeFile(input, [full, snippet].map((r) => JSON.stringify(r)).join("\n"));
    await run();
    const first = JSON.parse(await readFile(output, "utf8"));
    await writeFile(input, [snippet, full].map((r) => JSON.stringify(r)).join("\n"));
    await run();
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), first);
    assert.ok(first[0].items[0].bodyText.includes("https://doi.org/10.9999/example"));
    const imported = await run(["--import"]);
    assert.ok(imported.stdout.includes('"created":1'));
    const [source] = await sql`SELECT participation_mode, site_fulltext, syndicate_fulltext FROM sources WHERE id = ${`mc-zhihu-${creator}`}`;
    assert.deepEqual([source.participation_mode, source.site_fulltext, source.syndicate_fulltext], ["hot_signal", false, false]);
    const [article] = await sql`SELECT id, body_text, revision FROM articles WHERE source_id = ${`mc-zhihu-${creator}`}`;
    assert.ok(article.body_text.includes("https://doi.org/10.9999/example"));
    assert.equal(article.revision, 1);
    const [job] = await sql`SELECT name, data FROM pgboss.job WHERE singleton_key = ${article.id} ORDER BY created_on DESC LIMIT 1`;
    assert.deepEqual([job.name, job.data.signalOnly], ["events.group", true]);
    assert.ok((await run(["--import"])).stdout.includes('"created":0'), "replay is idempotent");
    await assert.rejects(run(["--send", "https://example.com"]), "remote registration and sending cannot diverge");
    const answer = { ...record, content_type: "answer", question_id: "123", content_url: `https://www.zhihu.com/question/123/answer/${record.content_id}`, content_text: "对论文的讨论" };
    const changedQuestion = { ...answer, question_id: "999", content_url: `https://www.zhihu.com/question/999/answer/${record.content_id}` };
    await writeFile(input, [answer, changedQuestion].map((r) => JSON.stringify(r)).join("\n"));
    await assert.rejects(run(), /Conflicting Zhihu content identity/, "same answer id cannot acquire two URLs in one batch");
    await writeFile(input, JSON.stringify(answer));
    await run(["--import"]);
    await writeFile(input, JSON.stringify(changedQuestion));
    await assert.rejects(run(["--import"]), /Conflicting stored Zhihu content identity/, "stored answer identities survive subsequent exports");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
