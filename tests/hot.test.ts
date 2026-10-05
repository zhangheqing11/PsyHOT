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
import { hotCandidates } from "@aihot/backend/events/hot";
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
async function story(o: { participants: number; score: number; selected: boolean; hoursAgo: number }): Promise<number> {
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
