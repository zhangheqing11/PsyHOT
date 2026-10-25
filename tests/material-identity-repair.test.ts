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
import { queueProcessing, processArticle } from "@aihot/backend/jobs/content";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { translateArticle } from "@aihot/backend/editorial/translate";
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
    assert.equal((await processArticle(id)).state, "missing", "already queued analyses also skip aliases");
    await sql`UPDATE articles SET body_status = 'pending' WHERE id = ${id}`;
    assert.equal(await extractArticleBody(id), "skipped", "already queued extraction does not fetch again");
    assert.equal((await translateArticle(id)).status, "skipped");
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

test("generic repair consolidates BACP date aliases and records removals for selected sync clients", async () => {
  const t = tag();
  const source = `bacp-repair-${t}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${source}, 'BACP repair test', 'web_list', 'T1', 'editorial', '2100-01-01')`;
  const urls = ["oct", "october"].map((month) => `https://www.bacp.co.uk/news/news-from-bacp/2026/9-${month}-test-${t}`);
  const ids = urls.map((_, i) => `bacp-${t}-${i}`);
  for (const [i, url] of urls.entries()) {
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, body_text, body_status)
      VALUES (${ids[i]}, ${source}, ${`url:${url}`}, ${url}, 'Mental health support', now(), now(), ${i === 0 ? 'Full text. '.repeat(100) : 'Excerpt.'}, 'ok')`;
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
      VALUES (${ids[i]}, 1, 'rule', 'pass', 'policy', '心理健康服务不应以诊断为前提', '政策声明的完整摘要', 80, true)`;
    await publishArticle(ids[i]!, { releasedAt: new Date(Date.now() - 60_000) });
  }
  const group = (await auditMaterialIdentities()).find((g) => g.keep === ids[0]);
  assert.ok(group);
  assert.deepEqual(group.duplicates, [ids[1]]);
  await repairMaterialIdentities();
  const [removed] = await sql<{ in_set: boolean }[]>`SELECT in_set FROM selected_state WHERE article_id = ${ids[1]}`;
  assert.equal(removed!.in_set, false);
  assert.equal((await sql`SELECT 1 FROM selected_ledger WHERE article_id = ${ids[1]} AND op = 'remove'`).length, 1);
  assert.equal((await sql`SELECT 1 FROM publications WHERE article_id = ANY(${ids}::text[]) AND selected AND visibility = 'public'`).length, 1);
  assert.equal((await upsertMaterial({ sourceId: source, url: urls[0]!, title: 'Mental health support', via: 'fetch' })).articleId, ids[0]);
  // A new withdrawal of the survivor must also hide every old bookmark.
  await sql`INSERT INTO editorial_overrides (article_id, visibility, reason) VALUES (${ids[0]}, 'withdrawn', 'test withdrawal')`;
  await publishArticle(ids[0]!);
  assert.equal((await loadItemDetail(ids[1]!)).kind, 'not_found');
  assert.equal((await itemAvailability([ids[1]!]))[ids[1]!], 'unavailable');
});

test("conflicting duplicate restrictions preserve withdrawal over summary-only", async () => {
  const t = tag();
  const source = `restricted-repair-${t}`;
  const note = randomBytes(12).toString('hex');
  await sql`INSERT INTO sources (id, name, kind, next_fetch_at) VALUES (${source}, 'Restriction test', 'external', '2100-01-01')`;
  const ids = [`withdrawn-${t}`, `summary-${t}`];
  for (const [i, id] of ids.entries()) {
    const url = `https://www.xiaohongshu.com/explore/${note}?xsec_token=${i}`;
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, body_text)
      VALUES (${id}, ${source}, ${`url:${url}`}, ${url}, 'Same note', now(), now(), ${i ? 'More text. '.repeat(100) : 'Short.'})`;
    await sql`INSERT INTO editorial_overrides (article_id, visibility, reason)
      VALUES (${id}, ${i ? 'summary-only' : 'withdrawn'}, 'restriction test')`;
    await publishArticle(id);
  }
  await repairMaterialIdentities();
  const [survivor] = await sql<{ id: string }[]>`SELECT id FROM articles WHERE identity_key = ${`xhs:${note}`}`;
  assert.equal(survivor!.id, ids[0], 'the richer summary-only copy cannot override a withdrawal');
  assert.equal((await loadItemDetail(ids[1]!)).kind, 'not_found');
});
