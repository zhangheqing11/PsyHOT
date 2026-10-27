// Chinese readings for source abstracts. This is deliberately separate from full-text translation:
// it only reads article.excerpt, never body_html/body_text, and every model call still goes through
// the ordinary receipt and budget path. A page load only reads the stored row.
import { z } from "zod";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { sha256 } from "../lib/ids.ts";
import { looksZh, thinText } from "./writing.ts";
import { promptText, promptVersion } from "./prompts.ts";
import { ModelOutputError, chatJson } from "../providers/llm.ts";
import { modelFor } from "./models.ts";
import { BudgetExceededError, ReceiptBusyError, ReceiptUnknownError, completeReceipt } from "../providers/receipts.ts";
import { journalAbstractIssue } from "../content/journal-abstract.ts";

const SYSTEM = promptText("translate-abstract");
export const ABSTRACT_TRANSLATE_PROMPT_VERSION = promptVersion("translate-abstract");
const Output = z.object({ translation: z.string().trim().min(1).max(20_000) });
const MAX_ATTEMPTS = 3;

export type AbstractTranslationStatus = "pending" | "translated" | "failed" | "skipped";

export interface AbstractTranslationResult {
  articleId: string;
  revision: number;
  status: AbstractTranslationStatus;
  receiptId: number | null;
  reason?: string;
}

export interface AbstractCandidate {
  articleId: string;
  revision: number;
  excerpt: string;
  language: string | null;
  url: string;
  tags: string[];
  lookedUp: boolean;
  provider: string | null;
  doi: string | null;
  sourceHash: string;
  status: AbstractTranslationStatus | null;
  attempts: number;
  textZh: string | null;
  storedSourceHash: string | null;
}

/** A stable hash of exactly the source text sent to the model and shown on the detail page. */
export function abstractSourceHash(text: string): string {
  return sha256(text.trim());
}

/** Journal/preprint sources are the only source families eligible for the abstract reading layer. */
export function isAbstractCandidate(row: {
  excerpt: string | null | undefined;
  language?: string | null;
  tags?: string[] | null;
  lookedUp?: boolean;
  sourceKind?: string;
  xPost?: unknown;
}): boolean {
  const excerpt = row.excerpt?.trim() ?? "";
  if (!excerpt || thinText(excerpt) || row.xPost || row.sourceKind === "mp_account") return false;
  const tags = row.tags ?? [];
  if (!tags.includes("期刊") && !tags.includes("预印本")) return false;
  if (tags.includes("期刊") && journalAbstractIssue(excerpt, { identified: row.lookedUp })) return false;
  const language = row.language?.toLowerCase() ?? "";
  return language !== "zh" && !language.startsWith("zh-") && !looksZh(excerpt);
}

interface CandidateRow {
  article_id: string;
  revision: number;
  excerpt: string | null;
  language: string | null;
  url: string;
  tags: string[];
  looked_up: boolean;
  provider: string | null;
  doi: string | null;
  status: AbstractTranslationStatus | null;
  source_hash: string | null;
  attempts: number | null;
  text_zh: string | null;
}

async function loadCandidates(limit: number): Promise<AbstractCandidate[]> {
  const rows = await sql<CandidateRow[]>`
    SELECT a.id AS article_id, a.revision, a.excerpt, a.language, a.url, s.tags,
      (l.found_at IS NOT NULL) AS looked_up, l.provider, l.doi,
      t.status, t.source_hash, t.attempts, t.text_zh
    FROM articles a
    JOIN sources s ON s.id = a.source_id
    LEFT JOIN abstract_lookups l ON l.article_id = a.id
    LEFT JOIN abstract_translations t
      ON t.article_id = a.id AND t.revision = a.revision AND t.lang = 'zh'
    WHERE s.enabled AND s.participation_mode = 'editorial' AND s.kind <> 'mp_account' AND a.x_post IS NULL
      AND a.excerpt IS NOT NULL
      AND (s.tags @> ARRAY['期刊']::text[] OR s.tags @> ARRAY['预印本']::text[])
      AND a.discovered_at >= now() - make_interval(days => ${Math.max(1, config.abstractTranslationDays)})
    -- Keep fresh work ahead of already translated rows. The hash is checked in TypeScript because
    -- the database does not need a crypto extension, and a changed excerpt must still be admitted.
    ORDER BY (t.status IS NULL OR t.status IN ('pending', 'failed')) DESC, a.discovered_at DESC
    LIMIT ${Math.max(1, Math.min(limit * 3, 300))}`;
  return rows.flatMap((row) => {
    const excerpt = row.excerpt?.trim() ?? "";
    if (!isAbstractCandidate({ excerpt, language: row.language, tags: row.tags, lookedUp: row.looked_up })) return [];
    return [{
      articleId: row.article_id,
      revision: row.revision,
      excerpt,
      language: row.language,
      url: row.url,
      tags: row.tags,
      lookedUp: row.looked_up,
      provider: row.provider,
      doi: row.doi,
      sourceHash: abstractSourceHash(excerpt),
      status: row.status,
      attempts: Number(row.attempts ?? 0),
      textZh: row.text_zh,
      storedSourceHash: row.source_hash,
    } satisfies AbstractCandidate];
  });
}

function shouldSkip(row: AbstractCandidate): boolean {
  if (row.storedSourceHash !== row.sourceHash) return false;
  return (row.status === "translated" && !!row.textZh?.trim()) || row.status === "skipped" || row.attempts >= MAX_ATTEMPTS;
}

/**
 * Reserve the row before asking the provider. The attempt count is deliberately not incremented
 * here: chatJson can return immediately when the valve, credentials, or budget are unavailable,
 * and those conditions must not consume the three paid-attempt allowance.
 */
async function markPending(row: AbstractCandidate): Promise<void> {
  const attempts = row.storedSourceHash === row.sourceHash && row.status ? row.attempts : 0;
  await sql`
    INSERT INTO abstract_translations (article_id, revision, lang, source_hash, status, attempts, text_zh, last_error)
    VALUES (${row.articleId}, ${row.revision}, 'zh', ${row.sourceHash}, 'pending', ${attempts}, NULL, NULL)
    ON CONFLICT (article_id, revision, lang) DO UPDATE SET
      source_hash = EXCLUDED.source_hash, status = 'pending', attempts = EXCLUDED.attempts,
      text_zh = NULL, receipt_id = NULL, last_error = NULL, updated_at = now()`;
}

async function markFailure(row: AbstractCandidate, message: string, receiptId: number | null): Promise<void> {
  await sql`
    UPDATE abstract_translations
    SET status = 'failed', attempts = attempts + 1, receipt_id = coalesce(${receiptId}, receipt_id),
      last_error = ${message.slice(0, 1000)}, updated_at = now()
    WHERE article_id = ${row.articleId} AND revision = ${row.revision} AND lang = 'zh' AND source_hash = ${row.sourceHash}`;
}

async function markSkipped(row: AbstractCandidate, reason: string): Promise<void> {
  await sql`
    INSERT INTO abstract_translations (article_id, revision, lang, source_hash, status, attempts, text_zh, last_error)
    VALUES (${row.articleId}, ${row.revision}, 'zh', ${row.sourceHash}, 'skipped', 0, NULL, ${reason})
    ON CONFLICT (article_id, revision, lang) DO UPDATE SET source_hash = EXCLUDED.source_hash,
      status = 'skipped', attempts = 0, text_zh = NULL, receipt_id = NULL, last_error = EXCLUDED.last_error, updated_at = now()`;
}

/**
 * Translate recent eligible abstracts. A failed answer is retained for diagnosis and retried up to
 * three times; a changed source hash/revision gets a fresh row. The returned rows are for job logs.
 */
export async function translateAbstracts(opts: { limit?: number; budgetMs?: number } = {}): Promise<AbstractTranslationResult[]> {
  if (!config.abstractTranslationEnabled) return [];
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? 4 * 60_000;
  const results: AbstractTranslationResult[] = [];
  for (const row of await loadCandidates(opts.limit ?? 30)) {
    if (results.length >= (opts.limit ?? 30) || Date.now() - started >= budgetMs || shutdownSignal.signal.aborted) break;
    if (row.status && shouldSkip(row)) continue;
    if (row.language?.toLowerCase().startsWith("zh") || looksZh(row.excerpt)) {
      await markSkipped(row, "source abstract is already Chinese");
      results.push({ articleId: row.articleId, revision: row.revision, status: "skipped", receiptId: null, reason: "already Chinese" });
      continue;
    }
    if (row.attempts >= MAX_ATTEMPTS) continue;
    await markPending(row);
    let response: { data: z.infer<typeof Output>; receiptId: number };
    try {
      response = await chatJson({
        model: await modelFor("translate"),
        purpose: "translate_abstract",
        subject: `abstract:${row.articleId}:${row.revision}`,
        promptVersion: ABSTRACT_TRANSLATE_PROMPT_VERSION,
        system: SYSTEM,
        user: JSON.stringify({ abstract: row.excerpt }),
        schema: Output,
        temperature: 0.2,
        maxTokens: Math.min(8_000, Math.ceil(row.excerpt.length * 1.6) + 256),
        timeoutMs: 120_000,
      });
    } catch (error) {
      const message = String(error);
      // These outcomes did not produce a usable answer for this row. A valve/configuration/budget
      // stop, an in-flight duplicate, and an unknown receipt must leave the row pending so the next
      // scheduled run can resume it without consuming an abstract attempt.
      if (error instanceof BudgetExceededError || error instanceof ReceiptBusyError || error instanceof ReceiptUnknownError || /disabled|not configured|budget/i.test(message)) break;
      const receiptId = error instanceof ModelOutputError ? error.receiptId : null;
      await markFailure(row, message, receiptId);
      results.push({ articleId: row.articleId, revision: row.revision, status: "failed", receiptId, reason: message.slice(0, 300) });
      continue;
    }
    const translated = response.data.translation.trim();
    await sql`
      UPDATE abstract_translations
      SET status = 'translated', attempts = attempts + 1, text_zh = ${translated}, receipt_id = ${response.receiptId}, last_error = NULL, updated_at = now()
      WHERE article_id = ${row.articleId} AND revision = ${row.revision} AND lang = 'zh' AND source_hash = ${row.sourceHash}`;
    await completeReceipt(sql, response.receiptId);
    results.push({ articleId: row.articleId, revision: row.revision, status: "translated", receiptId: response.receiptId });
  }
  return results;
}
