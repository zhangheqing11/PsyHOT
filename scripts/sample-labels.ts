// Puts a first sample of real items into the labelling queue (admin → 标注): half academic, half
// industry, weighted towards the borderline cases a threshold is decided on. Reads stored judgements
// only (no model calls); items already queued or labelled are skipped. Re-runnable.
//   node --env-file=.env scripts/sample-labels.ts [--n 150] [--days 30] [--dry-run]
// Per track: 40% near the threshold, 20% clearly selected, 20% clearly below, 10% promotions
// (industry only; academic takes more near-threshold items instead), 10% prefilter blocks. A short
// stratum is filled from the rest of that track. A blocked item of a mixed source has no track and
// counts as industry (mixed sources are mostly news about the field).
import { parseArgs } from "node:util";
import { closeDb } from "@aihot/backend/db";
import { isNear, labelCandidates, queueForLabel, type LabelCandidate } from "@aihot/backend/admin/labels";

const { values } = parseArgs({
  options: { n: { type: "string", default: "150" }, days: { type: "string", default: "30" }, "dry-run": { type: "boolean", default: false } },
});
const n = Number(values.n);
const now = new Date();
const candidates = await labelCandidates(new Date(now.getTime() - Number(values.days) * 86400_000), now);

const NEAR = 8;
const strata: Array<{ name: string; share: number; test: (c: LabelCandidate) => boolean }> = [
  { name: "near", share: 0.4, test: (c) => !c.promotion && c.relevance === "pass" && isNear(c, NEAR) },
  { name: "selected", share: 0.2, test: (c) => !c.promotion && c.selected && !isNear(c, NEAR) },
  { name: "below", share: 0.2, test: (c) => !c.promotion && !c.selected && c.relevance === "pass" && c.score !== null && !isNear(c, NEAR) },
  { name: "promotion", share: 0.1, test: (c) => c.promotion },
  { name: "blocked", share: 0.1, test: (c) => c.relevance === "block" },
];

const picked: Array<{ id: string; track: string; stratum: string }> = [];
for (const track of ["academic", "industry"] as const) {
  const pool = candidates.filter((c) => (c.track ?? "industry") === track);
  const want = track === "academic" ? Math.floor(n / 2) : n - Math.floor(n / 2);
  const taken = new Set<string>();
  for (const s of strata) {
    // Academic sources publish no promotions worth sampling: that share goes to the borderline.
    const share = track === "academic" ? (s.name === "promotion" ? 0 : s.name === "near" ? s.share + 0.1 : s.share) : s.share;
    for (const c of pool.filter((c) => s.test(c) && !taken.has(c.id)).slice(0, Math.round(want * share))) {
      taken.add(c.id);
      picked.push({ id: c.id, track, stratum: s.name });
    }
  }
  for (const c of pool.filter((c) => !taken.has(c.id) && c.relevance !== "unknown").slice(0, Math.max(0, want - taken.size))) {
    taken.add(c.id);
    picked.push({ id: c.id, track, stratum: "fill" });
  }
}

const counts: Record<string, number> = {};
for (const p of picked) counts[`${p.track}/${p.stratum}`] = (counts[`${p.track}/${p.stratum}`] ?? 0) + 1;
console.log(`${candidates.length} candidates in the last ${values.days} days; picked ${picked.length}`);
console.log(JSON.stringify(counts, null, 1));
if (!values["dry-run"]) console.log(`queued ${await queueForLabel(picked.map((p) => ({ id: p.id, queue: "sample" as const })))}`);
await closeDb();
