// Feedback: content, optional email, page URL, one optional screenshot. The screenshot
// is kept locally within a size and age limit until forwarded to the internal Feishu chat. Abuse control
// uses an unreadable source identifier (HMAC of client IP + UA family), per-source bans and a per-minute limit.
import { createHmac } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { feishuInternalEnabled, forwardFeedbackToFeishu } from "../notify/feishu.ts";

export const SCREENSHOT_DIR_MAX_BYTES = 512 * 1024 * 1024;
export const SCREENSHOT_KEEP_DAYS = 30;

export class FeedbackRejected extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function feedbackSourceHash(ip: string, userAgent: string): string {
  const secret = credential("auth", "SESSION_SECRET") ?? "dev-feedback-secret";
  const uaFamily = (userAgent.match(/(Chrome|Safari|Firefox|Edg|MicroMessenger|Mobile|Android|iPhone|iPad|Mac OS X|Windows)/g) ?? []).slice(0, 4).join("/");
  return createHmac("sha256", secret).update(`${ip}|${uaFamily}`).digest("base64url").slice(0, 24);
}

const recent = new Map<string, number[]>();
function rateLimit(source: string, perMinute = 5): void {
  const now = Date.now();
  const list = (recent.get(source) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= perMinute) throw new FeedbackRejected(429, "rate_limited", "提交太频繁，请稍后再试。", 60);
  list.push(now);
  recent.set(source, list);
  if (recent.size > 5000) for (const [k, v] of recent) if (v.every((t) => now - t > 60_000)) recent.delete(k);
}

export interface FeedbackInput {
  content: string;
  email?: string | null;
  pageUrl?: string | null;
  screenshot?: { mime: string; data: Buffer } | null;
  ip: string;
  userAgent: string;
}

/** Called under the directory's advisory lock, shared by submissions and retention. */
async function saveScreenshot(screenshot: NonNullable<FeedbackInput["screenshot"]>, maxBytes: number): Promise<string> {
  const name = `${sha256(screenshot.data).slice(0, 24)}.${screenshot.mime.split("/")[1]}`;
  const dir = path.join(config.dataDir, "feedback-screenshots");
  const file = path.join(dir, name);
  let writing = false;
  try {
    const entries = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    let bytes = 0;
    for (const entry of entries) {
      const info = await stat(path.join(dir, entry)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null; // Feishu may have removed an uploaded file.
        throw error;
      });
      if (info?.isFile()) bytes += info.size;
    }
    if (bytes + screenshot.data.length > maxBytes) {
      console.warn("[feedback] screenshot not saved: storage quota exceeded");
      return "gone:quota";
    }
    await mkdir(dir, { recursive: true });
    writing = true;
    await writeFile(file, screenshot.data);
    return `local:${name}`;
  } catch (error) {
    // Disk and permission errors must not discard the text or leave a partial screenshot behind.
    if (writing) await unlink(file).catch(() => {});
    const code = (error as NodeJS.ErrnoException).code;
    console.warn("[feedback] screenshot not saved", code ?? "io_error");
    return code === "ENOSPC" || code === "EDQUOT" ? "gone:quota" : "gone:missing";
  }
}

export async function submitFeedback(input: FeedbackInput, screenshotMaxBytes = SCREENSHOT_DIR_MAX_BYTES): Promise<{ id: number }> {
  const content = input.content.trim();
  if (content.length < 2) throw new FeedbackRejected(400, "invalid_request", "请写下反馈内容。");
  if (content.length > 5000) throw new FeedbackRejected(400, "invalid_request", "反馈内容最多 5000 字。");
  const email = input.email?.trim() || null;
  if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new FeedbackRejected(400, "invalid_request", "邮箱格式不正确。");
  const pageUrl = input.pageUrl?.trim().slice(0, 500) || null;
  const source = feedbackSourceHash(input.ip, input.userAgent);
  const [banned] = await sql`SELECT 1 FROM feedback_bans WHERE source_hash = ${source}`;
  if (banned) throw new FeedbackRejected(403, "forbidden", "暂时无法提交反馈。");
  rateLimit(source);

  if (input.screenshot) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(input.screenshot.mime)) throw new FeedbackRejected(400, "invalid_request", "截图需要是 PNG、JPG、WebP 或 GIF。");
    if (input.screenshot.data.length > 8 * 1024 * 1024) throw new FeedbackRejected(400, "invalid_request", "截图最大 8MB。");
  }
  const [row] = await sql.begin(async (tx) => {
    let screenshotKey: string | null = null;
    if (input.screenshot) {
      // Check and write together, including across API processes that share the data volume.
      await tx`SELECT pg_advisory_xact_lock(hashtext('feedback_screenshots'))`;
      screenshotKey = await saveScreenshot(input.screenshot, screenshotMaxBytes);
    }
    return tx<{ id: number }[]>`
      INSERT INTO feedback (content, email, page_url, screenshot_key, source_hash, forward_error)
      VALUES (${content}, ${email}, ${pageUrl}, ${screenshotKey}, ${source}, 'pending') RETURNING id`;
  });
  const id = row!.id;
  void forwardFeedbackToFeishu(id).catch(() => {});
  return { id };
}

/**
 * Every few minutes: feedback that did not reach the internal chat (Feishu down, a screenshot upload
 * failing) is tried again for a week. Newer than a few minutes is still being sent by its submission.
 */
export async function forwardPendingFeedback(): Promise<{ sent: number; failed: number }> {
  if (!feishuInternalEnabled()) return { sent: 0, failed: 0 };
  const rows = await sql<{ id: number }[]>`
    SELECT id FROM feedback WHERE forwarded_at IS NULL AND forward_error IS NOT NULL
      AND created_at < now() - interval '5 minutes' AND created_at > now() - interval '7 days'
    ORDER BY id LIMIT 20`;
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      if ((await forwardFeedbackToFeishu(r.id)) === "sent") sent += 1;
    } catch {
      failed += 1;
    }
  }
  return { sent, failed };
}
