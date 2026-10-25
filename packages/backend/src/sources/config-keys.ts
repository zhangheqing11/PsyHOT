// The config keys each kind of source implements. Anything else is refused: a key a collector does not
// know would otherwise fall back silently to the generic parse (menus and sentence fragments as
// articles, dates never found).
import type { SourceRow } from "./types.ts";

// Rules applied in collect.ts to every kind read through collectSource.
const COLLECTED = ["_aihot", "allowUrlPrefixes", "denyUrlPrefixes", "ingestNoiseFilter", "itemUrlPrefixRewrite", "sortByPublishedAt", "detail", "fetchPublicContent", "userAgent", "poolMinScore"];

const KEYS: Record<SourceRow["kind"], string[]> = {
  rss: [...COLLECTED, "feedUrl", "summaryIsBody", "preserveUrlFragment", "allowCategories", "denyCategories"],
  web_list: [
    ...COLLECTED, "url", "baseUrl", "parseMode", "adapter", "cacheToleranceSeconds", "linksStartLine", "preserveUrlFragment",
    "itemSelector", "linkSelector", "titleSelector", "publishedAtSelector", "publishedAtRegex", "publishedAtUtcOffset",
  ],
  json_list: [
    ...COLLECTED, "url", "adapter", "mode", "method", "headers", "bodyJson", "jsonKey", "windowVar", "itemsPath", "itemsObjectValues",
    "titlePaths", "summaryPaths", "summaryIsBody", "authorPaths", "publishedAtPath", "publishedAtPaths", "publishedAtUnit", "externalIdPath", "excludePatterns",
    "urlTemplate", "urlTemplateFallback", "rawDropKeys", "requireBoolean", "minNumeric", "everyinfraAction", "everyinfraParams", "everyinfraDetail", "everyinfraLookbackDays",
  ],
  // X accounts are mostly read in shards, which apply only these.
  x_search: ["_aihot", "ingestNoiseFilter", "itemUrlPrefixRewrite", "query", "searchType", "poolMinScore"],
  // wechatBiz: the account's __biz; every listed article must carry it (sources/mp.ts).
  mp_account: ["wxid", "ghid", "nickname", "ingestNoiseFilter", "wechatBiz", "poolMinScore"],
  external: ["poolMinScore"],
};

// Objects with fixed keys (headers and bodyJson are request data, free-form).
const NESTED: Record<string, string[]> = {
  _aihot: ["initialBackfillLimit", "initialBackfillMonths"],
  ingestNoiseFilter: ["dropMarkers", "dropMarkersTitleOnly", "keepIfMatches", "requireMarkers"],
  itemUrlPrefixRewrite: ["from", "to"],
  requireBoolean: ["path", "equals"],
  minNumeric: ["path", "min"],
  detail: [
    "maxFetches", "publishedAtSelector", "publishedAtRegex", "publishedAtUtcOffset", "publishedAtAuthoritative", "upgradeDatePrecision",
    "titleSelector", "titleRegex", "titleAuthoritative", "summarySelector",
  ],
};

const VALUES: Record<string, string[]> = {
  parseMode: ["html", "markdown", "docusaurus_changelog"],
  publishedAtUnit: ["epoch_ms", "epoch_s", "yyyymmdd"],
};
// Values that depend on the kind of source: each adapter belongs to one fetcher.
const KIND_VALUES: Partial<Record<SourceRow["kind"], Record<string, string[]>>> = {
  web_list: { adapter: ["mimo_home"] },
  json_list: { adapter: ["bluesky_feed", "everyinfra_xhs", "everyinfra_x"] },
};

/** The config entries a source of this kind would ignore or cannot run, e.g. ["adapter=site_cards", "detail.titleFoo"]. */
export function unsupportedConfig(kind: SourceRow["kind"], config: Record<string, unknown>): string[] {
  const allowed = new Set(KEYS[kind] ?? []);
  const out: string[] = [];
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!allowed.has(key)) out.push(key);
    else if (key === "poolMinScore" && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)) out.push("poolMinScore（须为 0–100 的数字）");
    else if (key === "userAgent" && (typeof value !== "string" || !value.trim() || value.length > 300)) out.push("userAgent（须为 1–300 字符的非空字符串）");
    else if (key === "publishedAtPath" && (typeof value !== "string" || !value.trim())) out.push("publishedAtPath（须为非空字段路径）");
    else if (key === "publishedAtPaths" && (!Array.isArray(value) || !value.every((p) => typeof p === "string" && p.trim()))) out.push("publishedAtPaths（须为字段路径数组）");
    else if (key === "excludePatterns" && (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([path, pattern]) => !path || typeof pattern !== "string"))) out.push("excludePatterns（须为字段路径到正则字符串的映射）");
    else if (key === "ingestNoiseFilter" && (!value || typeof value !== "object" || Array.isArray(value))) out.push("ingestNoiseFilter（须为对象）");
    else if ((KIND_VALUES[kind]?.[key] ?? VALUES[key])?.includes(String(value)) === false) out.push(`${key}=${String(value)}`);
    else if (NESTED[key] && value && typeof value === "object") {
      for (const [sub, nestedValue] of Object.entries(value)) {
        if (!NESTED[key]!.includes(sub)) out.push(`${key}.${sub}`);
        else if (key === "ingestNoiseFilter" && !Array.isArray(nestedValue)) out.push(`${key}.${sub}（须为字符串数组）`);
        else if (key === "ingestNoiseFilter" && !(nestedValue as unknown[]).every((v) => typeof v === "string" && v.trim())) out.push(`${key}.${sub}（须为字符串数组）`);
      }
    }
  }
  return out;
}

export class UnsupportedConfig extends Error {
  readonly statusCode = 400;
}

/** Refuses a config with entries its kind does not implement (admin create, edit and preview). */
export function assertSupportedConfig(kind: SourceRow["kind"], config: Record<string, unknown>): void {
  const bad = unsupportedConfig(kind, config);
  if (bad.length) throw new UnsupportedConfig(`不支持的配置项：${bad.join("、")}`);
}

/**
 * The shortest interval a source paid per listing may have (EveryInfra bills each listing call).
 * Mirrored by the sources_paid_interval_floor constraint (database/migrations/0048), so no writer
 * (the admin, a script, the nightly interval adaptation) can poll one faster.
 */
export function paidIntervalFloor(kind: SourceRow["kind"], config: Record<string, unknown>): number | null {
  if (kind === "mp_account" || config?.adapter === "everyinfra_xhs") return 720;
  if (config?.adapter === "everyinfra_x") return 360;
  return null;
}

export function assertPaidInterval(kind: SourceRow["kind"], config: Record<string, unknown>, intervalMinutes: number): void {
  const floor = paidIntervalFloor(kind, config);
  if (floor !== null && intervalMinutes < floor) throw new UnsupportedConfig(`按次付费的信源抓取间隔不能短于 ${floor} 分钟`);
}
