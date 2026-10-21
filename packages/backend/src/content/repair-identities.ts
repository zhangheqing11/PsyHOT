// Repair signed-URL duplicates without deleting material, paid results or old bookmarks.
// Used after migrations and by the operator's audit command. No provider calls.
import { sql, type Db } from "../db.ts";
import { identityKeyForUrl, xhsNoteIdFromUrl } from "../lib/url.ts";
import { publishArticleTx } from "../publication/publish.ts";
import { backfillStoryHeat, computeHotRanking } from "../events/hot.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";

interface MaterialRow {
  id: string;
  url: string;
  identity_key: string;
  source_id: string;
  signal_group_id: string | null;
  discovered_at: Date;
  body_chars: number;
  summary_chars: number;
  eligible: boolean;
  manual: boolean;
  restricted: boolean;
  preserve_fragment: boolean;
}

async function groups(db: Db) {
  const rows = await db<MaterialRow[]>`
    SELECT a.id, a.url, a.identity_key, a.source_id, s.signal_group_id, a.discovered_at,
           length(coalesce(a.body_text, '')) AS body_chars, length(coalesce(p.summary, '')) AS summary_chars,
           coalesce(p.eligible, false) AS eligible, o.article_id IS NOT NULL AS manual,
           coalesce(o.visibility IN ('withdrawn', 'summary-only'), false) AS restricted,
           coalesce((s.config->>'preserveUrlFragment')::boolean, false) AS preserve_fragment
    FROM articles a JOIN sources s ON s.id = a.source_id
    LEFT JOIN publications p ON p.article_id = a.id LEFT JOIN editorial_overrides o ON o.article_id = a.id
    WHERE a.duplicate_of IS NULL`;
  const byKey = new Map<string, MaterialRow[]>();
  for (const row of rows) {
    // Preserve explicit source-specific keys (for example feed entry IDs). URL identities can
    // safely be reconciled through the exact same normalizer as live collection, across all sources.
    if (!xhsNoteIdFromUrl(row.url) && !row.identity_key.startsWith("url:")) continue;
    const key = identityKeyForUrl(row.url, { keepFragment: row.preserve_fragment });
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  return [...byKey].map(([identity, members]) => {
    // Respect manual restrictions first, then keep the best existing content, not the last token.
    members.sort((a, b) => Number(b.restricted) - Number(a.restricted) || Number(b.manual) - Number(a.manual) ||
      Number(b.eligible) - Number(a.eligible) || b.body_chars - a.body_chars || b.summary_chars - a.summary_chars ||
      a.discovered_at.getTime() - b.discovered_at.getTime() || a.id.localeCompare(b.id));
    return { identity, members };
  });
}

export async function auditMaterialIdentities() {
  return (await groups(sql)).filter((g) => g.members.length > 1 || g.members[0]!.identity_key !== g.identity)
    .map(({ identity, members }) => ({
      identity, keep: members[0]!.id, duplicates: members.slice(1).map((m) => m.id),
      sources: [...new Set(members.map((m) => m.source_id))],
    }));
}

export async function repairMaterialIdentities(): Promise<{ normalized: number; duplicates: number; stories: number[] }> {
  return sql.begin(async (tx) => {
    // Serialise repairs and collection: no new signed link can enter between the scan and rename.
    await tx`LOCK TABLE articles IN SHARE ROW EXCLUSIVE MODE`;
    let normalized = 0;
    let duplicates = 0;
    const affected = new Set<number>();
    for (const { identity, members } of await groups(tx)) {
      const [keep, ...aliases] = members as [MaterialRow, ...MaterialRow[]];
      if (aliases.length === 0) {
        if (keep.identity_key !== identity) {
          await tx`UPDATE articles SET identity_key = ${identity} WHERE id = ${keep.id}`;
          normalized += 1;
        }
        continue;
      }
      const ids = members.map((m) => m.id);
      const aliasIds = aliases.map((m) => m.id);
      const memberships = await tx`SELECT * FROM fact_articles WHERE article_id = ANY(${ids}::text[])`;
      const signals = await tx<{ story_id: number; observed_at: Date }[]>`
        SELECT story_id, min(observed_at) AS observed_at FROM story_signals
        WHERE article_id = ANY(${ids}::text[]) GROUP BY story_id`;
      const facts = await tx<{ story_id: number }[]>`
        SELECT DISTINCT f.story_id FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id
        WHERE fa.article_id = ANY(${ids}::text[]) AND f.story_id IS NOT NULL`;
      for (const f of [...facts, ...signals]) affected.add(Number(f.story_id));

      // A richer copy discovered before a later repair may become the new survivor. Flatten any
      // earlier aliases so old bookmarks never acquire a chain of withdrawn intermediate rows.
      await tx`UPDATE articles SET duplicate_of = ${keep.id} WHERE duplicate_of = ANY(${aliasIds}::text[])`;
      await tx`UPDATE articles SET duplicate_of = ${keep.id}, identity_key = 'duplicate:' || id,
                   processing_state = 'skipped', processing_retry_at = NULL, processing_queued_at = NULL
               WHERE id = ANY(${aliasIds}::text[])`;
      await tx`UPDATE articles SET identity_key = ${identity} WHERE id = ${keep.id}`;
      await tx`INSERT INTO article_discoveries (article_id, source_id, via, discovered_at)
        SELECT ${keep.id}, source_id, via, min(discovered_at) FROM article_discoveries
        WHERE article_id = ANY(${ids}::text[]) GROUP BY source_id, via
        ON CONFLICT (article_id, source_id, via) DO UPDATE
          SET discovered_at = least(article_discoveries.discovered_at, EXCLUDED.discovered_at)`;

      // Keep all memberships, including mentions and manual placements; one report per fact.
      await tx`INSERT INTO fact_articles (fact_id, article_id, role, evidence, manual, created_at)
        SELECT DISTINCT ON (fact_id) fact_id, ${keep.id}, role, evidence, manual, created_at
        FROM fact_articles WHERE article_id = ANY(${ids}::text[])
        ORDER BY fact_id, manual DESC, (role = 'primary') DESC, (role = 'report') DESC, created_at
        ON CONFLICT (fact_id, article_id) DO UPDATE SET
          role = CASE WHEN fact_articles.role = 'primary' OR EXCLUDED.role = 'primary' THEN 'primary'
                      WHEN fact_articles.role = 'report' OR EXCLUDED.role = 'report' THEN 'report' ELSE 'mention' END,
          manual = fact_articles.manual OR EXCLUDED.manual,
          evidence = coalesce(fact_articles.evidence, EXCLUDED.evidence),
          created_at = least(fact_articles.created_at, EXCLUDED.created_at)`;
      await tx`DELETE FROM fact_articles WHERE article_id = ANY(${aliasIds}::text[])`;
      // All search entrances are discoveries of one note, not independent editorial participants.
      await tx`DELETE FROM story_signals WHERE article_id = ANY(${ids}::text[])`;
      for (const signal of signals) {
        const key = keep.signal_group_id ? `group:${keep.signal_group_id}` : `source:${keep.source_id}`;
        await tx`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
          SELECT ${signal.story_id}, ${keep.id}, ${key}, ${keep.source_id},
                 CASE WHEN s.participation_mode = 'editorial' THEN 'editorial' ELSE 'signal' END, ${signal.observed_at}
          FROM sources s WHERE s.id = ${keep.source_id} AND s.participation_mode <> 'isolated'`;
      }
      await tx`DELETE FROM regroup_pending WHERE article_id = ANY(${aliasIds}::text[])`;
      // Normal projection and ledger logic removes aliases from every public exit and sync client.
      for (const id of aliasIds) await publishArticleTx(tx, id);
      await publishArticleTx(tx, keep.id);
      await tx`INSERT INTO audit_log (actor, action, subject, reason, before, after)
        VALUES ('material-identity-repair', 'material.deduplicate', ${identity},
          'Canonical URL aliases or overlapping collection entrances refer to one material',
          ${tx.json({ members, memberships, signals } as never)}, ${tx.json({ keep: keep.id, aliases: aliasIds } as never)})`;
      normalized += Number(keep.identity_key !== identity);
      duplicates += aliases.length;
    }
    const stories = [...affected];
    if (stories.length) {
      // Hide invalid snapshots immediately; rebuild from the surviving evidence below.
      await tx`UPDATE hot_rankings SET published = false WHERE published`;
      await tx`UPDATE stories SET digest = NULL, latest = NULL, digest_updated_at = NULL,
        first_report_at = (SELECT min(observed_at) FROM story_signals ss WHERE ss.story_id = stories.id),
        latest_at = (SELECT max(observed_at) FROM story_signals ss WHERE ss.story_id = stories.id)
        WHERE id = ANY(${stories}::bigint[])`;
      await tx`INSERT INTO material_identity_repairs (story_ids) VALUES (${stories}::bigint[])`;
    }
    return { normalized, duplicates, stories };
  }) as Promise<{ normalized: number; duplicates: number; stories: number[] }>;
}

/** Durable, retryable rebuild. The only queued model work is the existing corrected-digest job. */
export async function rebuildMaterialIdentityRepairs(): Promise<{ rebuilt: number }> {
  const pending = await sql<{ id: number; story_ids: number[] }[]>`
    SELECT id, story_ids FROM material_identity_repairs WHERE rebuilt_at IS NULL ORDER BY id`;
  if (!pending.length) return { rebuilt: 0 };
  const stories = [...new Set(pending.flatMap((r) => r.story_ids.map(Number)))];
  // A zero-signal story has no row in heatRows: delete its old points too.
  await sql`DELETE FROM story_heat_hourly WHERE story_id = ANY(${stories}::bigint[])`;
  for (const id of stories) await backfillStoryHeat(id);
  await computeHotRanking(); // combined, academic and industry together, using the same evidence
  for (const storyId of stories) {
    await enqueue(QUEUES.digest, { storyId, afterCorrection: true }, { singletonKey: `story:${storyId}` });
  }
  await sql`UPDATE material_identity_repairs SET rebuilt_at = now() WHERE id = ANY(${pending.map((r) => r.id)}::bigint[])`;
  return { rebuilt: stories.length };
}
