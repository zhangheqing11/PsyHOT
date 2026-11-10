// Daily housekeeping: expired leases, old run history, files past their life and derived caches.
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { SCREENSHOT_KEEP_DAYS } from "./feedback.ts";

/** Derived caches (proxied images, share cards and posters) are rebuilt on demand; drop ones older than a month. */
async function pruneCache(dir: string, maxAgeMs: number, now: number): Promise<number> {
  let removed = 0;
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      const info = await stat(p).catch(() => null);
      if (info && now - info.mtimeMs > maxAgeMs) {
        await unlink(p).catch(() => {});
        removed += 1;
      }
    }
  };
  await walk(dir);
  return removed;
}

async function pruneFeedbackScreenshots(now: number): Promise<number> {
  return sql.begin(async (tx) => {
    // Submissions cannot rewrite an old file between its age check and deletion.
    await tx`SELECT pg_advisory_xact_lock(hashtext('feedback_screenshots'))`;
    const dir = path.join(config.dataDir, "feedback-screenshots");
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = path.join(dir, entry.name);
      const info = await stat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!info || now - info.mtimeMs <= SCREENSHOT_KEEP_DAYS * 86400_000) continue;
      try {
        await unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await tx`UPDATE feedback SET screenshot_key = 'gone:expired' WHERE screenshot_key = ${`local:${entry.name}`}`;
      removed += 1;
    }
    return removed;
  });
}

export async function dailyRetention(now = new Date()) {
  const leases = await sql`DELETE FROM delivery_leases WHERE expires_at < ${now}`;
  // Scheduled-task history: 30 days (failures 90) is enough for the runs view.
  const runs = await sql`DELETE FROM job_runs WHERE started_at < ${new Date(now.getTime() - 30 * 86400_000)} AND (status IS DISTINCT FROM 'failed' OR started_at < ${new Date(now.getTime() - 90 * 86400_000)})`;
  // Raw files with a bounded life.
  const files = await sql<{ key: string }[]>`DELETE FROM stored_files WHERE expires_at < ${now} RETURNING key`;
  for (const f of files) await unlink(path.join(config.dataDir, f.key)).catch(() => {});
  const monthMs = 30 * 86400_000;
  const confirmationSends = await sql`DELETE FROM subscription_confirm_sends WHERE sent_at < ${new Date(now.getTime() - monthMs)}`;
  const deletedFeedbackScreenshots = await pruneFeedbackScreenshots(now.getTime());
  const prunedCache = (await pruneCache(path.join(config.dataDir, "imgcache"), monthMs, now.getTime())) + (await pruneCache(path.join(config.dataDir, "ogcache"), monthMs, now.getTime()));
  return { deletedLeases: leases.count, deletedJobRuns: runs.count, deletedFiles: files.length, deletedConfirmationSends: confirmationSends.count, deletedFeedbackScreenshots, prunedCache };
}
