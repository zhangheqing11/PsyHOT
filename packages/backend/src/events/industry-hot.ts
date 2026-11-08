// The industry hot channel selects at most one report per recent story, without any model calls.
import { industryRoleScoringOn, ROLE_KEYS, TRACK_CATEGORIES } from "@aihot/contracts/taxonomy";
import { HOT, SELECTION } from "@aihot/industry/selection";
import { sql } from "../db.ts";
import { publishArticleTx } from "../publication/publish.ts";

export async function pickIndustryHot(at = new Date()): Promise<number> {
  if (!industryRoleScoringOn()) return 0;
  const rule = SELECTION.industryRoles.hot;
  return sql.begin(async (tx) => {
    // Serialize picks, including concurrent scheduler/rerun calls. Recording and republishing commit
    // together, so a failed publish cannot leave a permanent pick that was never released.
    await tx`SELECT pg_advisory_xact_lock(hashtext('industry_hot_picks'))`;
    const candidates = await tx<{ article_id: string; story_id: number; participants: number }[]>`
      WITH participants AS (
        SELECT ss.story_id, count(DISTINCT ss.participant_key)::int AS n
        FROM story_signals ss LEFT JOIN articles a ON a.id = ss.article_id
        WHERE a.duplicate_of IS NULL
          AND ss.observed_at > ${at}::timestamptz - make_interval(hours => ${HOT.windowHours}) AND ss.observed_at <= ${at}
        GROUP BY ss.story_id
        HAVING count(DISTINCT ss.participant_key) >= ${rule.minParticipants} AND bool_or(ss.kind = 'editorial')
      )
      SELECT DISTINCT ON (s.id) p.article_id, s.id AS story_id, participants.n AS participants
      FROM stories s JOIN participants ON participants.story_id = s.id
      JOIN publications p ON p.story_id = s.id
      JOIN articles a ON a.id = p.article_id
      JOIN analyses an ON an.id = p.analysis_id
      CROSS JOIN LATERAL (
        SELECT max((an.output->'roleScoring'->'values'->'roles'->r.key->>'rel')::int) AS max_rel
        FROM unnest(${[...ROLE_KEYS]}::text[]) AS r(key)
      ) relevance
      WHERE s.merged_into IS NULL
        AND s.first_report_at >= ${at}::timestamptz - make_interval(days => ${rule.recentDays}) AND s.first_report_at <= ${at}
        AND NOT EXISTS (SELECT 1 FROM industry_hot_picks picked WHERE picked.story_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM publications sp WHERE sp.story_id = s.id AND sp.selected)
        AND p.category = ANY(${TRACK_CATEGORIES.industry}::text[])
        AND NOT p.promotion AND p.visibility = 'public' AND p.eligible AND NOT p.selected AND a.duplicate_of IS NULL
        AND NOT EXISTS (SELECT 1 FROM editorial_overrides o WHERE o.article_id = p.article_id AND o.fields->'selected' = 'false'::jsonb)
        AND relevance.max_rel >= ${rule.minRel}
        AND (an.output->'roleScoring'->'values'->'nov'->>'score')::int >= ${rule.minNov}
      ORDER BY s.id, relevance.max_rel DESC, p.timeline_at, p.article_id`;
    let picked = 0;
    for (const c of candidates) {
      const inserted = await tx`
        INSERT INTO industry_hot_picks (article_id, story_id, participants, picked_at)
        VALUES (${c.article_id}, ${c.story_id}, ${c.participants}, ${at})
        ON CONFLICT DO NOTHING RETURNING article_id`;
      if (!inserted.length) continue;
      const publication = await publishArticleTx(tx, c.article_id, { now: at });
      if (!publication?.selected) {
        // A concurrent material/source/override change can still close the normal publication gate.
        await tx`DELETE FROM industry_hot_picks WHERE article_id = ${c.article_id}`;
        continue;
      }
      picked += 1;
    }
    return picked;
  });
}
