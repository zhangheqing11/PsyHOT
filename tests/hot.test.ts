// The psychology hot rule (industry/selection.ts HOT): a story enters with two independent
// participants, or with one when it was selected; heat is the story's best score times its decayed
// participants, over a window longer than two days.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { HOT } from "@aihot/industry/selection";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { setVisibility } from "@aihot/backend/admin/content";
import { combinedSelection, computeHotRanking, hotCandidates, rankByHeat } from "@aihot/backend/events/hot";
import { latestHotRanking, type HotEntry } from "@aihot/backend/events/hot-read";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle, republishSource } from "@aihot/backend/publication/publish";
import { loadStoryDetail } from "@aihot/backend/publication/stories";

const T = tag();
const SOURCE = `test-hot-${T}`;
const BODY = `HOT-BODY-${T} `.repeat(40);

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test hot', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await stopBoss();
  try {
    await sql`DELETE FROM hot_rankings WHERE entries @> ${sql.json([{ title: `HOT-${T}` }])}`;
    await sql`DELETE FROM articles WHERE source_id LIKE ${`%${T}%`}`;
    await sql`DELETE FROM facts WHERE story_id IN (SELECT id FROM stories WHERE title = ${`HOT-${T}`})`;
    await sql`DELETE FROM stories WHERE title = ${`HOT-${T}`}`;
    await sql`DELETE FROM sources WHERE id LIKE ${`%${T}%`}`;
  } finally { await closeDb(); }
});

let n = 0;
/** A story whose reports come from `participants` independent participants, last seen `hoursAgo`. */
async function story(o: { participants: number; score: number; selected: boolean; hoursAgo: number; raw?: Record<string, unknown>; sources?: string[] }): Promise<number> {
  const [st] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${`HOT-${T}`}, now() - make_interval(hours => ${o.hoursAgo}), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`fact-${randomUUID()}`}, ${st!.id}, ${`HOT-${T}`}) RETURNING id`;
  for (let i = 0; i < o.participants; i++) {
    n += 1;
    const sourceId = o.sources?.[i] ?? SOURCE;
    const { articleId } = await upsertMaterial({
      sourceId, url: `https://example.com/hot-${T}-${n}`, title: `Hot ${n}`, bodyText: BODY, bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
    } as never);
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
              VALUES (${articleId}, 1, 'rule', 'pass', 'research', ${`热点${n}-${T}`}, ${`摘要${n}`}, '理由', ${o.score}, ${o.selected})`;
    if (o.raw) await sql`UPDATE articles SET raw = ${sql.json(o.raw as never)} WHERE id = ${articleId}`;
    await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${articleId}, 'report')`;
    await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
              VALUES (${st!.id}, ${articleId}, ${`participant-${T}-${n}`}, ${sourceId}, 'editorial', now() - make_interval(hours => ${o.hoursAgo}))`;
  }
  return Number(st!.id);
}

test("one selected report enters, an unselected one needs a second participant; the better and fresher rank higher", async () => {
  const best = await story({ participants: 1, score: 90, selected: true, hoursAgo: 1 });
  const covered = await story({ participants: 2, score: 40, selected: false, hoursAgo: 1 });
  const good = await story({ participants: 1, score: 70, selected: true, hoursAgo: 1 });
  const older = await story({ participants: 1, score: 90, selected: true, hoursAgo: HOT.windowHours - 24 });
  const alone = await story({ participants: 1, score: 40, selected: false, hoursAgo: 1 });
  const expired = await story({ participants: 1, score: 90, selected: true, hoursAgo: HOT.windowHours + 24 });

  const ranked = (await hotCandidates(new Date())).map((r) => Number(r.story_id));
  const at = (id: number) => ranked.indexOf(id);
  assert.ok(at(alone) < 0, "one unselected report is not hot");
  assert.ok(at(expired) < 0, "a report before the window is not counted");
  for (const id of [best, covered, good, older]) assert.ok(at(id) >= 0, `story ${id} is a candidate`);
  assert.ok(at(best) < at(covered) && at(covered) < at(good), "two sources outweigh a lower score; a higher score outranks a lower one");
  assert.ok(at(good) < at(older), "heat decays with age");
});

test("republishing a demoted source changes its old heat records and reporting names; promotion restores only eligible reports", async () => {
  const demoted = `test-demoted-${T}`;
  const name = `Demoted source ${T}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
            VALUES (${demoted}, ${name}, 'rss', 'T1', 'editorial', '2100-01-01')`;
  const mixed = await story({ participants: 2, score: 100, selected: false, hoursAgo: 0, sources: [SOURCE, demoted] });
  const only = await story({ participants: 2, score: 100, selected: false, hoursAgo: 0, sources: [demoted, demoted] });
  const ranking = async () => {
    const { id } = await computeHotRanking();
    const [row] = await sql<{ entries: HotEntry[] }[]>`SELECT entries FROM hot_rankings WHERE id = ${id}`;
    return row!.entries.find((e) => Number(e.storyId) === mixed);
  };
  assert.ok((await ranking())?.sourceNames.includes(name));
  await sql`UPDATE sources SET participation_mode = 'hot_signal' WHERE id = ${demoted}`;
  await republishSource(demoted);
  const rows = await sql<{ kind: string }[]>`SELECT kind FROM story_signals WHERE source_id = ${demoted}`;
  assert.ok(rows.length > 0 && rows.every((r) => r.kind === 'signal'));
  const entry = await ranking();
  assert.ok(entry, "a real reporter plus a signal still ranks");
  assert.equal(entry.sourceNames.includes(name), false);
  assert.ok(entry.participants.some((p) => p.name === name && p.kind === 'signal'));
  assert.equal((await hotCandidates(new Date())).some((r) => Number(r.story_id) === only), false, "signals alone are not reporting");

  // The source may already have been republished by an older release: only the heat record is stale.
  await sql`UPDATE story_signals SET kind = 'editorial' WHERE source_id = ${demoted}`;
  const repaired = await republishSource(demoted);
  assert.equal(repaired.reduced, 0);
  assert.ok(repaired.signalsChanged > 0, "the worker must re-rank even when no publication changed");
  assert.equal((await republishSource(demoted)).signalsChanged, 0, "repeating the repair is harmless");

  const [invalid] = await sql<{ article_id: string }[]>`SELECT article_id FROM story_signals WHERE source_id = ${demoted} LIMIT 1`;
  await sql`UPDATE analyses SET relevance = 'block' WHERE article_id = ${invalid!.article_id}`;
  await sql`UPDATE sources SET participation_mode = 'editorial' WHERE id = ${demoted}`;
  await republishSource(demoted);
  const restored = await sql<{ kind: string; eligible: boolean }[]>`
    SELECT ss.kind, p.eligible FROM story_signals ss JOIN publications p ON p.article_id = ss.article_id WHERE ss.source_id = ${demoted}`;
  assert.ok(restored.some((r) => !r.eligible));
  for (const row of restored) assert.equal(row.kind, row.eligible ? 'editorial' : 'signal');
});

test("likes, saves, comments and shares weigh a participant up to a cap, never in place of a second one", async () => {
  const plain = await story({ participants: 1, score: 80, selected: true, hoursAgo: 2 });
  const liked = await story({ participants: 1, score: 80, selected: true, hoursAgo: 2, raw: { like_count: 120, collect_count: 40, comment_count: 10, share_count: 5 } });
  const viral = await story({ participants: 1, score: 80, selected: true, hoursAgo: 2, raw: { like_count: 5_000_000, collect_count: 900_000 } });
  const junk = await story({ participants: 1, score: 80, selected: true, hoursAgo: 2, raw: { like_count: "很多", share_count: -3 } });
  const lonely = await story({ participants: 1, score: 40, selected: false, hoursAgo: 2, raw: { like_count: 100_000 } });
  const rows = new Map((await hotCandidates(new Date())).map((r) => [Number(r.story_id), Number(r.heat)]));
  const heat = (id: number) => rows.get(id)!;
  // 120 + 2×40 + 3×10 + 3×5 = 245 → weight 1 + log10(246) / scale.
  assert.ok(Math.abs(heat(liked) / heat(plain) - (1 + Math.log10(246) / HOT.engagement.scale)) < 1e-6);
  assert.ok(Math.abs(heat(viral) / heat(plain) - HOT.engagement.maxWeight) < 1e-6, "capped");
  assert.ok(Math.abs(heat(junk) / heat(plain) - 1) < 1e-6, "counts that are not numbers, or below zero, add nothing");
  assert.equal(rows.has(lonely), false, "engagement does not stand in for a second participant");
});

test("six-hour comparison includes participants that expired from the current window", async () => {
  const id = await story({ participants: 3, score: 100, selected: false, hoursAgo: 12 });
  const at = new Date();
  const signals = await sql<{ article_id: string }[]>`SELECT article_id FROM story_signals WHERE story_id = ${id} ORDER BY article_id`;
  await sql`UPDATE story_signals SET observed_at = ${new Date(at.getTime() - 12 * 3600000)} WHERE story_id = ${id}`;
  await sql`UPDATE story_signals SET observed_at = ${new Date(at.getTime() - (HOT.windowHours + 3) * 3600000)}
            WHERE story_id = ${id} AND article_id = ${signals[2]!.article_id}`;
  await sql`UPDATE sources SET last_ok_at = ${at} WHERE id = ${SOURCE}`;

  const row = (await hotCandidates(at)).find((r) => Number(r.story_id) === id)!;
  const expectedPrevious = 2 * 0.5 ** (6 / HOT.halfLifeHours) + 0.5 ** ((HOT.windowHours - 3) / HOT.halfLifeHours);
  assert.ok(Math.abs(Number(row.heat_prev) - expectedPrevious) < 1e-9, "heat_prev includes the participant still in the window six hours ago");
  assert.equal(Number(row.participants), 2);
  assert.ok(Math.abs(Number(row.heat) - 2 * 0.5 ** (12 / HOT.halfLifeHours)) < 1e-9);
  assert.deepEqual([Number(row.recent6h), Number(row.editorial_participants), Number(row.signal_participants), Number(row.behind_participants)], [0, 2, 0, 0]);

  const ranking = await computeHotRanking(at);
  const [saved] = await sql<{ entries: HotEntry[] }[]>`SELECT entries FROM hot_rankings WHERE id = ${ranking.id}`;
  assert.equal(saved!.entries.find((e) => Number(e.storyId) === id)?.trend, "down", "losing the expired participant is a decline, not flat heat");
});

test("previous-window reports do not change the current participant's weight, kind, first sighting or collection status", async () => {
  const stale = `test-hot-stale-${T}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
            VALUES (${stale}, ${stale}, 'rss', 'T1', 'hot_signal', '2100-01-01')`;
  const id = await story({ participants: 3, score: 80, selected: true, hoursAgo: 12 });
  const at = new Date();
  const signals = await sql<{ article_id: string; participant_key: string }[]>`
    SELECT article_id, participant_key FROM story_signals WHERE story_id = ${id} ORDER BY article_id`;
  await sql`UPDATE story_signals SET observed_at = ${new Date(at.getTime() - 2 * 3600000)}, kind = 'signal'
            WHERE story_id = ${id} AND article_id = ${signals[0]!.article_id}`;
  await sql`UPDATE story_signals SET observed_at = ${new Date(at.getTime() - 12 * 3600000)}
            WHERE story_id = ${id} AND article_id = ${signals[1]!.article_id}`;
  await sql`UPDATE story_signals SET observed_at = ${new Date(at.getTime() - (HOT.windowHours + 3) * 3600000)},
              participant_key = ${signals[0]!.participant_key}, source_id = ${stale}
            WHERE story_id = ${id} AND article_id = ${signals[2]!.article_id}`;
  await sql`UPDATE articles SET raw = ${sql.json({ like_count: 5_000_000 })} WHERE id = ${signals[2]!.article_id}`;

  const row = (await hotCandidates(at, [stale])).find((r) => Number(r.story_id) === id)!;
  assert.ok(Math.abs(Number(row.heat) - 0.8 * (0.5 ** (12 / HOT.halfLifeHours) + 0.5 ** (2 / HOT.halfLifeHours))) < 1e-9,
    "expired engagement must not increase current heat");
  assert.deepEqual([Number(row.participants), Number(row.recent6h), Number(row.editorial_participants), Number(row.signal_participants), Number(row.behind_participants)],
    [2, 1, 1, 1, 0], "only current reports define current participant attributes");
});

test("withdrawing a non-representative report removes its heat and faces, queues a digest once, and restoration brings it back", async () => {
  const sources = ["A", "B", "C"].map((name) => `test-hot-withdraw-${T}-${name}`);
  for (const source of sources) await sql`
    INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, last_ok_at, next_fetch_at)
    VALUES (${source}, ${source}, 'rss', 'T1', 'editorial', ${source === sources[0]}, now(), '2100-01-01')`;
  const id = await story({ participants: 3, score: 100, selected: false, hoursAgo: 1, sources });
  const articles = await sql<{ article_id: string; source_id: string }[]>`SELECT article_id, source_id FROM story_signals WHERE story_id = ${id}`;
  for (const a of articles) await publishArticle(a.article_id, { releasedAt: new Date(Date.now() - 60000) });
  const b = articles.find((a) => a.source_id === sources[1])!.article_id;
  await sql`UPDATE sources SET last_ok_at = NULL WHERE id = ${sources[1]!}`;
  await computeHotRanking();
  const before = (await latestHotRanking())!;
  const original = before.entries.find((e) => Number(e.storyId) === id)!;
  assert.equal(original.participantCount, 3);
  assert.notEqual(original.representativeItemId, b);
  assert.equal((await loadStoryDetail(id))!.whyHot.participantsInWindow, 3);
  assert.equal((await loadStoryDetail(id))!.whyHot.observationComplete, false);

  await setVisibility(b, { visibility: "withdrawn", reason: "test withdrawal", version: 0 }, "test");
  const withdrawn = (await latestHotRanking())!;
  assert.ok(withdrawn.id > before.id, "a non-representative withdrawal recomputes the ranking immediately");
  const reduced = withdrawn.entries.find((e) => Number(e.storyId) === id)!;
  assert.equal(reduced.participantCount, 2, "the withdrawn participant no longer contributes");
  assert.ok(reduced.heat < original.heat, "the withdrawn report adds no heat");
  assert.equal(reduced.sourceCount, 2);
  assert.equal(reduced.participants.some((p) => p.name === sources[1]), false);
  assert.equal(reduced.sourceNames.includes(sources[1]!), false);
  const why = (await loadStoryDetail(id))!.whyHot;
  assert.deepEqual([why.participantsInWindow, why.newParticipants6h, why.recentReports24h], [2, 2, 2]);
  assert.equal(why.observationComplete, true, "a withdrawn source does not make observation incomplete");
  const jobs = await sql<{ data: { storyId: number; afterCorrection: boolean } }[]>`
    SELECT data FROM pgboss.job WHERE name = ${QUEUES.digest} AND singleton_key = ${`story:${id}:correction`}`;
  assert.equal(jobs.length, 1, "one pending correction digest is queued for the story");
  assert.deepEqual(jobs[0]!.data, { storyId: id, afterCorrection: true });
  assert.equal((await sql`SELECT article_id FROM story_signals WHERE story_id = ${id}`).length, 3, "withdrawal retains the original signals");

  await setVisibility(b, { visibility: "withdrawn", reason: "same visibility", version: 1 }, "test");
  assert.equal((await latestHotRanking())!.id, withdrawn.id, "unchanged visibility does not recompute heat");
  await setVisibility(b, { visibility: "public", reason: "restore", version: 2 }, "test");
  const restored = (await latestHotRanking())!.entries.find((e) => Number(e.storyId) === id)!;
  assert.equal(restored.participantCount, 3);
  assert.ok(restored.heat > reduced.heat);
  assert.ok(restored.participants.some((p) => p.name === sources[1]));
  assert.equal((await loadStoryDetail(id))!.whyHot.participantsInWindow, 3);
  assert.equal((await sql`SELECT id FROM pgboss.job WHERE name = ${QUEUES.digest} AND singleton_key = ${`story:${id}:correction`}`).length, 1,
    "visibility changes reuse the same pending correction job");
});

test("restoring a withdrawn story absent from the board recomputes heat and queues its correction digest", async () => {
  const source = `test-hot-restore-${T}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${source}, ${source}, 'rss', 'T1', 'editorial', '2100-01-01')`;
  const id = await story({ participants: 1, score: 100, selected: true, hoursAgo: 0, sources: [source], raw: { like_count: 5_000_000 } });
  const [signal] = await sql<{ article_id: string }[]>`SELECT article_id FROM story_signals WHERE story_id = ${id}`;
  const articleId = signal!.article_id;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60000) });
  await computeHotRanking();
  assert.ok((await latestHotRanking())!.entries.some((e) => Number(e.storyId) === id));
  await setVisibility(articleId, { visibility: "withdrawn", reason: "withdraw", version: 0 }, "test");
  assert.equal((await latestHotRanking())!.entries.some((e) => Number(e.storyId) === id), false);
  await setVisibility(articleId, { visibility: "public", reason: "restore", version: 1 }, "test");
  assert.ok((await latestHotRanking())!.entries.some((e) => Number(e.storyId) === id), "restoring an unranked story must put it back immediately");
  const jobs = await sql<{ data: { afterCorrection: boolean } }[]>`
    SELECT data FROM pgboss.job WHERE name = ${QUEUES.digest} AND singleton_key = ${`story:${id}:correction`}`;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.data.afterCorrection, true);
});

test("signal-only membership triggers visibility corrections without requiring a public publication", async () => {
  const source = `test-hot-signal-${T}`;
  const reporter = `test-hot-reporter-${T}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${source}, ${source}, 'rss', 'T1', 'hot_signal', '2100-01-01'),
           (${reporter}, ${reporter}, 'rss', 'T1', 'editorial', '2100-01-01')`;
  const id = await story({ participants: 2, score: 100, selected: true, hoursAgo: 0, sources: [reporter, source], raw: { like_count: 5_000_000 } });
  const [signal] = await sql<{ article_id: string }[]>`SELECT article_id FROM story_signals WHERE story_id = ${id} AND source_id = ${source}`;
  await sql`DELETE FROM fact_articles WHERE article_id = ${signal!.article_id}`;
  await sql`UPDATE story_signals SET kind = 'signal' WHERE article_id = ${signal!.article_id}`;
  await sql`DELETE FROM publications WHERE article_id = ${signal!.article_id}`;
  const candidate = () => hotCandidates(new Date()).then((rows) => rows.find((r) => Number(r.story_id) === id)!);
  assert.equal(Number((await candidate()).participants), 2, "a signal needs no public publication to contribute");
  await computeHotRanking();
  const before = (await latestHotRanking())!.id;
  await setVisibility(signal!.article_id, { visibility: 'withdrawn', reason: 'withdraw signal', version: 0 }, 'test');
  const after = (await latestHotRanking())!;
  assert.ok(after.id > before, "signal membership alone causes an immediate ranking update");
  assert.equal(after.entries.find((e) => Number(e.storyId) === id)!.participantCount, 1);
  assert.equal(Number((await candidate()).signal_participants), 0);
  const jobs = await sql<{ data: { afterCorrection: boolean } }[]>`
    SELECT data FROM pgboss.job WHERE name = ${QUEUES.digest} AND singleton_key = ${`story:${id}:correction`}`;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.data.afterCorrection, true);
  await setVisibility(signal!.article_id, { visibility: 'public', reason: 'restore signal', version: 1 }, 'test');
  assert.equal(Number((await candidate()).participants), 2);
});

// The lists (decision 8 of the tracks handoff): every list by heat, a source alone filling at most two
// places, and the combined list keeping three places for each track.
const ranked = (id: number, heat: number, o: { participants?: number; source?: string; tracks?: Array<"academic" | "industry"> } = {}) => ({
  entry: { storyId: id, heat, participantCount: o.participants ?? 1, representativeSource: o.source ?? `source-${id}`, latestAt: "2026-10-19T00:00:00.000Z" } as never as HotEntry,
  tracks: new Set<"academic" | "industry">(o.tracks ?? ["academic"]),
});

test("a list reads hottest first; one source fills at most two places with stories it alone reports", () => {
  const list = rankByHeat([
    ranked(1, 3.5), ranked(2, 21.3, { participants: 4 }), ranked(3, 4.5),
    ranked(4, 9, { source: "PsyPost" }), ranked(5, 8, { source: "PsyPost" }), ranked(6, 7, { source: "PsyPost" }),
    ranked(7, 6, { source: "PsyPost", participants: 3 }),
  ]);
  assert.deepEqual(list.map((c) => c.entry.storyId), [2, 4, 5, 7, 3, 1], "the third PsyPost story alone is left out; one with other participants is not capped");
});

test("the combined list keeps three places for each track and reads hottest first", () => {
  const academic = Array.from({ length: 10 }, (_, i) => ranked(i + 1, 20 - i));
  const industry = [ranked(101, 2.2, { tracks: ["industry"] }), ranked(102, 1.5, { tracks: ["industry"] }), ranked(103, 0.9, { tracks: ["industry"] }), ranked(104, 0.5, { tracks: ["industry"] })];
  const combined = combinedSelection(rankByHeat(academic), rankByHeat(industry), [...academic, ...industry]);
  assert.deepEqual(combined.map((c) => c.entry.storyId), [1, 2, 3, 4, 5, 6, 7, 101, 102, 103], "the industry floor takes the last three places; 104 is not in");
  const fewIndustry = combinedSelection(rankByHeat(academic), rankByHeat(industry.slice(0, 2)), [...academic, ...industry.slice(0, 2)]);
  assert.deepEqual(fewIndustry.map((c) => c.entry.storyId), [1, 2, 3, 4, 5, 6, 7, 8, 101, 102], "a track with fewer stories keeps what it has");
});

test("combined track floors respect the shared exclusive-source cap and fill from later candidates", () => {
  const academic = Array.from({ length: 10 }, (_, i) => ranked(i + 1, 20 - i, i < 2 ? { source: "PsyPost" } : {}));
  const industry = Array.from({ length: 6 }, (_, i) => ranked(101 + i, 2 - i / 10,
    { tracks: ["industry"], ...(i < 2 ? { source: "PsyPost" } : {}) }));
  const combined = combinedSelection(rankByHeat(academic), rankByHeat(industry), [...academic, ...industry]);
  assert.ok(combined.filter((c) => c.entry.participantCount === 1 && c.entry.representativeSource === "PsyPost").length <= 2,
    "the track floors must not admit four exclusive stories from one source");
  assert.ok(combined.filter((c) => c.tracks.has("academic")).length >= 3);
  assert.equal(combined.filter((c) => c.tracks.has("industry")).length, 3, "later industry candidates fill its three reserved places");
  assert.deepEqual(combined.map((c) => c.entry.storyId), [1, 2, 3, 4, 5, 6, 7, 103, 104, 105]);
});
