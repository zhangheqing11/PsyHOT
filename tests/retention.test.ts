import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { dailyRetention } from "@aihot/backend/operations/retention";

const T = tag();
config.dataDir = await mkdtemp(path.join(tmpdir(), "aihot-retention-"));
const confirmSendIds: number[] = [];
after(async () => {
  await sql`DELETE FROM feedback WHERE source_hash = ${T}`;
  if (confirmSendIds.length) await sql`DELETE FROM subscription_confirm_sends WHERE id IN ${sql(confirmSendIds)}`;
  await closeDb();
  await rm(config.dataDir, { recursive: true });
});

test("daily retention accepts a missing screenshot directory", async () => {
  const result = await dailyRetention();
  assert.equal(result.deletedFeedbackScreenshots, 0);
});

test("daily retention expires old screenshots and their references, keeping recent files", async () => {
  const dir = path.join(config.dataDir, "feedback-screenshots");
  await mkdir(dir);
  const now = new Date();
  const old = new Date(now.getTime() - 31 * 86400_000);
  for (const name of ["expired.png", "orphan.png", "recent.png"]) await writeFile(path.join(dir, name), name);
  for (const name of ["expired.png", "orphan.png"]) await utimes(path.join(dir, name), old, old);
  await sql`INSERT INTO feedback (content, source_hash, screenshot_key) VALUES
    ('旧截图一', ${T}, 'local:expired.png'), ('旧截图二', ${T}, 'local:expired.png'), ('新截图', ${T}, 'local:recent.png')`;

  const result = await dailyRetention(now);
  assert.equal(result.deletedFeedbackScreenshots, 2, "orphan files also consume storage and must expire");
  assert.deepEqual(await readdir(dir), ["recent.png"]);
  assert.equal(await readFile(path.join(dir, "recent.png"), "utf8"), "recent.png");
  const rows = await sql<{ screenshot_key: string }[]>`SELECT screenshot_key FROM feedback WHERE source_hash = ${T} ORDER BY id`;
  assert.deepEqual(rows.map((r) => r.screenshot_key), ["gone:expired", "gone:expired", "local:recent.png"]);
});

test("daily retention removes confirmation send attempts older than thirty days", async () => {
  const now = new Date();
  const rows = await sql<{ id: number }[]>`INSERT INTO subscription_confirm_sends (sent_at) VALUES
    (${new Date(now.getTime() - 31 * 86400_000)}), (${new Date(now.getTime() - 29 * 86400_000)}), (${now}) RETURNING id`;
  confirmSendIds.push(...rows.map((r) => r.id));
  const result = await dailyRetention(now);
  assert.equal(result.deletedConfirmationSends, 1);
  const kept = await sql<{ id: number }[]>`SELECT id FROM subscription_confirm_sends WHERE id IN ${sql(confirmSendIds)} ORDER BY id`;
  assert.deepEqual(kept.map((r) => r.id), [rows[1]!.id, rows[2]!.id]);
});
