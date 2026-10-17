// Public vocabularies shared by the website, the API and the worker. The categories themselves belong to
// the industry pack (industry/taxonomy.ts); their keys are external identities (URLs, API, RSS).
import { FEATURES } from "@aihot/industry/features";
import { CATEGORIES, TRACKS } from "@aihot/industry/taxonomy";

export type CategoryKey = (typeof CATEGORIES)[number]["key"];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key) as unknown as readonly [CategoryKey, ...CategoryKey[]];

export type TrackKey = (typeof TRACKS)[number]["key"];
export const TRACK_KEYS = TRACKS.map((t) => t.key) as unknown as readonly [TrackKey, ...TrackKey[]];
export const TRACK_LABELS = Object.fromEntries(TRACKS.map((t) => [t.key, t.label])) as Record<TrackKey, string>;

/** The track each category belongs to. */
export const CATEGORY_TRACK = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.track])) as Record<CategoryKey, TrackKey>;

/** Each category's own name (admin pages, the model's guide). */
export const CATEGORY_NAMES = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label])) as Record<CategoryKey, string>;

/**
 * Until the tracks switch is on (FEATURES.tracks), readers see the categories they saw before the
 * industry track was split: the industry track's categories show, filter and export as one `industry`
 * labelled 行业. With the switch on every category stands for itself.
 */
const MERGED_INDUSTRY_LABEL = "行业";
const merged = (key: CategoryKey): CategoryKey => (!FEATURES.tracks && CATEGORY_TRACK[key] === "industry" ? "industry" : key);

/** Website tab labels, card badges and feed categories: what a reader sees for a stored category. */
export const CATEGORY_LABELS = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, FEATURES.tracks || c.track !== "industry" ? c.label : MERGED_INDUSTRY_LABEL]),
) as Record<CategoryKey, string>;

/** The categories readers can pick (filter row, RSS, API, MCP). */
export const PUBLIC_API_CATEGORY_KEYS = CATEGORY_KEYS.filter((k) => merged(k) === k) as unknown as readonly [CategoryKey, ...CategoryKey[]];
export type PublicApiCategoryKey = CategoryKey;

/** A stored category as readers see it. */
export function toPublicApiCategory(category: string | null): PublicApiCategoryKey | null {
  return isCategoryKey(category) ? merged(category) : null;
}

/** The stored categories a reader's category stands for. */
export function categoryMembers(category: CategoryKey): CategoryKey[] {
  return CATEGORY_KEYS.filter((k) => merged(k) === category);
}

export function isCategoryKey(value: unknown): value is CategoryKey {
  return typeof value === "string" && (CATEGORY_KEYS as readonly string[]).includes(value);
}

export const CHANNEL_KEYS = ["all", "news", "x", "firstParty"] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];

export const CHANNEL_LABELS: Record<ChannelKey, string> = {
  all: "全部",
  news: "资讯",
  x: "X",
  firstParty: "一手",
};

export function isChannelKey(value: unknown): value is ChannelKey {
  return typeof value === "string" && (CHANNEL_KEYS as readonly string[]).includes(value);
}

export const LEADERBOARD_PUBLIC_BOARDS = ["overall", "coding", "reasoning", "knowledge", "professional"] as const;
export type LeaderboardBoardKey = (typeof LEADERBOARD_PUBLIC_BOARDS)[number];

export const LEADERBOARD_BOARD_LABELS: Record<LeaderboardBoardKey, string> = {
  overall: "综合",
  coding: "编程",
  reasoning: "推理",
  knowledge: "知识",
  professional: "专业办公",
};

/** Article ids. Also the local-data import validation pattern. */
export const ARTICLE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
