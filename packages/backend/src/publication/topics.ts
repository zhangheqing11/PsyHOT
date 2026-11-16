import type { FeedItemSummary } from "@aihot/contracts/site";
import { SELECTION } from "@aihot/industry/selection";
import { TRACK_CATEGORIES, type RegionKey, type RoleKey, type TrackKey } from "@aihot/contracts/taxonomy";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";
import { sql } from "../db.ts";
import { cached } from "../lib/cache.ts";
import { exportedPoolCondition, ITEM_COLUMNS, ITEM_FROM, regionCondition, roleCondition, selectedCondition, toFeedItemSummary, trackCondition, type ItemRow } from "./items.ts";

export interface TopicRow {
  slug: string;
  name: string;
  grp: "company" | "field" | "genre";
  entity_id: string | null;
  tags: string[];
  definition: string;
  related: string[];
  position: number;
}

type TopicLatestItem = { id: string; title: string };
type TopicViewCount = { total: number; recent: number; latest: Date | null; latestItems: TopicLatestItem[] };
type TopicCount = TopicViewCount & {
  slug: string; pages: number; indexable: boolean;
  all: TopicViewCount; academic: TopicViewCount; industry: TopicViewCount;
};
const topicsCache = cached(
  () => sql<TopicRow[]>`SELECT slug, name, grp, entity_id, tags, definition, related, position FROM topics ORDER BY position`,
  { freshMs: 60_000, maxStaleMs: 10 * 60_000 },
);
// Counts may lag by about a minute, like the public directory cache; item reads always check visibility.
const countsCache = cached(queryTopicCounts, { freshMs: 60_000, maxStaleMs: 10 * 60_000 });

function readTopicCatalog() {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/topics.json"), "utf8")) as {
    topics: Array<{ slug: string; name: string; group: string; entityId?: string | null; tags: string[]; definition: string; related?: string[] }>;
    aliases: Record<string, { to: string; tag?: string }>;
  };
}

// Alias mappings are static for this process; seedTopics still rereads the catalog on every run.
let topicAliases: ReturnType<typeof readTopicCatalog>["aliases"] | null = null;

/**
 * The topics (stable slugs, names, definitions, related topics) come from the industry pack
 * (industry/topics.json); every environment seeds them from there. Re-runnable.
 */
export async function seedTopics(): Promise<number> {
  const data = readTopicCatalog();
  let position = 0;
  for (const t of data.topics) {
    await sql`
      INSERT INTO topics (slug, name, grp, entity_id, tags, definition, related, position)
      VALUES (${t.slug}, ${t.name}, ${t.group}, ${t.entityId ?? null}, ${t.tags}, ${t.definition}, ${t.related ?? []}, ${position++})
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, grp = EXCLUDED.grp, entity_id = EXCLUDED.entity_id,
        tags = EXCLUDED.tags, definition = EXCLUDED.definition, related = EXCLUDED.related, position = EXCLUDED.position`;
  }
  const slugs = data.topics.map((t) => t.slug);
  await sql`DELETE FROM topics WHERE slug <> ALL(${slugs}::text[])`;
  topicsCache.clear();
  countsCache.clear();
  return data.topics.length;
}

export function listTopics(): Promise<TopicRow[]> {
  return topicsCache.get();
}

export async function loadTopic(slug: string): Promise<TopicRow | null> {
  return (await listTopics()).find((t) => t.slug === slug) ?? null;
}

/**
 * Tags that put an article in a topic. A company topic takes only articles actually about the company
 * (its entity subject tag), never mere mentions; field and genre topics match their tags.
 */
export function topicMatchTags(t: Pick<TopicRow, "entity_id" | "tags">): string[] {
  return t.entity_id ? [`entity:${t.entity_id}`] : t.tags;
}

export async function loadTopicTags(slug: string): Promise<string[] | null> {
  const alias = resolveTopicAlias(slug);
  if (alias?.tag) return [alias.tag];
  const t = await loadTopic(alias?.to ?? slug);
  return t ? topicMatchTags(t) : null;
}

export function resolveTopicAlias(slug: string): { to: string; tag: string | null } | null {
  const aliases = topicAliases ??= readTopicCatalog().aliases;
  if (!Object.hasOwn(aliases, slug)) return null;
  const alias = aliases[slug];
  return { to: alias.to, tag: alias.tag ?? null };
}

export const TOPIC_PAGE_SIZE = 20;

// Both directory counts and page reads use the same public-pool and dimension conditions.
function topicPickPoolCondition(now: Date) {
  return sql`${exportedPoolCondition(now)} AND NOT p.selected AND NOT p.backfill`;
}

function topicPickAnalysisCondition() {
  return sql`a.output->>'scoringPath' = 'dims'
    AND (a.output->>'dimsSum')::int >= ${SELECTION.topicPicks.minSum}
    AND (a.output->'dims'->>'cred')::int >= ${SELECTION.topicPicks.minCred}`;
}

// Missing, non-array and empty coarse scores have mean zero and cannot pass the configured floors.
const topicPickScoreMean = sql`coalesce((
  SELECT avg(s.value::numeric) FROM jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(a.output->'scores') = 'array' THEN a.output->'scores' ELSE '[]'::jsonb END
  ) AS s(value)
), 0)`;

/** Stable domain picks: a configured topic floor, with no age, story or source quota. */
export function topicPickCondition(slug: string, now: Date) {
  if (!Object.hasOwn(SELECTION.topicPicks.floors, slug)) return sql`FALSE`;
  return sql`${topicPickPoolCondition(now)} AND EXISTS (
    SELECT 1 FROM analyses a WHERE a.id = p.analysis_id AND ${topicPickAnalysisCondition()}
      AND ${topicPickScoreMean} >= ${SELECTION.topicPicks.floors[slug]})`;
}

/** Topic pages exist for every topic; only topics with enough content are listed and indexed. */
export function topicPageCounts(): Promise<TopicCount[]> {
  return countsCache.get();
}

/**
 * Read the selected set and dimension-qualified pick candidates once, then apply each topic floor
 * and tag union in memory. The disjoint sets share timeline order and the page queries' conditions.
 */
async function queryTopicCounts(): Promise<TopicCount[]> {
  const now = new Date();
  const [topics, items] = await Promise.all([
    sql<Array<Pick<TopicRow, "slug" | "entity_id" | "tags">>>`SELECT slug, entity_id, tags FROM topics ORDER BY position`,
    sql<{ article_id: string; title: string; category: string | null; tags: string[]; timeline_at: Date; selected: boolean; coarse_mean: number | null }[]>`
      SELECT p.article_id, p.title, p.category, p.tags, p.timeline_at, p.selected, NULL::numeric AS coarse_mean
      FROM publications p WHERE ${selectedCondition(now)}
      UNION ALL
      SELECT p.article_id, p.title, p.category, p.tags, p.timeline_at, p.selected, ${topicPickScoreMean} AS coarse_mean
      FROM publications p JOIN analyses a ON a.id = p.analysis_id
      WHERE ${topicPickPoolCondition(now)} AND ${topicPickAnalysisCondition()}
      ORDER BY timeline_at DESC, article_id DESC`,
  ]);
  const recentFrom = now.getTime() - 30 * 86400_000;
  return topics.map((t) => {
    const match = new Set(topicMatchTags(t));
    const empty = (): TopicViewCount => ({ total: 0, recent: 0, latest: null, latestItems: [] });
    const views = { all: empty(), academic: empty(), industry: empty() };
    const hasPicks = Object.hasOwn(SELECTION.topicPicks.floors, t.slug);
    for (const it of items) {
      if (!it.selected && (!hasPicks || (it.coarse_mean ?? 0) < SELECTION.topicPicks.floors[t.slug])) continue;
      if (!it.tags.some((tag) => match.has(tag))) continue;
      for (const view of ["all", "academic", "industry"] as const) {
        if (view !== "all" && !TRACK_CATEGORIES[view].some((c) => c === it.category)) continue;
        const count = views[view];
        count.total += 1;
        if (it.timeline_at.getTime() > recentFrom) count.recent += 1;
        count.latest ??= it.timeline_at;
        if (count.latestItems.length < 2) count.latestItems.push({ id: it.article_id, title: it.title });
      }
    }
    const { total, recent } = views.all;
    return { slug: t.slug, ...views.all, ...views, pages: Math.max(1, Math.ceil(total / TOPIC_PAGE_SIZE)), indexable: total >= 50 || (total >= 20 && recent > 0) };
  });
}

export interface TopicSummary {
  slug: string;
  name: string;
  group: "company" | "field" | "genre";
  definition: string;
  total: number;
  recent: number;
  indexable: boolean;
  hasPicks: boolean;
  latestAt: string | null;
  latestItems: TopicLatestItem[];
}

export async function listTopicSummaries(track?: TrackKey | null): Promise<TopicSummary[]> {
  const topics = await listTopics();
  const counts = new Map((await topicPageCounts()).map((c) => [c.slug, c]));
  return topics.map((t) => {
    const c = counts.get(t.slug);
    const view = c?.[track ?? "all"];
    return { slug: t.slug, name: t.name, group: t.grp, definition: t.definition, total: view?.total ?? 0, recent: view?.recent ?? 0, indexable: c?.indexable ?? false, hasPicks: Object.hasOwn(SELECTION.topicPicks.floors, t.slug), latestAt: view?.latest?.toISOString() ?? null, latestItems: view?.latestItems ?? [] };
  });
}

export interface TopicPage {
  topic: TopicSummary & { allTotal: number; subtags: Array<{ tag: string; total: number }>; related: Array<{ slug: string; name: string }> };
  items: FeedItemSummary[];
  fieldPickIds: string[];
  page: number;
  pageCount: number;
}

interface TopicFilters { track?: TrackKey | null; region?: RegionKey | null; role?: RoleKey | null; tag?: string | null }

export async function loadTopicPage(slug: string, page: number, filters: TopicFilters = {}, now = new Date()): Promise<TopicPage | null> {
  const row = await loadTopic(slug);
  if (!row || !Number.isInteger(page) || page < 1) return null;
  const tags = topicMatchTags(row);
  if (filters.tag && !tags.includes(filters.tag)) return null;
  const match = filters.tag ? [filters.tag] : tags;
  const topics = await listTopicSummaries(filters.track);
  const topic = topics.find((t) => t.slug === slug);
  if (!topic) return null;
  const filterSql = sql`${trackCondition(filters.track)} ${regionCondition(filters.region)} ${roleCondition(filters.role, true)}`;
  // Role filters retain only their own globally selected set.
  const pickCondition = filters.role ? sql`FALSE` : topicPickCondition(slug, now);
  const selectionSql = sql`(${selectedCondition(now)}) OR (${pickCondition})`;
  // Count every subtag in the same filtered scope as all_total, independently of the active tag.
  const subtagCounts = tags.reduce(
    (counts, tag) => sql`${counts} || jsonb_build_object(${tag}::text, count(*) FILTER (WHERE p.tags @> ${[tag]}::text[])::int)`,
    sql`'{}'::jsonb`,
  );
  const [{ total, all_total, subtag_totals }] = await sql<{ total: number; all_total: number; subtag_totals: Record<string, number> }[]>`
    SELECT count(*) FILTER (WHERE p.tags && ${match}::text[])::int AS total, count(*)::int AS all_total,
      ${subtagCounts} AS subtag_totals FROM publications p
    WHERE (${selectionSql}) AND p.tags && ${tags}::text[] ${filterSql}`;
  const totalCount = Number(total);
  const pageCount = Math.max(1, Math.ceil(totalCount / TOPIC_PAGE_SIZE));
  if (page < 1 || page > pageCount) return null;
  // Page the combined set first, then hydrate only those rows through the public projection.
  const rows = await sql<ItemRow[]>`
    WITH page AS (
      SELECT p.article_id FROM publications p
      WHERE (${selectionSql}) AND p.tags && ${match}::text[] ${filterSql}
      ORDER BY p.timeline_at DESC, p.article_id DESC
      LIMIT ${TOPIC_PAGE_SIZE} OFFSET ${(page - 1) * TOPIC_PAGE_SIZE})
    SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE p.article_id IN (SELECT article_id FROM page)
    ORDER BY p.timeline_at DESC, p.article_id DESC`;
  const related = row.related.map((r) => topics.find((t) => t.slug === r)).filter((t): t is TopicSummary => !!t).map((t) => ({ slug: t.slug, name: t.name }));
  const subtags = tags.length > 1 ? tags.map((tag) => ({ tag, total: subtag_totals[tag] ?? 0 })) : [];
  const fieldPickIds = rows.filter((row) => !row.selected).map((row) => row.id);
  return { topic: { ...topic, total: totalCount, allTotal: Number(all_total), subtags, related }, items: rows.map(toFeedItemSummary), fieldPickIds, page, pageCount };
}
