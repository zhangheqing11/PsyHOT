// Read-only coverage by publication timeline week (Monday, Asia/Shanghai).
// Includes the current partial week and the preceding --weeks - 1 weeks; unlabelled is separate
// from explicitly empty roles (none). Multi-role items count once for each role.
import { parseArgs } from "node:util";
import { CATEGORIES, PRACTITIONER_ROLES } from "@aihot/industry/taxonomy";
import { closeDb, sql } from "@aihot/backend/db";

const { values } = parseArgs({ options: { weeks: { type: "string", default: "4" } } });
const weeks = Number(values.weeks);
if (!Number.isInteger(weeks) || weeks < 1) throw new Error("--weeks must be a positive integer");
const categories = CATEGORIES.filter((c) => c.track === "industry").map((c) => c.key);
const rows = await sql`
  WITH weeks AS (
    SELECT generate_series(date_trunc('week', now() AT TIME ZONE 'Asia/Shanghai') - (${weeks} - 1) * interval '1 week',
                           date_trunc('week', now() AT TIME ZONE 'Asia/Shanghai'), interval '1 week') AS week
  ), items AS (
    SELECT date_trunc('week', p.timeline_at AT TIME ZONE 'Asia/Shanghai') AS week, p.selected, p.score, an.output
    FROM publications p JOIN analyses an ON an.id = p.analysis_id
    WHERE p.visibility = 'public' AND NOT p.promotion AND p.category = ANY(${categories}::text[])
      AND p.timeline_at >= (SELECT min(week) AT TIME ZONE 'Asia/Shanghai' FROM weeks) AND p.timeline_at <= now()
  ), expanded AS (
    SELECT i.*, r.role FROM items i CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN NOT coalesce(i.output ? 'roles', false) THEN '["unlabelled"]'::jsonb
           WHEN i.output->'roles' = '[]'::jsonb THEN '["none"]'::jsonb ELSE i.output->'roles' END) r(role)
  )
  SELECT to_char(w.week, 'YYYY-MM-DD') AS week, r.role, count(e.role)::int AS total,
         count(e.role) FILTER (WHERE e.selected)::int AS selected,
         count(e.role) FILTER (WHERE e.score BETWEEN 50 AND 79 AND NOT e.selected)::int AS pool_50_79
  FROM weeks w CROSS JOIN unnest(${[...PRACTITIONER_ROLES.map((r) => r.key), "none"]}::text[]) r(role)
  LEFT JOIN expanded e ON e.week = w.week AND e.role = r.role
  GROUP BY w.week, r.role
  UNION ALL
  SELECT '全部周', 'unlabelled', count(*)::int, count(*) FILTER (WHERE selected)::int,
         count(*) FILTER (WHERE score BETWEEN 50 AND 79 AND NOT selected)::int
  FROM items WHERE NOT coalesce(output ? 'roles', false)
  ORDER BY week, role`;
const labels: Record<string, string> = { ...Object.fromEntries(PRACTITIONER_ROLES.map((r) => [r.key, r.label])), none: "无角色", unlabelled: "未标注" };
console.table(rows.map((r) => ({ ...r, label: labels[r.role] })));
await closeDb();
