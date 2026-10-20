// A production-shaped regression: one XHS note, nine signed links, two keyword entrances.
// Repair must change counts and heat, preserve the richer analysis and old links, and be retryable.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { auditMaterialIdentities, repairMaterialIdentities, rebuildMaterialIdentityRepairs } from "@aihot/backend/content/repair-identities";
import { hotCandidates } from "@aihot/backend/events/hot";
import { groupArticle } from "@aihot/backend/events/group";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadItemDetail } from "@aihot/backend/publication/detail";
import { itemAvailability } from "@aihot/backend/publication/availability";
import { loadStoryDetail } from "@aihot/backend/publication/stories";

after(async () => { await stopBoss(); await closeDb(); });

test("repair all signed-note variants, consolidate source evidence and rebuild all three boards", async () => {
  const t = tag();
  const sources = [`test-repair-a-${t}`, `test-repair-b-${t}`];
  for (const id of sources) {
    await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
      VALUES (${id}, ${id}, 'json_list', 'T2', 'editorial', '2100-01-01')`;
  }
  const publicId = randomUUID();
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at, digest)
    VALUES (${publicId}, 'Repeated review', now() - interval '2 hours', now(), 'Old digest wrongly counted repeated reports') RETURNING id`;
  const storyId = Number(story!.id);
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title)
    VALUES (${`f${t}`}, ${storyId}, 'One review') RETURNING id`;
  const note = randomBytes(12).toString("hex");
  const ids: string[] = [];
  const at = new Date(Date.now() - 2 * 3600_000);
  for (let i = 0; i < 9; i++) {
    const id = `legacy-${t}-${i}`;
    ids.push(id);
    const source = sources[i % 2]!;
    const url = `https://www.xiaohongshu.com/explore/${note}?xsec_token=legacy-${i}`;
    const body = i === 8 ? "Full note with the 84-study review. ".repeat(40) : "Search excerpt.";
    // Bypass today's entrance to reproduce the old URL-based records.
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, author, discovered_at, timeline_at,
      published_at, body_text, body_status, processing_state)
      VALUES (${id}, ${source}, ${`url:${url}`}, ${url}, 'One review', 'One author', ${at}, ${at}, ${at}, ${body}, 'ok', 'analyzed')`;
    await sql`INSERT INTO article_discoveries (article_id, source_id, via, discovered_at) VALUES (${id}, ${source}, 'fetch', ${at})`;
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
      VALUES (${id}, 1, 'rule', 'pass', 'research', '心理健康大模型综述', ${i === 8 ? '完整综述：84项研究。' : '短摘要'}, ${i === 8 ? 60 : 40}, false)`;
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${id}, 'report')`;
    await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
      VALUES (${storyId}, ${id}, ${`source:${source}`}, ${source}, 'editorial', ${at})`;
    await publishArticle(id);
  }
  const before = await loadStoryDetail(storyId);
  assert.equal(before!.reportCount, 9);
  assert.equal(before!.sourceCount, 2);
  assert.ok((await hotCandidates(new Date())).some((r) => Number(r.story_id) === storyId), "two search entrances falsely make an unselected story hot");
  await sql`INSERT INTO story_heat_hourly (story_id, hour, heat, participants, cohort)
    VALUES (${storyId}, date_trunc('hour', now()), 99, 9, 9)`;
  const audit = (await auditMaterialIdentities()).find((g) => g.identity === `xhs:${note}`)!;
  assert.equal(audit.keep, ids[8], "keep full content and its richer existing analysis");
  assert.equal(audit.duplicates.length, 8);

  const repair = await repairMaterialIdentities();
  assert.ok(repair.duplicates >= 8);
  const afterRepair = await loadStoryDetail(storyId);
  assert.equal(afterRepair!.reportCount, 1);
  assert.equal(afterRepair!.sourceCount, 1);
  assert.equal(afterRepair!.whyHot.participantsInWindow, 1);
  assert.equal(afterRepair!.digest, null, "the contaminated digest cannot stay visible");
  assert.equal((await sql`SELECT 1 FROM articles WHERE id = ANY(${ids}::text[])`).length, 9, "keep historical material and analyses");
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id = ANY(${ids}::text[])`).length, 9);
  assert.equal((await sql`SELECT 1 FROM article_discoveries WHERE article_id = ${ids[8]}`).length, 2);
  assert.equal((await sql`SELECT 1 FROM story_signals WHERE story_id = ${storyId}`).length, 1);
  assert.equal((await hotCandidates(new Date())).some((r) => Number(r.story_id) === storyId), false, "one unselected note cannot qualify by being listed twice");
  for (const id of ids.slice(0, 8)) {
    const detail = await loadItemDetail(id);
    assert.equal(detail.kind, "found");
    if (detail.kind === "found") assert.equal(detail.detail.id, ids[8], "old bookmarks resolve to the surviving article");
    assert.equal((await publishArticle(id))!.visibility, "withdrawn", "a republish cannot resurrect the duplicate");
    assert.equal((await groupArticle(id)).verdict, "skipped");
    assert.equal(await queueProcessing(id), null, "aliases never reach paid processing");
  }
  assert.equal((await itemAvailability([ids[0]!]))[ids[0]!], "public");
  const again = await upsertMaterial({
    sourceId: sources[1]!, url: `https://www.xiaohongshu.com/explore/${note}?xsec_token=next-search`,
    title: "Another entrance", via: "fetch",
  });
  assert.equal(again.articleId, ids[8]);
  assert.equal(again.created, false);
  assert.equal(again.revised, false);
  assert.equal((await auditMaterialIdentities()).some((g) => g.identity === `xhs:${note}`), false);
  assert.equal((await repairMaterialIdentities()).duplicates, 0, "repair is idempotent");

  // The durable checkpoint survives an interrupted deploy; the next run performs the rebuild.
  assert.ok((await rebuildMaterialIdentityRepairs()).rebuilt >= 1);
  const [ranking] = await sql<{ entries: Array<{ storyId: number; track: string }> }[]>`SELECT entries FROM hot_rankings WHERE published ORDER BY computed_at DESC LIMIT 1`;
  assert.ok(ranking);
  assert.equal(ranking!.entries.some((e) => Number(e.storyId) === storyId), false, "no combined/academic/industry entry survives on false evidence");
  const heat = await sql<{ participants: number; cohort: number; heat: number }[]>`SELECT participants, cohort, heat FROM story_heat_hourly WHERE story_id = ${storyId}`;
  assert.ok(heat.length > 0);
  assert.ok(heat.every((h) => Number(h.participants) === 1 && Number(h.cohort) === 1 && Number(h.heat) < 99));
  assert.equal((await rebuildMaterialIdentityRepairs()).rebuilt, 0, "completed checkpoints do not rebuild again");
});
