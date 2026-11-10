import "./setup.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { submitFeedback } from "@aihot/backend/operations/feedback";
import { buildApp } from "../apps/api/src/app.ts";

process.env.FEISHU_INTERNAL_ENABLED = "false";
config.dataDir = await mkdtemp(path.join(tmpdir(), "aihot-upload-"));
const app = await buildApp();
after(async () => { await app.close(); await closeDb(); await rm(config.dataDir, { recursive: true }); });

async function upload(file: Buffer, ip: string) {
  const form = new FormData();
  form.set("content", "手机截图反馈，文字保持不变");
  form.set("email", "reader@example.com");
  form.set("pageUrl", "/daily");
  form.set("screenshot", new File([new Uint8Array(file)], "screenshot.png", { type: "image/png" }));
  const request = new Request("http://local/api/site/feedback", { method: "POST", body: form });
  const payload = Buffer.from(await request.arrayBuffer());
  return app.inject({ method: "POST", url: "/api/site/feedback", headers: { "content-type": request.headers.get("content-type")!, "x-real-ip": ip }, payload });
}

test("a 5 MiB multipart screenshot waits intact for forwarding", async () => {
  const file = Buffer.alloc(5 * 1024 * 1024, 137);
  const result = await upload(file, "203.0.113.211");
  assert.equal(result.statusCode, 201, result.body);
  assert.equal(result.headers["cache-control"], "no-store");
  const [row] = await sql`SELECT content,email,page_url,screenshot_key,forward_error FROM feedback WHERE id = ${result.json().id}`;
  assert.equal(row!.content, "手机截图反馈，文字保持不变");
  assert.equal(row!.email, "reader@example.com");
  assert.equal(row!.page_url, "/daily");
  assert.equal(row!.forward_error, "pending");
  assert.deepEqual(await readFile(path.join(config.dataDir, "feedback-screenshots", row!.screenshot_key.slice(6))), file);
});

test("malformed multipart and screenshots above the existing backend limit are rejected", async () => {
  const bad = await app.inject({ method: "POST", url: "/api/site/feedback", headers: { "content-type": "multipart/form-data; boundary=missing" }, payload: Buffer.from("bad") });
  assert.equal(bad.statusCode, 400);
  const result = await upload(Buffer.alloc(8 * 1024 * 1024 + 1), "203.0.113.212");
  assert.equal(result.statusCode, 400);
  assert.match(result.json().detail, /8MB/);
});

test("the JSON screenshot sent by an already-open tab remains accepted", async () => {
  const file = Buffer.from("existing screenshot");
  const result = await app.inject({ method: "POST", url: "/api/site/feedback", headers: { "x-real-ip": "203.0.113.213" }, payload: { content: "旧标签页", screenshot: { mime: "image/png", data: file.toString("base64") } } });
  assert.equal(result.statusCode, 201);
  const [row] = await sql`SELECT screenshot_key FROM feedback WHERE id = ${result.json().id}`;
  assert.deepEqual(await readFile(path.join(config.dataDir, "feedback-screenshots", row!.screenshot_key.slice(6))), file);
});

const screenshotBytes = async () => {
  const dir = path.join(config.dataDir, "feedback-screenshots");
  const files = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return (await Promise.all(files.map((name) => stat(path.join(dir, name))))).reduce((sum, info) => sum + info.size, 0);
};

test("a full screenshot directory keeps the feedback text without writing a new file", async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
  const dir = path.join(config.dataDir, "feedback-screenshots");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "existing-quota-screenshot.png"), Buffer.alloc(32));
  const before = await readdir(dir);
  const data = Buffer.from("screenshot over the remaining quota");
  const { id } = await submitFeedback({
    content: "配额不足时仍然保存的反馈文字", email: "quota@example.com", pageUrl: "/daily",
    screenshot: { mime: "image/png", data }, ip: "203.0.113.214", userAgent: "test",
  }, await screenshotBytes() + data.length - 1);
  const [row] = await sql`SELECT content, email, page_url, screenshot_key FROM feedback WHERE id = ${id}`;
  assert.equal(row!.screenshot_key, "gone:quota");
  assert.equal(row!.content, "配额不足时仍然保存的反馈文字");
  assert.equal(row!.email, "quota@example.com");
  assert.equal(row!.page_url, "/daily");
  assert.deepEqual(await readdir(dir), before);
  assert.equal(warnings.length, 1);
  assert.ok(!JSON.stringify(warnings).includes(row!.content), "the warning contains no feedback text");
});

test("concurrent screenshot submissions share the directory allowance", async () => {
  const data = Array.from({ length: 5 }, (_, i) => Buffer.from(`concurrent screenshot ${i}`));
  const maxBytes = await screenshotBytes() + data[0]!.length;
  const submissions = await Promise.all(data.map((file, i) => submitFeedback({
    content: `并发截图 ${i}`, screenshot: { mime: "image/png", data: file },
    ip: `203.0.113.${220 + i}`, userAgent: "test",
  }, maxBytes)));
  const rows = await sql<{ screenshot_key: string }[]>`SELECT screenshot_key FROM feedback WHERE id IN ${sql(submissions.map((s) => s.id))}`;
  assert.equal(rows.filter((r) => r.screenshot_key.startsWith("local:")).length, 1);
  assert.equal(rows.filter((r) => r.screenshot_key === "gone:quota").length, 4);
  assert.ok(await screenshotBytes() <= maxBytes);
});

test("unavailable screenshot storage still accepts the feedback text", async (t) => {
  t.mock.method(console, "warn", () => {});
  const original = config.dataDir;
  const blocked = await mkdtemp(path.join(tmpdir(), "aihot-blocked-upload-"));
  await writeFile(path.join(blocked, "feedback-screenshots"), "not a directory");
  config.dataDir = blocked;
  try {
    const { id } = await submitFeedback({
      content: "存储异常时也保存的反馈文字", screenshot: { mime: "image/png", data: Buffer.from("cannot be stored") },
      ip: "203.0.113.225", userAgent: "test",
    });
    const [row] = await sql`SELECT content, screenshot_key FROM feedback WHERE id = ${id}`;
    assert.equal(row!.content, "存储异常时也保存的反馈文字");
    assert.equal(row!.screenshot_key, "gone:missing");
    assert.equal(await readFile(path.join(blocked, "feedback-screenshots"), "utf8"), "not a directory");
  } finally {
    config.dataDir = original;
    await rm(blocked, { recursive: true });
  }
});
