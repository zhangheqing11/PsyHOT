// Bounded, non-recursive citation discovery. Only already public WeChat reports seed this job;
// imported papers use the normal editorial pipeline and keep their actual publication time.
import { sql, type Db } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { describeError } from "../lib/error-text.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { queueProcessing } from "../jobs/content.ts";
import { upsertMaterial } from "./materials.ts";
import { extractPaperReferences, normalizePaperTitle, paperDoiFromUrl, paperPiiFromUrl, type PaperReference } from "./paper-references.ts";
import { resolvePaperReference, type PaperMetadata } from "./paper-metadata.ts";
import { journalAbstractIssue } from "./journal-abstract.ts";

const RETRY_HOURS = [6, 24, 72, 168, 336];

export async function discoverPaperReferences(limit = 20): Promise<number> {
  const rows = await sql<{ id: string; revision: number; body_text: string; body_html: string | null }[]>`
    SELECT a.id,a.revision,a.body_text,a.body_html FROM articles a
    JOIN sources s ON s.id=a.source_id JOIN publications p ON p.article_id=a.id
    LEFT JOIN paper_reference_scans r ON r.report_id=a.id
    WHERE s.kind='mp_account' AND s.enabled AND s.track IN ('academic','mixed')
      AND s.participation_mode='editorial' AND a.duplicate_of IS NULL AND coalesce(a.body_text,'') <> ''
      AND p.eligible AND p.visibility='public' AND NOT p.promotion
      AND a.discovered_at >= now()-interval '30 days'
      AND (r.report_id IS NULL OR r.input_revision <> a.revision)
    ORDER BY a.discovered_at DESC,a.id LIMIT ${Math.min(100, Math.max(1, limit))}`;
  let scanned = 0;
  for (const row of rows) {
    const refs = extractPaperReferences(row.body_text,row.body_html);
    scanned += await sql.begin(async (tx) => {
      const [current] = await tx`SELECT revision FROM articles WHERE id=${row.id} FOR UPDATE`;
      if (current?.revision !== row.revision) return 0;
      await tx`DELETE FROM paper_references WHERE report_id=${row.id} AND NOT (reference_key=ANY(${refs.map((r)=>r.key)}::text[]))`;
      for (const ref of refs) await tx`
        INSERT INTO paper_references (report_id,reference_key,input_revision,doi,title,pii)
        VALUES (${row.id},${ref.key},${row.revision},${ref.doi},${ref.title},${ref.pii})
        ON CONFLICT (report_id,reference_key) DO UPDATE SET title=EXCLUDED.title,input_revision=EXCLUDED.input_revision,updated_at=now()`;
      await tx`INSERT INTO paper_reference_scans (report_id,input_revision) VALUES (${row.id},${row.revision})
        ON CONFLICT (report_id) DO UPDATE SET input_revision=EXCLUDED.input_revision,scanned_at=now()`;
      return 1;
    });
  }
  return scanned;
}

async function knownDoi(db: Db, doi: string): Promise<string | null> {
  const [row] = await db`SELECT coalesce(a.duplicate_of,a.id) AS id FROM paper_doi_registry r
    JOIN articles a ON a.id=r.article_id WHERE r.doi=${doi}`;
  return row?.id ?? null;
}

async function storePaper(work: PaperMetadata, referenceId: number): Promise<{ id: string | null; stale?: boolean }> {
  return sql.begin(async (tx) => {
    const [current] = await tx`SELECT a.id FROM paper_references r JOIN articles a ON a.id=r.report_id
      JOIN sources s ON s.id=a.source_id JOIN publications p ON p.article_id=a.id
      WHERE r.id=${referenceId} AND r.input_revision=a.revision AND p.eligible AND p.visibility='public'
        AND NOT p.promotion AND a.duplicate_of IS NULL AND s.enabled AND s.participation_mode='editorial'
      FOR UPDATE OF a`;
    if (!current) return {id:null,stale:true};
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'paper-doi:'+work.doi},0))`;
    const publisherIds = [...new Set([...work.alternativeIds, work.doi.split('/')[1] ?? '', paperPiiFromUrl(work.url) ?? '']
      .map((s)=>s.replace(/[^a-z0-9]/gi,'').toUpperCase()).filter((s)=>/^S?[0-9X]{16,17}$/.test(s)))].sort();
    for (const pii of publisherIds) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'paper-pii:'+pii},0))`;
    const known = await knownDoi(tx,work.doi);
    if (known) return { id: known };
    const candidates = await tx<{ id: string;url:string;lookup_doi:string|null }[]>`
      SELECT DISTINCT a.id,a.url,l.doi AS lookup_doi FROM articles a JOIN sources s ON s.id=a.source_id
      LEFT JOIN abstract_lookups l ON l.article_id=a.id
      WHERE a.duplicate_of IS NULL AND s.first_party AND s.kind <> 'mp_account' AND s.tags @> ARRAY['期刊']::text[]
        AND (l.doi IS NULL OR lower(l.doi)=${work.doi})
        AND (lower(l.doi)=${work.doi} OR a.identity_key=ANY(${[identityKeyForUrl(work.url),identityKeyForUrl(`https://doi.org/${work.doi}`)]}::text[])
          OR regexp_replace(lower(a.url),'[^a-z0-9]','','g') LIKE ANY(${publisherIds.map((id)=>'%'+id.toLowerCase()+'%')}::text[])
          OR btrim(lower(regexp_replace(regexp_replace(a.title,'^[[](Articles?|Reviews?|Personal View|Comment|Correspondence|Editorial|News|Letters?)[]][[:space:]]*','','gi'),'[^[:alnum:]]+',' ','g')))=${normalizePaperTitle(work.title)})
        AND NOT EXISTS (SELECT 1 FROM paper_doi_registry d WHERE d.article_id=a.id AND d.doi<>${work.doi})
      LIMIT 10`;
    const matches=candidates.filter((a)=>(paperDoiFromUrl(a.url) ?? a.lookup_doi ?? work.doi)===work.doi);
    const direct=matches.filter((a)=>a.lookup_doi===work.doi || paperDoiFromUrl(a.url)===work.doi || publisherIds.includes(paperPiiFromUrl(a.url) ?? '') || identityKeyForUrl(a.url)===identityKeyForUrl(work.url));
    if (!direct.length && matches.length>1) throw new Error('题名匹配到多篇已入库论文，需核对 DOI');
    let id = direct[0]?.id ?? matches[0]?.id ?? null;
    if (id && work.abstract) {
      const [existing] = await tx`SELECT a.*,s.enabled,s.participation_mode,
        EXISTS(SELECT 1 FROM abstract_lookups l WHERE l.article_id=a.id AND l.found_at IS NOT NULL) AS identified
        FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.id=${id} FOR UPDATE OF a`;
      if (existing?.enabled && existing.participation_mode==='editorial' && journalAbstractIssue(existing.excerpt,{identified:existing.identified})) {
        const result=await upsertMaterial({sourceId:existing.source_id,url:existing.url,title:existing.title,
          excerpt:work.abstract,publishedAt:existing.published_at??work.publishedAt,via:'fetch'},tx);
        await tx`INSERT INTO abstract_lookups (article_id,doi,found_at,provider) VALUES (${id},${work.doi},now(),${work.abstractProvider})
          ON CONFLICT (article_id) DO UPDATE SET doi=EXCLUDED.doi,found_at=EXCLUDED.found_at,provider=EXCLUDED.provider,updated_at=now()`;
        if (result.revised) await queueProcessing(id,{db:tx});
      }
    }
    if (!id) {
      const [source] = await tx<{ id: string; enabled: boolean; participation_mode: string }[]>`
        SELECT id,enabled,participation_mode FROM sources WHERE first_party AND kind <> 'mp_account'
          AND tags @> ARRAY['期刊']::text[] AND lower(name)=lower(${work.journal})
        ORDER BY (kind='external'),id LIMIT 1`;
      if (source && (!source.enabled || source.participation_mode!=='editorial')) return { id:null };
      const sourceId = source?.id ?? `paper-journal-${sha256(work.issn ?? work.journal.toLowerCase()).slice(0,16)}`;
      if (!source) await tx`INSERT INTO sources
        (id,name,kind,tier,tags,track,first_party,site_fulltext,syndicate_fulltext,imported_from,config)
        VALUES (${sourceId},${work.journal},'external','T1',${['期刊','引用补收']},'academic',true,false,false,'paper-backfill',${tx.json({issn:work.issn})})
        ON CONFLICT (id) DO NOTHING`;
      const [active] = await tx`SELECT enabled,participation_mode FROM sources WHERE id=${sourceId}`;
      if (!active?.enabled || active.participation_mode!=='editorial') return {id:null};
      const result = await upsertMaterial({ sourceId,url:work.url,title:work.title,author:work.author,language:'en',
        publishedAt:work.publishedAt,excerpt:work.abstract,bodyStatus:'unconfirmed',via:'fetch',backfill:'paper-reference',
        raw:{paperBackfill:{doi:work.doi,issn:work.issn,metadataProvider:'crossref'}} },tx);
      id=result.articleId;
      if (work.abstract) await tx`INSERT INTO abstract_lookups (article_id,doi,found_at,provider)
        VALUES (${id},${work.doi},now(),${work.abstractProvider}) ON CONFLICT (article_id) DO NOTHING`;
      if (result.created || result.revised) await queueProcessing(id,{db:tx});
    }
    await tx`INSERT INTO paper_doi_registry (doi,article_id,publisher_ids) VALUES (${work.doi},${id},${publisherIds}) ON CONFLICT DO NOTHING`;
    return {id};
  });
}

/** Claim once before network I/O. An interrupted claim becomes due again without losing its citation. */
export async function resolveStoredPaperReference(id: number): Promise<boolean> {
  const [r] = await sql<({id:number;report_id:string;attempts:number} & PaperReference)[]>`
    UPDATE paper_references r SET attempts=r.attempts+1,next_try_at=now()+interval '15 minutes',updated_at=now()
    FROM articles a,sources s,publications p
    WHERE r.id=${id} AND r.report_id=a.id AND s.id=a.source_id AND p.article_id=a.id
      AND s.enabled AND s.kind='mp_account' AND s.participation_mode='editorial' AND s.track IN ('academic','mixed')
      AND a.duplicate_of IS NULL AND r.input_revision=a.revision AND p.eligible AND p.visibility='public' AND NOT p.promotion
      AND r.status<>'resolved' AND r.next_try_at<=now() AND r.attempts<${RETRY_HOURS.length}
    RETURNING r.id,r.report_id,r.reference_key AS key,r.doi,r.title,r.pii,r.attempts`;
  if (!r) return false;
  try {
    const existing = r.doi ? await knownDoi(sql,r.doi) : null;
    const work = existing ? null : await resolvePaperReference(r);
    const stored = existing ? {id:existing} : work ? await storePaper(work,id) : null;
    if (stored && 'stale' in stored && stored.stale) return false;
    if (stored?.id) {
      await sql`UPDATE paper_references SET paper_id=${stored.id},doi=coalesce(${work?.doi ?? null},doi),
        status='resolved',last_error=NULL,updated_at=now() WHERE id=${id}
          AND input_revision=(SELECT revision FROM articles WHERE id=paper_references.report_id)`;
      return true;
    }
    const status = stored ? 'paused' : 'not_found';
    await sql`UPDATE paper_references SET status=${status},attempts=attempts-${stored?1:0},
      last_error=${stored?'期刊信源已暂停':'未找到唯一可信的期刊论文元数据'},
      next_try_at=now()+make_interval(hours=>${stored?24:RETRY_HOURS[r.attempts-1]!}),updated_at=now() WHERE id=${id}`;
  } catch (error) {
    await sql`UPDATE paper_references SET status='failed',last_error=${describeError(error,500)},
      next_try_at=now()+make_interval(hours=>${RETRY_HOURS[r.attempts-1]!}),updated_at=now() WHERE id=${id}`;
  }
  return false;
}

export async function backfillReferencedPapers(): Promise<{scanned:number;tried:number;resolved:number}> {
  if (process.env.COLLECT_ENABLED==='false' || process.env.PAPER_BACKFILL_ENABLED==='false') return {scanned:0,tried:0,resolved:0};
  const scanned=await discoverPaperReferences();
  const refs=await sql<{id:number}[]>`SELECT r.id FROM paper_references r JOIN articles a ON a.id=r.report_id
    JOIN sources s ON s.id=a.source_id JOIN publications p ON p.article_id=a.id
    WHERE r.status<>'resolved' AND r.next_try_at<=now() AND r.attempts<${RETRY_HOURS.length}
      AND s.enabled AND s.kind='mp_account' AND s.track IN ('academic','mixed') AND s.participation_mode='editorial'
      AND p.eligible AND p.visibility='public' AND NOT p.promotion AND a.duplicate_of IS NULL AND r.input_revision=a.revision
    ORDER BY r.next_try_at,r.id LIMIT 10`;
  let resolved=0;
  for (const r of refs) if (await resolveStoredPaperReference(r.id)) resolved++;
  return {scanned,tried:refs.length,resolved};
}
