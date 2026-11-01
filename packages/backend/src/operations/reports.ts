// The Monday source-health report for the ops chat. It goes through the same gated channel as the
// alerts (off unless FEISHU_INTERNAL_ENABLED).
import { sql } from "../db.ts";
import { beijingDay, sendAlert } from "../notify/feishu.ts";

const pct = (a: number, b: number) => (b ? `${a >= b ? "+" : ""}${(((a - b) / b) * 100).toFixed(0)}%` : "—");
const n = (v: number) => v.toLocaleString("en-US");

// A source quiet for seven days is late only against its own rhythm: the median gap between the
// (Beijing) days it delivered something new to us. Delivery, not publication date: most of our journal
// feeds deliver a whole issue at once whose articles carry online dates spread over weeks, so dated by
// publication a monthly feed looks daily and reads as late between every two issues. A first import is
// one delivery (one discovery day) however far back its items were published.
// Chosen on production data, 2026-11-01 (site live since 2026-10-01; 15 daily snapshots over 14 days,
// checked source by source against the original sites and Crossref):
/** How far back deliveries are read. History is a month old, so this does not bind until 2026-12-30;
 * kept at the upstream value until there is enough history to measure a different one. */
export const RHYTHM_WINDOW_DAYS = 90;
/** Delivery days needed before a median gap means anything (three gaps). Three days instead changed
 * nothing among the late sources and only moved three thin ones out of "too little history". */
export const RHYTHM_MIN_DAYS = 4;
/** How many times its own median gap a source may stay quiet. At 5 the late list on 2026-11-01 held
 * three: the two stalled SAGE feeds that were missing new articles (10× and 8×) and one monthly whose
 * young history is a run of consecutive days (9×); 1–3 a day over the fortnight. At 4 a journal that
 * had simply published nothing joined them; 6 listed the same today but caught a stalled feed two days
 * later. Publication dates instead of deliveries listed five at 4×, four of them journals between issues. */
export const RHYTHM_MULTIPLE = 5;

export interface QuietSource {
  id: string;
  name: string;
  participation_mode: string;
  /** The newest delivery ever, window aside; null when the source never gave us anything. */
  last: Date | null;
  /** Delivery days inside the window. */
  evidence_days: number;
  /** Median days between those; null with fewer than two. */
  median_gap_days: number | null;
  /** Days since the newest of them; null when none is inside the window. */
  quiet_days: number | null;
}

/** How many times its own median gap a source has been quiet, or null while its history is too thin. */
export function rhythmMultiple(s: QuietSource): number | null {
  if (s.evidence_days < RHYTHM_MIN_DAYS || !s.median_gap_days || s.quiet_days === null) return null;
  return s.quiet_days / s.median_gap_days;
}

/**
 * Enabled sources older than a week with nothing new for seven days (an attributed rediscovery counts),
 * in four groups: editorial ones past their own rhythm (most overdue first), editorial ones that never
 * gave us anything, editorial ones whose history is too thin to judge, and hot-signal ones. Failing
 * sources are left to their own section; external and WeChat ones report on their own.
 */
export async function quietSources(now = Date.now()) {
  const since = new Date(now - 7 * 86400_000);
  const rhythmSince = new Date(now - RHYTHM_WINDOW_DAYS * 86400_000);
  const at = new Date(now);
  const rows = await sql<QuietSource[]>`
    WITH quiet AS (
      SELECT s.id, s.name, s.participation_mode FROM sources s
      WHERE s.enabled AND s.health <> 'failing' AND s.kind NOT IN ('external', 'mp_account')
        AND s.participation_mode IN ('editorial', 'hot_signal') AND s.created_at < ${since}
        AND NOT EXISTS (SELECT 1 FROM articles a WHERE a.source_id = s.id AND a.discovered_at >= ${since} AND a.discovered_at <= ${at})
        AND NOT EXISTS (SELECT 1 FROM article_discoveries d WHERE d.source_id = s.id AND d.discovered_at >= ${since} AND d.discovered_at <= ${at})
    ), delivered AS (
      SELECT a.source_id, a.discovered_at FROM articles a JOIN quiet q ON q.id = a.source_id WHERE a.discovered_at <= ${at}
      UNION ALL
      SELECT d.source_id, d.discovered_at FROM article_discoveries d JOIN quiet q ON q.id = d.source_id
        JOIN articles a ON a.id = d.article_id WHERE a.source_id <> d.source_id AND d.discovered_at <= ${at}
    ), days AS (
      SELECT DISTINCT source_id, (discovered_at AT TIME ZONE 'Asia/Shanghai')::date AS day FROM delivered WHERE discovered_at >= ${rhythmSince}
    ), gaps AS (
      SELECT source_id, day, day - lag(day) OVER (PARTITION BY source_id ORDER BY day) AS gap FROM days
    ), rhythm AS (
      SELECT source_id, count(*)::int AS evidence_days, max(day) AS last_day,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY gap) FILTER (WHERE gap IS NOT NULL) AS median_gap_days
      FROM gaps GROUP BY source_id
    ), latest AS (
      SELECT source_id, max(discovered_at) AS last FROM delivered GROUP BY source_id
    )
    SELECT q.id, q.name, q.participation_mode, l.last, coalesce(r.evidence_days, 0) AS evidence_days, r.median_gap_days,
      ((${at}::timestamptz AT TIME ZONE 'Asia/Shanghai')::date - r.last_day)::int AS quiet_days
    FROM quiet q LEFT JOIN rhythm r ON r.source_id = q.id LEFT JOIN latest l ON l.source_id = q.id
    ORDER BY l.last NULLS FIRST, q.name`;
  const editorial = rows.filter((s) => s.participation_mode === "editorial");
  return {
    overdue: editorial.flatMap((s) => { const times = rhythmMultiple(s); return times !== null && times > RHYTHM_MULTIPLE ? [{ s, times }] : []; })
      .sort((a, b) => b.times - a.times).map((x) => x.s),
    never: editorial.filter((s) => s.last === null),
    unknown: editorial.filter((s) => s.last !== null && rhythmMultiple(s) === null),
    // Bluesky and similar accounts pause for weeks as a matter of course (on 2026-11-01 all 22 that the
    // seven-day check had listed were just quiet people): counted, not listed one by one.
    hot: rows.filter((s) => s.participation_mode === "hot_signal"),
  };
}

/** One overdue source: its own numbers, so a reader can see why it is listed. */
export const rhythmText = (s: QuietSource) =>
  `近 ${s.quiet_days} 天没有新内容，平时约 ${Number(s.median_gap_days!.toFixed(1))} 天就有新内容（${Number(rhythmMultiple(s)!.toFixed(1))} 倍）`;

/** Monday 09:00: how the sources did over the last seven days. */
export async function sourceHealthWeekly(now = Date.now()) {
  const since = new Date(now - 7 * 86400_000);
  const before = new Date(now - 14 * 86400_000);
  const [[counts], [items], failing, quiet] = await Promise.all([
    sql<{ enabled: number; failing: number; degraded: number; added: number }[]>`
      SELECT count(*) FILTER (WHERE enabled)::int AS enabled,
             count(*) FILTER (WHERE enabled AND health = 'failing')::int AS failing,
             count(*) FILTER (WHERE enabled AND health = 'degraded')::int AS degraded,
             count(*) FILTER (WHERE created_at >= ${since})::int AS added
      FROM sources`,
    sql<{ week: number; prev: number; selected: number }[]>`
      SELECT count(*) FILTER (WHERE discovered_at >= ${since})::int AS week,
             count(*) FILTER (WHERE discovered_at >= ${before} AND discovered_at < ${since})::int AS prev,
             (SELECT count(*)::int FROM publications p WHERE p.selected AND p.visibility <> 'withdrawn' AND p.discovered_at >= ${since}) AS selected
      FROM articles WHERE discovered_at >= ${before}`,
    sql<{ name: string; fail_count: number; last_ok_at: Date | null; last_error: string | null }[]>`
      SELECT name, fail_count, last_ok_at, left(regexp_replace(last_error, '\s+', ' ', 'g'), 80) AS last_error FROM sources
      WHERE enabled AND health = 'failing' ORDER BY fail_count DESC LIMIT 10`,
    quietSources(now),
  ]);
  const { overdue, never, unknown, hot } = quiet;
  const lines = [
    `本周收录 ${n(items!.week)} 条（上周 ${n(items!.prev)}，${pct(items!.week, items!.prev)}），其中精选 ${n(items!.selected)} 条`,
    `在用信源 ${counts!.enabled} 个，本周新增 ${counts!.added} 个；抓取失败 ${counts!.failing} 个，不太稳定 ${counts!.degraded} 个`,
  ];
  if (failing.length) lines.push("", "抓取失败的信源（这些来源的新内容暂时收不到）：", ...failing.map((f) => `· ${f.name}：连续失败 ${f.fail_count} 次${f.last_ok_at ? `，上次成功 ${beijingDay(f.last_ok_at)}` : ""}${f.last_error ? `（${f.last_error}）` : ""}`));
  if (overdue.length) lines.push("", "超出自身更新节奏的信源（先对照原站，区分抓取方式失效与对方变慢）：", ...overdue.map((s) => `· ${s.name}：${rhythmText(s)}`));
  if (never.length) lines.push("", "建源一周以上、从未收到过内容的信源（多半是抓取或过滤配置问题）：", ...never.map((s) => `· ${s.name}`));
  if (unknown.length) {
    lines.push("", `另有 ${unknown.length} 个编辑信源 7 天没有新内容，但收到内容的日子不到 ${RHYTHM_MIN_DAYS} 天、判断不了节奏（多为首次导入后还没更新的月刊、季刊和政府栏目，留意即可）：`
      + unknown.map((s) => `${s.name}（最近 ${beijingDay(s.last!)}）`).join("、"));
  }
  if (hot.length) lines.push("", `热度信号信源 ${hot.length} 个 7 天没有新内容（个人账号停更是常态，不逐个列出；抓取失败见上）`);
  const followUp = failing.length || overdue.length || never.length;
  lines.push("", followUp ? "需要处理的话，把这条转给 AI；详情在后台“信源”与“运行”页。" : "没有需要处理的信源。");
  await sendAlert("📊 信源周报", lines);
  return { failing: failing.length, overdue: overdue.length, never: never.length, unknown: unknown.length, hot: hot.length };
}
