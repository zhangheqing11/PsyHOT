// Regroups the events of a window of articles with the current grouping rules.
//
//   node --env-file=.env scripts/regroup-events.ts plan --since 2026-10-01T00:00:00+08:00 --snapshot regroup.json [--signals-hours 48]
//   node --env-file=.env scripts/regroup-events.ts redirect --snapshot regroup.json [--snapshot earlier.json ...]
//   node --env-file=.env scripts/regroup-events.ts finish --snapshot regroup.json [--snapshot earlier.json ...]
//   node --env-file=.env scripts/regroup-events.ts consolidate --since 2026-10-01T00:00:00+08:00 [--dry-run]
//
// `plan` cancels the jobs of an earlier plan that have not run, records where every report of the
// window sits today, embeds the recall window within the embedding budget, marks the window's reports
// as waiting (regroup_pending: until its turn comes a report is not evidence for others, so the
// regroup in discovery order sees what live grouping would have seen) and sends one regroup job per
// article through the worker's serial events.group queue, behind live reports and live discussion
// posts. `redirect` merges stories that lost all their reports into the story most of them moved to
// (the old public id redirects there) once none of those reports is still waiting; run it while the
// regroup drains so old event pages keep working. `finish` waits for the jobs to drain, redirects
// what is left, asks for new digests, repairs the heat history of the hottest stories and publishes a
// new hot ranking. Give `redirect` and `finish` the snapshot of every plan since the last finish.
// `consolidate` applies the story consolidation of live grouping to the decisions made since a time:
// wherever a report was firmly tied to several stories, their roots are compared and the stories
// merge when both models see one story (`--dry-run` judges and prints without merging).
// Every step can be repeated.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { enqueue, getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { backfillStoryHeat, computeHotRanking } from "@aihot/backend/events/hot";
import { consolidate, warmRecallWindow } from "@aihot/backend/events/group";
import { firmlyTied } from "@aihot/backend/events/relate";
import { waitForOffPeak } from "@aihot/backend/lib/offpeak";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    since: { type: "string" }, snapshot: { type: "string", multiple: true }, "signals-hours": { type: "string", default: "48" },
    "dry-run": { type: "boolean", default: false }, now: { type: "boolean", default: false },
  },
});
const command = positionals[0];
const snapshots = values.snapshot?.length ? values.snapshot : ["regroup-snapshot.json"];

interface Snapshot {
  since: string;
  startedAt: string;
  articles: string[];
  signals: string[];
  /** Story of every report before the regroup (automatic memberships only). */
  previous: Record<string, number[]>;
}

async function regroupJobs(states: string[]): Promise<Array<{ id: string }>> {
  return sql<{ id: string }[]>`
    SELECT id FROM pgboss.job WHERE name = ${QUEUES.group} AND singleton_key LIKE 'regroup:%' AND state::text = ANY(${states})`;
}

async function plan() {
  if (!values.since) throw new Error("--since <ISO time> is required");
  const since = new Date(values.since);
  // An earlier plan's jobs that have not run are superseded; the one running finishes first.
  const waiting = await regroupJobs(["created", "retry"]);
  if (waiting.length) await (await getBoss()).cancel(QUEUES.group, waiting.map((j) => j.id));
  while ((await regroupJobs(["active"])).length) await new Promise((r) => setTimeout(r, 2_000));

  const articles = await sql<{ id: string }[]>`
    SELECT a.id FROM articles a
    JOIN sources s ON s.id = a.source_id
    JOIN LATERAL (SELECT relevance FROM analyses x WHERE x.article_id = a.id ORDER BY input_revision DESC, id DESC LIMIT 1) an ON true
    WHERE s.participation_mode = 'editorial' AND an.relevance = 'pass' AND a.discovered_at >= ${since}
    ORDER BY a.discovered_at, a.id`;
  const ids = articles.map((r) => r.id);
  const memberships = ids.length
    ? await sql<{ article_id: string; story_id: number }[]>`
        SELECT fa.article_id, f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id
        WHERE fa.article_id = ANY(${ids}) AND fa.role IN ('primary', 'report') AND NOT fa.manual AND f.story_id IS NOT NULL`
    : [];
  const previous: Record<string, number[]> = {};
  for (const m of memberships) (previous[m.article_id] ??= []).push(Number(m.story_id));
  const signalHours = Number(values["signals-hours"]);
  const signals = signalHours > 0
    ? (await sql<{ id: string }[]>`
        SELECT a.id FROM articles a JOIN sources s ON s.id = a.source_id
        WHERE s.participation_mode = 'hot_signal' AND a.discovered_at >= now() - make_interval(hours => ${signalHours})
        ORDER BY a.discovered_at, a.id`).map((r) => r.id)
    : [];
  const snapshot: Snapshot = { since: since.toISOString(), startedAt: new Date().toISOString(), articles: ids, signals, previous };
  writeFileSync(snapshots[0]!, JSON.stringify(snapshot));
  // Vectors for the whole recall window first, while every report still counts in it, so the serial
  // queue does not stall on them.
  const warmed = await warmRecallWindow((done, total) => { if (done % 1000 === 0 || done === total) console.log(`embedding ${done}/${total}`); });
  console.log(JSON.stringify({ warmed, cancelledJobs: waiting.length }));
  await sql`INSERT INTO regroup_pending (article_id) SELECT unnest(${[...ids, ...signals]}::text[]) ON CONFLICT (article_id) DO UPDATE SET requested_at = now()`;
  let sent = 0;
  for (const id of ids) if (await enqueue(QUEUES.group, { articleId: id, force: true }, { singletonKey: `regroup:${id}`, priority: -2 })) sent++;
  for (const id of signals) if (await enqueue(QUEUES.group, { articleId: id, signalOnly: true, force: true }, { singletonKey: `regroup:${id}`, priority: -3 })) sent++;
  console.log(JSON.stringify({ since: snapshot.since, articles: ids.length, signals: signals.length, previousMemberships: memberships.length, jobsSent: sent, snapshot: snapshots[0] }));
}

function loadSnapshots(): { previous: Record<string, number[]>; startedAt: Date } {
  const loaded = snapshots.map((file) => JSON.parse(readFileSync(file, "utf8")) as Snapshot);
  // Where every report sat before each plan: a story counts with the reports it had in any of them.
  const previous: Record<string, number[]> = {};
  for (const snap of loaded) for (const [articleId, storyIds] of Object.entries(snap.previous)) (previous[articleId] ??= []).push(...storyIds);
  return { previous, startedAt: new Date(Math.min(...loaded.map((snap) => new Date(snap.startedAt).getTime()))) };
}

/** Old stories whose reports all moved, once none of them is still waiting: redirected to where most of them went. */
async function redirectEmptied(previous: Record<string, number[]>) {
  const ids = Object.keys(previous);
  const current = ids.length
    ? await sql<{ article_id: string; story_id: number }[]>`
        SELECT fa.article_id, f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id
        WHERE fa.article_id = ANY(${ids}) AND fa.role IN ('primary', 'report') AND st.merged_into IS NULL`
    : [];
  const now = new Map<string, number>();
  for (const c of current) if (!now.has(c.article_id)) now.set(c.article_id, Number(c.story_id));
  const waiting = new Set(ids.length ? (await sql<{ article_id: string }[]>`SELECT article_id FROM regroup_pending WHERE article_id = ANY(${ids})`).map((r) => r.article_id) : []);
  const oldStories = new Map<number, string[]>();
  for (const [articleId, storyIds] of Object.entries(previous)) for (const s of new Set(storyIds)) (oldStories.get(s) ?? oldStories.set(s, []).get(s)!).push(articleId);
  let merged = 0, kept = 0, notYet = 0;
  for (const [oldId, articles] of oldStories) {
    const [st] = await sql<{ merged_into: number | null; public_id: string }[]>`SELECT merged_into, public_id FROM stories WHERE id = ${oldId}`;
    if (!st || st.merged_into) continue;
    if (articles.some((a) => waiting.has(a))) { notYet++; continue; }
    const [live] = await sql<{ n: number }[]>`
      SELECT count(*) AS n FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id WHERE f.story_id = ${oldId} AND fa.role IN ('primary', 'report')`;
    if (Number(live?.n ?? 0) > 0) { kept++; continue; }
    const votes = new Map<number, number>();
    for (const a of articles) { const s = now.get(a); if (s !== undefined && s !== oldId) votes.set(s, (votes.get(s) ?? 0) + 1); }
    const successor = [...votes.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    if (!successor) { kept++; continue; }
    await sql.begin(async (tx) => {
      await tx`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
               SELECT ${successor}, article_id, participant_key, source_id, kind, observed_at FROM story_signals WHERE story_id = ${oldId}
               ON CONFLICT (story_id, article_id) DO NOTHING`;
      await tx`DELETE FROM story_signals WHERE story_id = ${oldId}`;
      await tx`UPDATE facts SET story_id = ${successor}, updated_at = now() WHERE story_id = ${oldId}`;
      await tx`UPDATE stories SET merged_into = ${successor}, version = version + 1, updated_at = now() WHERE id = ${oldId}`;
      await tx`UPDATE stories SET version = version + 1, updated_at = now(),
                 latest_at = greatest(latest_at, (SELECT latest_at FROM stories WHERE id = ${oldId})),
                 first_report_at = least(first_report_at, (SELECT first_report_at FROM stories WHERE id = ${oldId}))
               WHERE id = ${successor}`;
      await tx`INSERT INTO story_aliases (public_id, story_id) VALUES (${st.public_id}, ${successor}) ON CONFLICT DO NOTHING`;
    });
    merged++;
  }
  return { oldStories: oldStories.size, merged, kept, notYet };
}

async function redirect() {
  console.log(JSON.stringify(await redirectEmptied(loadSnapshots().previous)));
}

async function finish() {
  const { previous, startedAt } = loadSnapshots();
  for (;;) {
    const pending = (await regroupJobs(["created", "retry", "active"])).length;
    if (pending === 0) break;
    console.log(`waiting: ${pending} regroup jobs pending`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  // A report whose job failed for good would stay out of recall: it keeps what it has and counts again.
  const stuck = await sql<{ article_id: string }[]>`DELETE FROM regroup_pending RETURNING article_id`;
  if (stuck.length) console.log(JSON.stringify({ stillWaiting: stuck.slice(0, 50).map((r) => r.article_id) }));
  const redirected = await redirectEmptied(previous);
  // Digests for every live story touched since the first plan that has more than one report.
  const touched = await sql<{ id: number }[]>`
    SELECT st.id FROM stories st WHERE st.merged_into IS NULL AND st.updated_at >= ${startedAt}
      AND (SELECT count(*) FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id WHERE f.story_id = st.id AND fa.role IN ('primary', 'report')) >= 2`;
  for (const t of touched) await enqueue(QUEUES.digest, { storyId: Number(t.id) }, { singletonKey: `story:${t.id}`, startAfter: 5 });
  // Heat history of the stories that matter for the ranking now; the hourly job keeps the rest going forward.
  const ranking = await computeHotRanking();
  const top = await sql<{ story_id: number }[]>`
    SELECT ss.story_id FROM story_signals ss JOIN stories st ON st.id = ss.story_id AND st.merged_into IS NULL
    WHERE ss.observed_at > now() - interval '48 hours'
    GROUP BY ss.story_id HAVING count(DISTINCT ss.participant_key) >= 2
    ORDER BY count(DISTINCT ss.participant_key) DESC LIMIT 30`;
  let repaired = 0;
  for (const t of top) repaired += await backfillStoryHeat(Number(t.story_id), 7 * 24);
  console.log(JSON.stringify({ ...redirected, stillWaiting: stuck.length, digestsQueued: touched.length, ranking, heatRowsRepaired: repaired }));
}

async function consolidateSince() {
  if (!values.since) throw new Error("--since <ISO time> is required");
  const dryRun = values["dry-run"] === true;
  // The latest decision of every report decided since then, in the order they were made.
  const rows = await sql<{ article_id: string; candidates: Array<{ id: number; relation?: string; confidence?: number }> | null }[]>`
    SELECT article_id, candidates FROM (
      SELECT DISTINCT ON (d.article_id) d.article_id, d.candidates, d.verdict, d.created_at
      FROM grouping_decisions d WHERE d.created_at >= ${new Date(values.since)} ORDER BY d.article_id, d.id DESC) x
    WHERE x.verdict IN ('same-fact', 'new-fact-in-story', 'new-story') ORDER BY x.created_at`;
  const printed = new Set<string>();
  let tiedReports = 0, merges = 0;
  for (const r of rows) {
    const tiedFacts = (r.candidates ?? []).filter((c) => firmlyTied(c.relation, c.confidence)).map((c) => Number(c.id));
    if (tiedFacts.length === 0) continue;
    const stories = await sql<{ story_id: number }[]>`
      SELECT DISTINCT story_id FROM facts WHERE story_id IS NOT NULL AND (id = ANY(${tiedFacts})
        OR id IN (SELECT fact_id FROM fact_articles WHERE article_id = ${r.article_id} AND role IN ('primary', 'report')))`;
    if (stories.length < 2) continue;
    tiedReports++;
    for (const c of await consolidate(stories.map((s) => Number(s.story_id)), { dryRun })) {
      const key = `${c.from}:${c.into}`;
      if (printed.has(key)) continue;
      printed.add(key);
      if (c.merge) merges++;
      console.log(JSON.stringify({ article: r.article_id, ...c }));
    }
  }
  console.log(JSON.stringify({ decisions: rows.length, tiedReports, pairsCompared: printed.size, merges, dryRun }));
}

try {
  // plan and consolidate start bulk model work (embeddings, regroup judgements): off-peak only.
  if (command === "plan" || (command === "consolidate" && !values["dry-run"])) await waitForOffPeak(`regroup-events ${command}`);
  if (command === "plan") await plan();
  else if (command === "redirect") await redirect();
  else if (command === "finish") await finish();
  else if (command === "consolidate") await consolidateSince();
  else throw new Error("usage: regroup-events.ts plan --since <time> --snapshot <file> | redirect|finish --snapshot <file> [--snapshot <file> ...] | consolidate --since <time> [--dry-run]");
} finally {
  await stopBoss();
  await closeDb();
}
