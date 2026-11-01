import { beijingDate, beijingTime, beijingWeekday, monthDay as engineMonthDay } from "@aihot/contracts/time";

export { beijingDate, beijingTime, beijingWeekday };

/**
 * "9月28日" of a calendar date (YYYY-MM-DD). A day of another year than `today` (Beijing, now by default) carries its
 * year, so last year's item is not read as this year's: "2026年12月31日".
 */
export function monthDay(date: string, today: string = beijingDate(Date.now())): string {
  return engineMonthDay(date, today);
}

export function dayLabel(date: string, today: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const base = `${m}月${d}日`;
  if (date === today) return `今天 · ${base}`;
  const diff = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000);
  if (diff === 1) return `昨天 · ${base}`;
  if (y !== Number(today.slice(0, 4))) return `${y}年${base}`;
  return base;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "刚刚";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} 天前`;
  return beijingDate(iso);
}

export function fullDateTime(iso: string): string {
  return `${beijingDate(iso)} ${beijingTime(iso)}`;
}

/** "9月24日 10:51" (Beijing), for lists that span days; the year comes first when it is not today's. */
export function monthDayTime(iso: string, today?: string): string {
  return `${monthDay(beijingDate(iso), today)} ${beijingTime(iso)}`;
}

/** "X：Ethan Mollick (@emollick)" → "Ethan Mollick"; other sources keep their name. */
export function shortSourceName(name: string): string {
  const m = /^X[:：]\s*(.+?)\s*\(@[^)]+\)\s*$/.exec(name);
  if (m) return m[1]!.replace(/（.*?）/g, "").trim();
  return name.replace(/（RSS）|（网页）|（API）/g, "").trim();
}

export function sourceInitial(name: string): string {
  const s = shortSourceName(name).replace(/^[^\p{L}\p{N}]+/u, "");
  return (s[0] ?? "A").toUpperCase();
}
