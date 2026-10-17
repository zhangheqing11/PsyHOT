// The site owner's labels for calibrating the selection (docs/selection.md): 该选 / 不该选 / 两可 on real
// items, from the item's admin page or the labelling queue. The queue is filled by a first sample
// (scripts/sample-labels.ts) and a weekly review batch (promotions, prefilter blocks, scores near the
// threshold); the labels export as the gold file scripts/eval-selection.ts and SelectBench read.
import { z } from "zod";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { sql } from "../db.ts";
import { audit } from "./auth.ts";

export const LABEL_QUEUES = ["sample", "promotion", "blocked", "near_threshold", "manual"] as const;
export type LabelQueue = (typeof LABEL_QUEUES)[number];

const INDUSTRY_CATEGORIES = CATEGORIES.filter((c) => c.track === "industry").map((c) => c.key);

/** Each article's latest judgement. */
const LATEST = sql`LEFT JOIN LATERAL (
    SELECT x.relevance, x.category, x.score, x.selected, x.title_zh, x.summary_zh, x.output FROM analyses x
    WHERE x.article_id = a.id ORDER BY x.input_revision DESC, x.id DESC LIMIT 1) an ON true`;

/**
 * The item's side: its category's track, else its source's. A blocked item of a mixed source has
 * neither (null).
 */
const TRACK = sql`CASE WHEN an.category = ANY(${INDUSTRY_CATEGORIES}::text[]) THEN 'industry' WHEN an.category IS NOT NULL THEN 'academic'
  WHEN s.track <> 'mixed' THEN s.track END`;

/** One item in five goes to the holdout split, by its id (stable across runs). */
const SPLIT = sql`CASE WHEN ('x' || substr(md5(a.id), 1, 8))::bit(32)::int % 5 = 0 THEN 'holdout' ELSE 'development' END`;

export interface LabelCandidate {
  id: string;
  track: "academic" | "industry" | null;
  score: number | null;
  threshold: number | null;
  selected: boolean;
  promotion: boolean;
  relevance: string | null;
}

/**
 * Analysed items of editorial sources discovered in [since, until) that are not queued yet, in a stable
 * pseudo-random order (by id), for sampling.
 */
export async function labelCandidates(since: Date, until: Date): Promise<LabelCandidate[]> {
  const rows = await sql<(Omit<LabelCandidate, "score" | "threshold"> & { score: string | null; threshold: string | null })[]>`
    SELECT a.id, ${TRACK} AS track, an.score, (an.output->>'threshold')::numeric AS threshold, coalesce(an.selected, false) AS selected,
           coalesce((an.output->>'promotion')::boolean, false) AS promotion, an.relevance
    FROM articles a JOIN sources s ON s.id = a.source_id ${LATEST}
    WHERE s.participation_mode = 'editorial' AND an.relevance IS NOT NULL
      AND a.discovered_at >= ${since} AND a.discovered_at < ${until}
      AND NOT EXISTS (SELECT 1 FROM selection_labels l WHERE l.article_id = a.id)
    ORDER BY md5(a.id)`;
  return rows.map((r) => ({ ...r, score: r.score === null ? null : Number(r.score), threshold: r.threshold === null ? null : Number(r.threshold) }));
}

/** How far a score may be from its threshold to count as near it. */
export const NEAR_THRESHOLD = 5;
export const isNear = (c: Pick<LabelCandidate, "score" | "threshold">, within = NEAR_THRESHOLD) =>
  c.score !== null && c.threshold !== null && Math.abs(c.score - c.threshold) <= within;

/** Queues items for labelling; already queued or labelled ones are left as they are. */
export async function queueForLabel(items: Array<{ id: string; queue: LabelQueue }>): Promise<number> {
  let added = 0;
  for (const it of items) {
    const rows = await sql`
      INSERT INTO selection_labels (article_id, queue, split) SELECT a.id, ${it.queue}, ${SPLIT} FROM articles a WHERE a.id = ${it.id}
      ON CONFLICT (article_id) DO NOTHING RETURNING article_id`;
    added += rows.length;
  }
  return added;
}

/**
 * The weekly review batch (Monday morning): from the last week, up to `perKind` items each that the
 * model took for a promotion, that the prefilter blocked, and whose score fell near the threshold,
 * so a rule that misfires shows up in the queue.
 */
export async function weeklyReviewBatch(opts: { perKind?: number; days?: number; now?: Date } = {}) {
  const perKind = opts.perKind ?? 10;
  const now = opts.now ?? new Date();
  const candidates = await labelCandidates(new Date(now.getTime() - (opts.days ?? 7) * 86400_000), now);
  const pick = (queue: LabelQueue, test: (c: LabelCandidate) => boolean) => candidates.filter(test).slice(0, perKind).map((c) => ({ id: c.id, queue }));
  const items = [
    ...pick("promotion", (c) => c.promotion),
    ...pick("blocked", (c) => c.relevance === "block"),
    ...pick("near_threshold", (c) => !c.promotion && c.relevance === "pass" && isNear(c)),
  ];
  return { queued: await queueForLabel(items) };
}

const LabelInput = z.object({
  decision: z.enum(["select", "reject", "either"]).nullable(),
  note: z.string().max(500).optional(),
}).strict();

/** Labels an item (null takes the label back); an item labelled outside the queue joins it as manual. */
export async function setLabel(articleId: string, input: unknown, actor: string) {
  const { decision, note } = LabelInput.parse(input);
  const [before] = await sql<{ decision: string | null; note: string | null }[]>`SELECT decision, note FROM selection_labels WHERE article_id = ${articleId}`;
  const [row] = await sql`
    INSERT INTO selection_labels (article_id, queue, split, decision, note, labeled_by, labeled_at)
    SELECT a.id, 'manual', ${SPLIT}, ${decision}, ${note ?? null}, ${actor}, ${decision ? new Date() : null} FROM articles a WHERE a.id = ${articleId}
    ON CONFLICT (article_id) DO UPDATE SET decision = EXCLUDED.decision, note = coalesce(EXCLUDED.note, selection_labels.note),
      labeled_by = EXCLUDED.labeled_by, labeled_at = EXCLUDED.labeled_at
    RETURNING article_id, queue, split, decision, note, labeled_by, labeled_at`;
  if (!row) return null;
  await audit(actor, "label.set", `content:${articleId}`, null, before ?? null, { decision, note: note ?? null });
  return row;
}

export async function labelOf(articleId: string) {
  const [row] = await sql`SELECT queue, split, decision, note, labeled_by, labeled_at FROM selection_labels WHERE article_id = ${articleId}`;
  return row ?? null;
}

export interface LabelListFilters {
  status?: "pending" | "labeled";
  queue?: string;
  track?: string;
  page?: number;
}

/** The labelling queue: the item as the model judged it, next to its label. */
export async function listLabels(f: LabelListFilters) {
  const page = Math.max(1, f.page ?? 1);
  const status = f.status === "labeled" ? sql`l.decision IS NOT NULL` : sql`l.decision IS NULL`;
  const rows = await sql`
    SELECT l.article_id AS id, l.queue, l.split, l.decision, l.note, l.queued_at, l.labeled_at,
           coalesce(nullif(an.title_zh, ''), a.title) AS title, a.title AS original_title, an.summary_zh AS summary, a.url,
           a.published_at, s.name AS source, s.tier, ${TRACK} AS track, an.category, an.score,
           (an.output->>'threshold')::numeric AS threshold, an.selected, coalesce((an.output->>'promotion')::boolean, false) AS promotion,
           an.relevance, an.output->'prefilter'->>'reason' AS prefilter_reason
    FROM selection_labels l JOIN articles a ON a.id = l.article_id JOIN sources s ON s.id = a.source_id ${LATEST}
    WHERE ${status}
      AND (${f.queue ?? null}::text IS NULL OR l.queue = ${f.queue ?? null})
      AND (${f.track ?? null}::text IS NULL OR ${TRACK} = ${f.track ?? null})
    ORDER BY ${f.status === "labeled" ? sql`l.labeled_at DESC` : sql`l.queued_at, md5(l.article_id)`}
    LIMIT 50 OFFSET ${(page - 1) * 50}`;
  const totals = await sql<{ queue: string; track: string | null; decision: string | null; n: number }[]>`
    SELECT l.queue, ${TRACK} AS track, l.decision, count(*)::int AS n
    FROM selection_labels l JOIN articles a ON a.id = l.article_id JOIN sources s ON s.id = a.source_id ${LATEST}
    GROUP BY 1, 2, 3`;
  return { page, rows, totals };
}

/**
 * The labels as a gold file (one JSON object per line, docs/selection.md): the material as it was
 * collected, the source facts the threshold depends on, and the decision. "either" is kept; the
 * evaluation leaves it out of its decisive metrics.
 */
export async function exportGold(): Promise<string> {
  const rows = await sql<{
    id: string; title: string; published_at: Date | null; source: string; kind: string; tier: string; first_party: boolean; language: string | null;
    body: string | null; track: string | null; queue: string; split: string; decision: string; x_post: { text?: string } | null;
  }[]>`
    SELECT a.id, a.title, a.published_at, s.name AS source, s.kind, s.tier, s.first_party, a.language,
           coalesce(nullif(a.body_text, ''), a.excerpt) AS body, a.x_post, ${TRACK} AS track, l.queue, l.split, l.decision
    FROM selection_labels l JOIN articles a ON a.id = l.article_id JOIN sources s ON s.id = a.source_id ${LATEST}
    WHERE l.decision IS NOT NULL ORDER BY l.labeled_at, l.article_id`;
  return rows.map((r) => {
    const body = r.x_post?.text ?? r.body;
    const zh = r.language === "zh";
    return JSON.stringify({
      caseId: r.id,
      material: { title: r.title, originalTitle: null, publishedAt: r.published_at?.toISOString() ?? null, sourceName: r.source, bodyZh: zh ? body : null, bodyOriginal: zh ? null : body },
      sourceFacts: { sourceKind: r.kind, sourceTier: r.tier, firstParty: r.first_party, language: r.language, track: r.track },
      samplingContext: { benchmarkSplit: r.split, samplingStratum: [r.track ?? "unknown", r.queue].join("/") },
      gold: { decision: r.decision },
    });
  }).join("\n") + (rows.length ? "\n" : "");
}
