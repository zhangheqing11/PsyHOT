// Tag normalization over the industry pack's vocabulary (industry/taxonomy.ts), which the topics
// (industry/topics.json) are built on.
import { CATEGORIES, CATEGORY_TAGS, ENTITY_TAGS, TAG_SYNONYMS, TOPIC_TAGS } from "@aihot/industry/taxonomy";

export { CATEGORY_BY_ITEM_TYPE, CATEGORY_TAGS, ENTITIES, ENTITY_TAGS, ITEM_TYPES, TOPIC_TAGS } from "@aihot/industry/taxonomy";

const ALLOWED_TAGS = new Set<string>([...CATEGORY_TAGS, ...TOPIC_TAGS, ...ENTITY_TAGS]);

/**
 * Known tags only, synonyms mapped, duplicates dropped, at most `max`; the category tag goes first. A list
 * without one gets `fallbackCategory` (deterministic, no repair call).
 */
export function normalizeTags(v: unknown, opts: { max?: number; fallbackCategory?: string } = {}): string[] {
  const max = opts.max ?? 6;
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,，]/g) : [];
  const tags: string[] = [];
  for (const x of raw) {
    const t = String(x ?? "").trim().replace(/^#/, "");
    const tag = TAG_SYNONYMS[t] ?? TAG_SYNONYMS[t.toLowerCase()] ?? t;
    if (tag && ALLOWED_TAGS.has(tag) && !tags.includes(tag)) tags.push(tag);
  }
  const isCategory = (t: string) => (CATEGORY_TAGS as readonly string[]).includes(t);
  const categoryIndex = tags.findIndex(isCategory);
  const category = categoryIndex >= 0 ? tags[categoryIndex]! : (opts.fallbackCategory ?? CATEGORY_TAGS[CATEGORY_TAGS.length - 1]!);
  return [category, ...tags.filter((t) => t !== category)].slice(0, max);
}

/** The category guide of one track's categories, for the structure step's second question. */
export const trackGuide = (track: "academic" | "industry") =>
  CATEGORIES.filter((c) => c.track === track).map((c) => `- ${c.key}（${c.label}）：${c.guide}`).join("\n");

/** Each track's categories, in the pack's order. */
export const TRACK_CATEGORIES = {
  academic: CATEGORIES.filter((c) => c.track === "academic").map((c) => c.key),
  industry: CATEGORIES.filter((c) => c.track === "industry").map((c) => c.key),
} as Record<"academic" | "industry", string[]>;

/** Where an item of a one-track source lands when the model picks the other side's category. */
const TRACK_FALLBACK = { academic: "opinion", industry: "industry" } as const;

/**
 * The category an item keeps, given its source's track: an academic or industry source's items stay on
 * that side (a mixed source's take any category).
 */
export function categoryForSource(category: string | null, sourceTrack: string | undefined): string | null {
  if (sourceTrack !== "academic" && sourceTrack !== "industry") return category;
  if (category === null || TRACK_CATEGORIES[sourceTrack].includes(category)) return category;
  return TRACK_FALLBACK[sourceTrack];
}

/** The track of a stored category (null when it has none). */
export function trackOfCategory(category: string | null): "academic" | "industry" | null {
  return CATEGORIES.find((c) => c.key === category)?.track ?? null;
}
