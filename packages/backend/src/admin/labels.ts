// The site owner's labels for calibrating the selection (docs/selection.md): 该选 / 不该选 / 两可 on real
// items, from the item's admin page or the labelling queue. The queue is filled by a first sample
// (scripts/sample-labels.ts) and a weekly review batch (promotions, prefilter blocks, scores near the
// threshold); the labels export as the gold file scripts/eval-selection.ts and SelectBench read.
import { z } from "zod";
import { SELECTION } from "@aihot/industry/selection";
import { CATEGORIES, ROLE_KEYS } from "@aihot/industry/taxonomy";
import { sql, type Db } from "../db.ts";
import { audit } from "./auth.ts";
import { Conflict } from "./sources.ts";

export const LABEL_QUEUES = ["sample", "promotion", "blocked", "near_threshold", "manual"] as const;
export type LabelQueue = (typeof LABEL_QUEUES)[number];
export const LABEL_DECISIONS = ["select", "reject", "either"] as const;
export type LabelDecision = (typeof LABEL_DECISIONS)[number];
export const LABEL_SPLITS = ["development", "holdout"] as const;
export type LabelSplit = (typeof LABEL_SPLITS)[number];

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

/** The complete material/model snapshot kept with a queue row for later gold exports. */
export interface LabelContext {
  capturedAt: string;
  material: {
    title: string;
    originalTitle: string | null;
    publishedAt: string | null;
    sourceName: string;
    bodyZh: string | null;
    bodyOriginal: string | null;
  };
  sourceFacts: {
    sourceId: string;
    sourceKind: string;
    sourceTier: string;
    firstParty: boolean;
    language: string | null;
    track: string | null;
  };
  samplingContext: { benchmarkSplit: LabelSplit; samplingStratum: string };
  article: {
    id: string;
    revision: number;
    url: string;
    author: string | null;
    bodyStatus: string;
    discoveredAt: string;
  };
  analysis: {
    id: number | null;
    inputRevision: number | null;
    relevance: string | null;
    score: number | null;
    scores: number[] | null;
    selected: boolean | null;
    threshold: number | null;
    promptVersion: string | null;
    category: string | null;
    tags: string[];
    reason: string | null;
  };
  publication: { selected: boolean | null; score: number | null; visibility: string | null };
}

interface SnapshotRow {
  id: string; revision: number; title: string; display_title: string | null; url: string; author: string | null; language: string | null;
  published_at: Date | string | null; discovered_at: Date | string; body_text: string | null; body_status: string; x_post: Record<string, unknown> | null;
  source_id: string; source_name: string; source_kind: string; tier: string; first_party: boolean; track: string | null;
  analysis_id: number | null; analysis_revision: number | null; relevance: string | null; score: number | null; score_values: unknown; selected: boolean | null;
  prompt_version: string | null; category: string | null; tags: string[] | null; reason_zh: string | null; output: Record<string, unknown> | null;
  publication_selected: boolean | null; publication_score: number | null; visibility: string | null; translation_zh: string | null;
}

const clip = (value: string | null | undefined, max = 14_000): string | null => {
  if (!value) return null;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}\n[内容已截断]` : text;
};
const iso = (value: Date | string | null | undefined): string | null => value ? new Date(value).toISOString() : null;
const numericArray = (value: unknown): number[] | null => Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : null;

function thresholdFor(row: SnapshotRow): number | null {
  const fromOutput = row.output?.threshold;
  if (typeof fromOutput === "number" && Number.isFinite(fromOutput)) return fromOutput;
  const trackThreshold = row.track ? SELECTION.trackThresholds[row.track]?.[row.tier] : undefined;
  const value = trackThreshold ?? SELECTION.thresholds[row.tier];
  return Number.isFinite(value) ? value : null;
}

function contextFromRow(row: SnapshotRow, split: LabelSplit, queue: LabelQueue): LabelContext {
  const xText = row.x_post && typeof row.x_post.text === "string" ? row.x_post.text : null;
  const output = row.output ?? {};
  const scores = numericArray(row.score_values) ?? numericArray(output.scores);
  const track = row.track;
  return {
    capturedAt: new Date().toISOString(),
    material: {
      title: row.display_title || row.title,
      originalTitle: row.title,
      publishedAt: iso(row.published_at),
      sourceName: row.source_name,
      bodyZh: clip(row.translation_zh),
      bodyOriginal: clip(row.body_text ?? xText),
    },
    sourceFacts: { sourceId: row.source_id, sourceKind: row.source_kind, sourceTier: row.tier, firstParty: row.first_party, language: row.language, track },
    samplingContext: { benchmarkSplit: split, samplingStratum: `${track ?? "unknown"}/${queue}` },
    article: { id: row.id, revision: row.revision, url: row.url, author: row.author, bodyStatus: row.body_status, discoveredAt: new Date(row.discovered_at).toISOString() },
    analysis: {
      id: row.analysis_id, inputRevision: row.analysis_revision, relevance: row.relevance, score: row.score === null ? null : Number(row.score), scores,
      selected: row.selected, threshold: thresholdFor(row), promptVersion: row.prompt_version, category: row.category, tags: row.tags ?? [], reason: row.reason_zh,
    },
    publication: { selected: row.publication_selected, score: row.publication_score === null ? null : Number(row.publication_score), visibility: row.visibility },
  };
}

async function snapshotOf(articleId: string, split: LabelSplit, queue: LabelQueue, db: Db = sql): Promise<LabelContext | null> {
  const [row] = await db<SnapshotRow[]>`
    SELECT a.id, a.revision, a.title, coalesce(nullif(p.title, ''), nullif(tr.title, ''), a.title) AS display_title, a.url, a.author, a.language,
           a.published_at, a.discovered_at, a.body_text, a.body_status, a.x_post, s.id AS source_id, s.name AS source_name,
           s.kind AS source_kind, s.tier, s.first_party, s.track, an.id AS analysis_id, an.input_revision AS analysis_revision,
           an.relevance, an.score, an.output->'scores' AS score_values, an.selected, an.prompt_version, an.category, an.tags, an.reason_zh, an.output,
           p.selected AS publication_selected, p.score AS publication_score, p.visibility, tr.body_text AS translation_zh
    FROM articles a
    JOIN sources s ON s.id = a.source_id
    LEFT JOIN LATERAL (
      SELECT id, input_revision, relevance, score, selected, prompt_version, category, tags, reason_zh, output
      FROM analyses WHERE article_id = a.id ORDER BY input_revision DESC, id DESC LIMIT 1
    ) an ON true
    LEFT JOIN publications p ON p.article_id = a.id
    LEFT JOIN translations tr ON tr.article_id = a.id AND tr.lang = 'zh' AND tr.revision >= a.revision
    WHERE a.id = ${articleId}`;
  return row ? contextFromRow(row, split, queue) : null;
}

function isContext(value: unknown): value is LabelContext {
  return !!value && typeof value === "object" && typeof (value as { material?: unknown }).material === "object";
}

export interface LabelCandidate {
  id: string;
  roles: string[];
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
           coalesce((an.output->>'promotion')::boolean, false) AS promotion, an.relevance, coalesce(an.output->'roles', '[]'::jsonb) AS roles
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

/** Adds unpicked, relevant industry items until each role is covered, preferring borderline scores. */
export function completeRoleSample(candidates: LabelCandidate[], pickedIds: readonly string[], n: number): LabelCandidate[] {
  const taken = new Set(pickedIds);
  const counts = Object.fromEntries(ROLE_KEYS.map((role) => [role, candidates.filter((c) => taken.has(c.id) && c.roles.includes(role)).length]));
  const target = Math.max(3, Math.floor(n / 10));
  const pool = candidates.filter((c) => c.track === "industry" && c.relevance === "pass" && !c.promotion)
    .sort((a, b) => Number(isNear(b, 8)) - Number(isNear(a, 8)) || (b.score ?? -1) - (a.score ?? -1));
  const added: LabelCandidate[] = [];
  for (const role of ROLE_KEYS) {
    for (const c of pool) {
      if (counts[role]! >= target) break;
      if (taken.has(c.id) || !c.roles.includes(role)) continue;
      taken.add(c.id);
      added.push(c);
      for (const key of ROLE_KEYS) if (c.roles.includes(key)) counts[key]! += 1;
    }
  }
  return added;
}

/** Queues items for labelling; already queued or labelled ones are left as they are.
 * The context is captured before the insert and never refreshed by later article revisions. */
export async function queueForLabel(items: Array<{ id: string; queue: LabelQueue }>, actor: string | null = null): Promise<number> {
  let added = 0;
  for (const it of items) {
    const queue = LABEL_QUEUES.includes(it.queue) ? it.queue : null;
    if (!queue) continue;
    const [splitRow] = await sql<{ split: LabelSplit }[]>`SELECT ${SPLIT} AS split FROM articles a WHERE a.id = ${it.id}`;
    if (!splitRow) continue;
    const context = await snapshotOf(it.id, splitRow.split, queue);
    if (!context) continue;
    const rows = await sql`
      INSERT INTO selection_labels (article_id, queue, split, context, actor)
      VALUES (${it.id}, ${queue}, ${splitRow.split}, ${sql.json(context as never)}, ${actor})
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
  decision: z.enum(LABEL_DECISIONS).nullable().optional(),
  note: z.string().max(4000).nullable().optional(),
  /** The version read by the page. Omitted by older clients for compatibility. */
  version: z.number().int().positive().optional(),
}).strict();

function invalid(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export interface LabelRow {
  article_id: string;
  queue: LabelQueue;
  split: LabelSplit;
  decision: LabelDecision | null;
  note: string | null;
  labeled_by: string | null;
  actor: string | null;
  labeled_at: Date | string | null;
  context: LabelContext;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

/** Labels an item; an item labelled outside the queue joins it as manual.
 * Saving a stale version is rejected so two admin tabs cannot silently overwrite one another. */
export async function setLabel(articleId: string, input: unknown, actor: string) {
  const parsed = LabelInput.safeParse(input);
  if (!parsed.success) throw invalid("invalid selection label");
  const patch = parsed.data;
  const noteProvided = Object.prototype.hasOwnProperty.call(patch, "note");
  const note = noteProvided ? (patch.note?.trim() || null) : null;
  const [before] = await sql<LabelRow[]>`SELECT * FROM selection_labels WHERE article_id = ${articleId}`;
  const expected = patch.version ?? null;
  if (expected !== null && (!before || before.version !== expected)) throw new Conflict("这条标注已被其他管理员修改，请刷新后再保存");
  const [target] = await sql<{ split: LabelSplit }[]>`SELECT ${SPLIT} AS split FROM articles a WHERE a.id = ${articleId}`;
  if (!target) return null;
  const split = before?.split ?? target.split;
  const queue = before?.queue ?? "manual";
  const context = before && isContext(before.context) ? before.context : await snapshotOf(articleId, split, queue);
  if (!context) return null;
  const decision = patch.decision === undefined ? (before?.decision ?? null) : patch.decision;
  const labeledAt = patch.decision === undefined ? (before?.labeled_at ?? null) : (decision ? new Date() : null);
  const [row] = await sql<LabelRow[]>`
    INSERT INTO selection_labels (article_id, queue, split, decision, note, labeled_by, labeled_at, actor, context)
    VALUES (${articleId}, 'manual', ${split}, ${decision}, ${noteProvided ? note : null}, ${actor}, ${labeledAt}, ${actor}, ${sql.json(context as never)})
    ON CONFLICT (article_id) DO UPDATE SET
      decision = EXCLUDED.decision,
      note = CASE WHEN ${noteProvided} THEN EXCLUDED.note ELSE selection_labels.note END,
      labeled_by = EXCLUDED.labeled_by, actor = EXCLUDED.actor, labeled_at = EXCLUDED.labeled_at,
      context = CASE WHEN selection_labels.context = '{}'::jsonb THEN EXCLUDED.context ELSE selection_labels.context END,
      version = selection_labels.version + 1, updated_at = now()
    WHERE ${expected === null} OR selection_labels.version = ${expected}
    RETURNING article_id, queue, split, decision, note, labeled_by, actor, labeled_at, context, version, created_at, updated_at`;
  if (!row) throw new Conflict("这条标注已被其他管理员修改，请刷新后再保存");
  await audit(actor, "label.set", `content:${articleId}`, null, before ? { decision: before.decision, note: before.note, version: before.version } : null, { decision: row.decision, note: row.note, version: row.version });
  return row;
}

export async function labelOf(articleId: string) {
  const [row] = await sql<LabelRow[]>`SELECT * FROM selection_labels WHERE article_id = ${articleId}`;
  if (!row) return null;
  if (!isContext(row.context)) {
    const context = await snapshotOf(articleId, row.split, row.queue);
    if (context) {
      await sql`UPDATE selection_labels SET context = ${sql.json(context as never)} WHERE article_id = ${articleId} AND context = '{}'::jsonb`;
      row.context = context;
    }
  }
  return row;
}

export interface LabelListFilters {
  status?: "pending" | "labeled";
  queue?: string;
  track?: string;
  split?: string;
  decision?: LabelDecision | "unlabeled";
  q?: string;
  page?: number;
}

/** The labelling queue: the item as the model judged it, next to its label. */
export async function listLabels(f: LabelListFilters = {}) {
  const page = Math.max(1, f.page ?? 1);
  const status = f.status === "labeled" ? sql`l.decision IS NOT NULL` : f.status === "pending" || !f.status ? sql`l.decision IS NULL` : sql`true`;
  const term = f.q?.trim() ? `%${f.q.trim()}%` : null;
  const queue = f.queue ? (LABEL_QUEUES.includes(f.queue as LabelQueue) ? f.queue : (() => { throw invalid("queue is invalid"); })()) : null;
  const split = f.split ? (LABEL_SPLITS.includes(f.split as LabelSplit) ? f.split : (() => { throw invalid("split is invalid"); })()) : null;
  const decision = f.decision && f.decision !== "unlabeled"
    ? (LABEL_DECISIONS.includes(f.decision as LabelDecision) ? f.decision : (() => { throw invalid("decision is invalid"); })())
    : null;
  const rows = await sql`
    SELECT l.article_id AS id, l.queue, l.split, l.decision, l.note, l.queued_at, l.labeled_at, l.actor, l.version, l.created_at, l.updated_at, l.context,
           coalesce(nullif(an.title_zh, ''), a.title) AS title, a.title AS original_title, an.summary_zh AS summary, a.url,
           a.published_at, s.name AS source, s.tier, ${TRACK} AS track, an.category, an.score,
           (an.output->>'threshold')::numeric AS threshold, an.selected, coalesce((an.output->>'promotion')::boolean, false) AS promotion,
           an.relevance, an.output->'prefilter'->>'reason' AS prefilter_reason,
           an.output->'roles' AS roles, an.output->>'impact' AS impact
    FROM selection_labels l JOIN articles a ON a.id = l.article_id JOIN sources s ON s.id = a.source_id ${LATEST}
    WHERE ${status}
      AND (${queue}::text IS NULL OR l.queue = ${queue})
      AND (${f.track ?? null}::text IS NULL OR ${TRACK} = ${f.track ?? null})
      AND (${split}::text IS NULL OR l.split = ${split})
      AND (${decision}::text IS NULL OR l.decision = ${decision})
      AND (${f.decision === "unlabeled"} IS FALSE OR l.decision IS NULL)
      AND (${term}::text IS NULL OR l.article_id ILIKE ${term} OR a.title ILIKE ${term} OR s.name ILIKE ${term})
    ORDER BY ${f.status === "labeled" ? sql`l.labeled_at DESC NULLS LAST` : sql`l.queued_at, md5(l.article_id)`}, l.article_id
    LIMIT 51 OFFSET ${(page - 1) * 50}`;
  const totals = await sql<{ queue: string; track: string | null; decision: string | null; n: number }[]>`
    SELECT l.queue, ${TRACK} AS track, l.decision, count(*)::int AS n
    FROM selection_labels l JOIN articles a ON a.id = l.article_id JOIN sources s ON s.id = a.source_id ${LATEST}
    GROUP BY 1, 2, 3`;
  const hasMore = rows.length > 50;
  return { page, rows: rows.slice(0, 50), hasMore, totals };
}

/**
 * The labels as a gold file (one JSON object per line, docs/selection.md): the material as it was
 * collected, the source facts the threshold depends on, and the decision. "either" is kept; the
 * evaluation leaves it out of its decisive metrics.
 */
export interface GoldFilters {
  queue?: string;
  split?: string;
  decision?: LabelDecision | "unlabeled";
}

export async function exportGold(filters: GoldFilters = {}): Promise<string> {
  if (filters.decision === "unlabeled") return "";
  const queue = filters.queue ? (LABEL_QUEUES.includes(filters.queue as LabelQueue) ? filters.queue : (() => { throw invalid("queue is invalid"); })()) : null;
  const split = filters.split ? (LABEL_SPLITS.includes(filters.split as LabelSplit) ? filters.split : (() => { throw invalid("split is invalid"); })()) : null;
  const decision = filters.decision
    ? (LABEL_DECISIONS.includes(filters.decision as LabelDecision) ? filters.decision : (() => { throw invalid("decision is invalid"); })())
    : null;
  const rows = await sql<LabelRow[]>`
    SELECT * FROM selection_labels
    WHERE decision IS NOT NULL
      AND (${queue}::text IS NULL OR queue = ${queue})
      AND (${split}::text IS NULL OR split = ${split})
      AND (${decision}::text IS NULL OR decision = ${decision})
    ORDER BY labeled_at NULLS LAST, article_id`;
  const output: string[] = [];
  for (const row of rows) {
    let context = isContext(row.context) ? row.context : null;
    if (!context) {
      context = await snapshotOf(row.article_id, row.split, row.queue);
      if (context) {
        await sql`UPDATE selection_labels SET context = ${sql.json(context as never)} WHERE article_id = ${row.article_id} AND context = '{}'::jsonb`;
      }
    }
    if (!context) continue;
    output.push(JSON.stringify({
      caseId: row.article_id,
      material: context.material,
      sourceFacts: {
        sourceKind: context.sourceFacts.sourceKind, sourceTier: context.sourceFacts.sourceTier, firstParty: context.sourceFacts.firstParty,
        language: context.sourceFacts.language, track: context.sourceFacts.track,
      },
      samplingContext: context.samplingContext,
      gold: { decision: row.decision },
    }));
  }
  return output.length ? `${output.join("\n")}\n` : "";
}
