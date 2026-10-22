// Starred items live in the browser; this tells the page which ones are still public. A starred item
// stays available as long as its page does (rules.hasItemPage), whether or not it is in the lists.
import { sql } from "../db.ts";
import { hasItemPage } from "./rules.ts";

export async function itemAvailability(ids: string[]): Promise<Record<string, "public" | "summary-only" | "unavailable">> {
  const clean = [...new Set(ids.filter((id) => /^[a-zA-Z0-9_-]{1,80}$/.test(id)))].slice(0, 500);
  const out: Record<string, "public" | "summary-only" | "unavailable"> = {};
  for (const id of clean) out[id] = "unavailable";
  if (clean.length === 0) return out;
  const rows = await sql<{ id: string; visibility: string; source_mode: string }[]>`
    SELECT a.id, p.visibility, s.participation_mode AS source_mode
    FROM articles a JOIN publications p ON p.article_id = coalesce(a.duplicate_of, a.id)
    JOIN sources s ON s.id = p.source_id WHERE a.id IN ${sql(clean)}`;
  for (const r of rows) {
    if (!hasItemPage({ visibility: r.visibility, sourceMode: r.source_mode })) continue;
    out[r.id] = r.visibility === "summary-only" ? "summary-only" : "public";
  }
  return out;
}
