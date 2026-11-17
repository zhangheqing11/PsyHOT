import type { PaperLink } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { exportedPoolCondition } from "./items.ts";

/** Both directions use the public read gate; internal failed lookups and withdrawn items stay private. */
export async function loadPaperLinks(id: string, now = new Date()): Promise<PaperLink[]> {
  const rows = await sql<PaperLink[]>`
    WITH linked AS (
      SELECT coalesce(a.duplicate_of,a.id) AS target,'paper' AS relation FROM paper_references r
      JOIN articles a ON a.id=r.paper_id JOIN articles report ON report.id=r.report_id
      WHERE r.report_id=${id} AND r.status='resolved' AND r.input_revision=report.revision
      UNION
      SELECT coalesce(report.duplicate_of,report.id),'report' FROM paper_references r
      JOIN articles paper ON paper.id=r.paper_id JOIN articles report ON report.id=r.report_id
      WHERE coalesce(paper.duplicate_of,paper.id)=${id} AND r.status='resolved' AND r.input_revision=report.revision
    )
    SELECT DISTINCT p.article_id AS id,p.title,s.name AS source,l.relation
    FROM linked l JOIN publications p ON p.article_id=l.target JOIN sources s ON s.id=p.source_id
    WHERE ${exportedPoolCondition(now)} AND s.participation_mode='editorial' AND p.article_id<>${id}
    ORDER BY l.relation,p.title,p.article_id LIMIT 20`;
  return [...rows];
}
