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
import { combinedSelection, hotCandidates, rankByHeat } from "@aihot/backend/events/hot";
import type { HotEntry } from "@aihot/backend/events/hot-read";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";

const T = tag();
const SOURCE = `test-hot-${T}`;
const BODY = `HOT-BODY-${T} `.repeat(40);

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test hot', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await stopBoss();
  await closeDb();
});

let n = 0;
/** A story whose reports come from `participants` independent participants, last seen `hoursAgo`. */
async function story(o: { participants: number; score: number; selected: boolean; hoursAgo: number; raw?: Record<string, unknown> }): Promise<number> {
  const [st] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${`HOT-${T}`}, now() - make_interval(hours => ${o.hoursAgo}), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`fact-${randomUUID()}`}, ${st!.id}, ${`HOT-${T}`}) RETURNING id`;
  for (let i = 0; i < o.participants; i++) {
    n += 1;
    const { articleId } = await upsertMaterial({
      sourceId: SOURCE, url: `https://example.com/hot-${T}-${n}`, title: `Hot ${n}`, bodyText: BODY, bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
    } as never);
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
              VALUES (${articleId}, 1, 'rule', 'pass', 'research', ${`热点${n}-${T}`}, ${`摘要${n}`}, '理由', ${o.score}, ${o.selected})`;
    if (o.raw) await sql`UPDATE articles SET raw = ${sql.json(o.raw as never)} WHERE id = ${articleId}`;
    await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${articleId}, 'report')`;
    await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
              VALUES (${st!.id}, ${articleId}, ${`participant-${T}-${n}`}, ${SOURCE}, 'editorial', now() - make_interval(hours => ${o.hoursAgo}))`;
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
