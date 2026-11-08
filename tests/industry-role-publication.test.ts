// Role-selected and hot-selected items share the normal publication gates and public read layer.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { pickIndustryHot } from "@aihot/backend/events/industry-hot";
import { loadPool } from "@aihot/backend/publication/pool";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { v1Items } from "@aihot/backend/publication/v1";
import { itemFeed } from "@aihot/backend/publication/feeds";
import { FEATURES } from "@aihot/industry/features";
import { ROLE_KEYS } from "@aihot/contracts/taxonomy";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `test-role-publication-${T}`;
const switches = FEATURES as unknown as { industryRoleScoring: boolean };
const originalSwitch = switches.industryRoleScoring;
const AT = new Date();
const storyIds: number[] = [];
const app = await buildApp();
before(async () => {
  switches.industryRoleScoring = true;
  await sql`INSERT INTO sources (id, name, kind, tier, track, participation_mode, next_fetch_at)
    VALUES (${SOURCE}, 'Role publication test', 'rss', 'T1', 'industry', 'editorial', '2100-01-01')`;
});
after(async () => {
  switches.industryRoleScoring = originalSwitch;
  try {
    await sql`DELETE FROM articles WHERE source_id=${SOURCE}`;
    await sql`DELETE FROM facts WHERE story_id=ANY(${storyIds}::bigint[])`;
    await sql`DELETE FROM stories WHERE id=ANY(${storyIds}::bigint[])`;
    await sql`DELETE FROM sources WHERE id=${SOURCE}`;
  } finally {
    await app.close();
    await stopBoss();
    await closeDb();
  }
});
let n = 0;
function scoring(rel = 2, nov = 2, selectedRoles: string[] = []) {
  return {
    values: { event: "规则变化", nov: { why: "新规定", score: nov }, cred: { why: "原文", score: 3 },
      roles: Object.fromEntries(ROLE_KEYS.map((r) => [r, { why: "依据", rel, act: 1, verdict: "skip" }])), primary: [] },
    roleScores: Object.fromEntries(ROLE_KEYS.map((r) => [r, rel + 1 + nov])), selectedRoles,
  };
}
async function article(o: { selected?: boolean; selectedRoles?: string[]; rel?: number; nov?: number; category?: string; promotion?: boolean; output?: Record<string, unknown>; at?: Date } = {}) {
  const i = n++;
  const { articleId: id } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/role-pub-${T}-${i}`, title: `Role publication ${T} ${i}`,
    bodyText: `Role material ${T} ${i} `.repeat(30), bodyStatus: "ok", via: "fetch", publishedAt: AT });
  const output = { roles: ["counselor", "school"], impact: "rule", promotion: o.promotion ?? false, roleScoring: scoring(o.rel, o.nov, o.selectedRoles), ...o.output };
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
    VALUES (${id}, 1, 'rule', 'pass', ${o.category ?? "policy"}, ${`标题 ${T} ${i}`}, ${`摘要 ${i}`}, 40, ${o.selected ?? false}, ${sql.json(output as never)})`;
  await sql`UPDATE articles SET grouped_at=${AT}, timeline_at=${o.at ?? AT} WHERE id=${id}`;
  await publishArticle(id, { now: AT, releasedAt: new Date(AT.getTime() - 1000) });
  return id;
}
const publication = async (id: string) => (await sql<{ selected: boolean; selected_roles: string[]; hot_pick: boolean; revision: number; visible_after: Date }[]>`
  SELECT selected, selected_roles, hot_pick, revision, visible_after FROM publications WHERE article_id=${id}`)[0]!;

test("0060 adds empty selected_roles and false hot_pick defaults without backfill", async () => {
  const id = await article();
  const [row] = await sql<{ selected_roles: string[]; hot_pick: boolean }[]>`
    UPDATE publications SET selected_roles=DEFAULT, hot_pick=DEFAULT WHERE article_id=${id} RETURNING selected_roles, hot_pick`;
  assert.deepEqual([row!.selected_roles, row!.hot_pick], [[], false]);
});

test("publishing copies selected roles, updates either new column, and preserves manual priority", async () => {
  const id = await article({ selected: true, selectedRoles: ["counselor"] });
  const first = await publication(id);
  assert.deepEqual([first.selected, first.selected_roles, first.hot_pick], [true, ["counselor"], false]);
  assert.equal((await publishArticle(id))?.changed, false);
  await sql`UPDATE analyses SET output=jsonb_set(output, '{roleScoring,selectedRoles}', '["school"]') WHERE article_id=${id}`;
  assert.equal((await publishArticle(id))?.changed, true);
  const second = await publication(id);
  assert.deepEqual(second.selected_roles, ["school"]);
  assert.equal(second.revision, first.revision + 1);
  await sql`INSERT INTO industry_hot_picks (article_id, story_id, participants) VALUES (${id}, 999999, 8)`;
  assert.equal((await publishArticle(id))?.changed, true);
  assert.equal((await publication(id)).hot_pick, true);
  await sql`INSERT INTO editorial_overrides (article_id, fields, updated_by, reason) VALUES (${id}, '{"selected":false}', 'test', 'test')`;
  await publishArticle(id);
  assert.deepEqual(await publication(id).then((p) => [p.selected, p.selected_roles, p.hot_pick]), [false, [], false]);
  await sql`UPDATE editorial_overrides SET fields='{"selected":true}' WHERE article_id=${id}`;
  await publishArticle(id);
  assert.deepEqual(await publication(id).then((p) => [p.selected, p.selected_roles, p.hot_pick]), [true, ["school"], true]);
  switches.industryRoleScoring = false;
  try {
    await publishArticle(id);
    assert.deepEqual(await publication(id).then((p) => [p.selected_roles, p.hot_pick]), [[], false]);
  } finally { switches.industryRoleScoring = true; }
});

async function story(o: { participants?: number; rel?: number; nov?: number; daysAgo?: number; editorial?: boolean; duplicate?: boolean; selected?: boolean; category?: string; promotion?: boolean; noResult?: boolean; hidden?: boolean; ineligible?: boolean; expiredSignal?: boolean } = {}) {
  const first = new Date(AT.getTime() - (o.daysAgo ?? 1) * 86400000);
  const [st] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at) VALUES (${randomUUID()}, ${`Story ${T} ${n}`}, ${first}) RETURNING id`;
  storyIds.push(Number(st!.id));
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`fact-${randomUUID()}`}, ${st!.id}, '规则') RETURNING id`;
  const id = await article({ rel: o.rel, nov: o.nov, selected: o.selected, category: o.category, promotion: o.promotion,
    ...(o.noResult ? { output: { roleScoring: null } } : {}) });
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${id}, 'report')`;
  await publishArticle(id, { now: AT });
  for (let i = 0; i < (o.participants ?? 8); i++) {
    const observed = o.expiredSignal && i === 7 ? new Date(AT.getTime() - 8 * 86400000) : new Date(AT.getTime() - 1000);
    const signalId = i === 0 ? id : (await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/role-signal-${T}-${n++}`,
      title: `Signal ${T} ${n}`, bodyText: `Signal ${T} ${n} `.repeat(30), bodyStatus: "ok", via: "fetch", publishedAt: AT })).articleId;
    await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
      VALUES (${st!.id}, ${signalId}, ${`participant-${T}-${st!.id}-${i}`}, ${SOURCE}, ${i === 0 && o.editorial !== false ? "editorial" : "signal"}, ${observed})`;
  }
  if (o.duplicate) {
    const duplicate = await article();
    await sql`UPDATE articles SET duplicate_of=${id} WHERE id=${duplicate}`;
    await sql`UPDATE story_signals SET article_id=${duplicate} WHERE story_id=${st!.id} AND participant_key=${`participant-${T}-${st!.id}-7`}`;
  }
  if (o.hidden) await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${id}`;
  if (o.ineligible) await sql`UPDATE publications SET eligible=false WHERE article_id=${id}`;
  return { id, storyId: Number(st!.id), factId: Number(fact!.id) };
}

test("hot channel selects and republishes once, remains selected after decay, and honors the release gate", async () => {
  const s = await story();
  const before = await publication(s.id);
  assert.equal(await pickIndustryHot(AT), 1);
  const p = await publication(s.id);
  assert.deepEqual([p.selected, p.selected_roles, p.hot_pick], [true, [], true]);
  assert.equal(p.revision, before.revision + 1);
  const [pick] = await sql<{ participants: number; picked_at: Date }[]>`SELECT participants, picked_at FROM industry_hot_picks WHERE article_id=${s.id}`;
  assert.equal(pick!.participants, 8);
  assert.equal(pick!.picked_at.getTime(), AT.getTime());
  assert.equal(await pickIndustryHot(AT), 0);
  await sql`DELETE FROM story_signals WHERE story_id=${s.storyId}`;
  await publishArticle(s.id);
  assert.deepEqual(await publication(s.id).then((r) => [r.selected, r.hot_pick]), [true, true]);
  assert.ok(p.visible_after <= AT, "a grouped report releases through the normal publication gate");
});

for (const [label, opts] of Object.entries({
  "seven participants": { participants: 7 }, "rel one": { rel: 1 }, "nov one": { nov: 1 },
  "old event": { daysAgo: 8 }, "no editorial participant": { editorial: false }, "duplicate eighth participant": { duplicate: true },
  "already selected": { selected: true }, "academic": { category: "research" }, "promotion": { promotion: true },
  "no role result": { noResult: true }, "withdrawn": { hidden: true }, "ineligible": { ineligible: true }, "expired eighth signal": { expiredSignal: true },
})) {
  test(`hot channel excludes ${label}`, async () => {
    const s = await story(opts);
    assert.equal(await pickIndustryHot(AT), 0);
    assert.equal((await publication(s.id)).hot_pick, false);
  });
}

for (const category of ["policy", "research"]) {
  test(`hot channel excludes an event with another selected ${category} publication`, async () => {
    const s = await story();
    const selected = await article({ selected: true, category,
      ...(category === "policy" ? { selectedRoles: ["counselor"] } : { output: { roleScoring: null } }) });
    const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title)
      VALUES (${`fact-${randomUUID()}`}, ${s.storyId}, '已入选的另一条进展') RETURNING id`;
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${selected}, 'report')`;
    await publishArticle(selected, { now: AT });
    const before = await publication(s.id);
    assert.equal((await publication(selected)).selected, true);
    assert.equal(await pickIndustryHot(AT), 0);
    assert.deepEqual(await publication(s.id), before);
    assert.equal((await sql`SELECT article_id FROM industry_hot_picks WHERE story_id=${s.storyId}`).length, 0);
  });
}

test("same participant across multiple signals counts once", async () => {
  const s = await story({ participants: 7 });
  const extra = await article();
  await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
    VALUES (${s.storyId}, ${extra}, ${`participant-${T}-${s.storyId}-0`}, ${SOURCE}, 'signal', ${AT})`;
  assert.equal(await pickIndustryHot(AT), 0);
});

test("one winner per event: highest max rel, then earliest, and concurrent runs stay idempotent", async () => {
  const s = await story({ rel: 2 });
  const later = await article({ rel: 3, at: AT });
  const earlier = await article({ rel: 3, at: new Date(AT.getTime() - 10000) });
  for (const id of [later, earlier]) {
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${s.factId}, ${id}, 'report')`;
    await publishArticle(id, { now: AT });
  }
  const results = await Promise.all([pickIndustryHot(AT), pickIndustryHot(AT)]);
  assert.equal(results.reduce((a, b) => a + b, 0), 1);
  assert.equal((await publication(earlier)).hot_pick, true);
  assert.equal((await publication(later)).hot_pick, false);
  assert.equal((await publication(s.id)).hot_pick, false);
  // Adding a better report later does not create a second pick for the story.
  const best = await article({ rel: 4 });
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${s.factId}, ${best}, 'report')`;
  await publishArticle(best, { now: AT });
  assert.equal(await pickIndustryHot(AT), 0);
});

test("disabled hot task does nothing; enabling later can select the same candidate", async () => {
  const s = await story();
  switches.industryRoleScoring = false;
  try { assert.equal(await pickIndustryHot(AT), 0); }
  finally { switches.industryRoleScoring = true; }
  assert.equal((await publication(s.id)).selected, false);
  assert.equal(await pickIndustryHot(AT), 1);
});

test("an editor's rejection cannot consume the story's hot pick or hide another eligible report", async () => {
  const s = await story({ rel: 4 });
  await sql`INSERT INTO editorial_overrides (article_id, fields, updated_by, reason) VALUES (${s.id}, '{"selected":false}', 'test', 'test')`;
  const other = await article({ rel: 2 });
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${s.factId}, ${other}, 'report')`;
  await publishArticle(other, { now: AT });
  assert.equal(await pickIndustryHot(AT), 1);
  assert.equal((await publication(s.id)).hot_pick, false);
  assert.equal((await publication(other)).hot_pick, true);
});

test("every selected exit uses selected_roles; all-dynamics uses roles; only site summaries add fields", async () => {
  const role = await article({ selected: true, selectedRoles: ["counselor"] });
  const browse = await article({ selected: true, selectedRoles: ["school"] });
  const hot = await story();
  assert.equal(await pickIndustryHot(AT), 1);
  const mine = [role, browse, hot.id];
  const own = (items: Array<{ id: string }>) => items.filter((i) => mine.includes(i.id)).map((i) => i.id).sort();
  const filter = { channel: "all" as const, category: null, tag: null, role: "counselor" as const };
  const timeline = await loadTimeline({ ...filter, now: AT, limit: 40 });
  assert.deepEqual(own(timeline.cards.map((c) => c.item)), [role]);
  const unfiltered = await loadTimeline({ channel: "all", category: null, tag: null, track: "industry", now: AT, limit: 40 });
  assert.deepEqual(own(unfiltered.cards.map((c) => c.item)), [...mine].sort());
  const hotCard = unfiltered.cards.find((c) => c.item.id === hot.id)!.item;
  assert.deepEqual([hotCard.hotPick, hotCard.selectedRoles], [true, []]);
  const pool = await loadPool({ ...filter, now: AT });
  assert.deepEqual(own(pool.items), [...mine].sort());
  const base = { window: "24h" as const, by: "timeline" as const, category: null, role: "counselor" as const, q: null, limit: 100, cursor: null };
  const selected = await v1Items({ ...base, mode: "selected" }, AT);
  assert.deepEqual(own(selected.items), [role]);
  assert.deepEqual(own((await v1Items({ ...base, mode: "all" }, AT)).items), [...mine].sort());
  for (const i of selected.items) assert.ok(!("hotPick" in i) && !("selectedRoles" in i));
  const feed = await itemFeed("selected", null, "industry", null, "counselor", AT);
  assert.ok(feed.includes(role) && !feed.includes(browse) && !feed.includes(hot.id));
  const allFeed = await itemFeed("all", null, "industry", null, "counselor", AT);
  assert.ok(mine.every((id) => allFeed.includes(id)));
  const res = await app.inject({ method: "POST", url: "/api/mcp",
    headers: { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
  const rpc = JSON.parse(res.body.includes("\ndata:") ? res.body.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : res.body);
  const tool = rpc.result.tools.find((t: any) => "mode" in t.inputSchema.properties);
  const call = await app.inject({ method: "POST", url: "/api/mcp",
    headers: { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool.name, arguments: { mode: "selected", window: "24h", role: "counselor", limit: 30 } } } });
  const result = JSON.parse(call.body.includes("\ndata:") ? call.body.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : call.body).result;
  assert.deepEqual(own(result.structuredContent.items), [role]);
  for (const i of result.structuredContent.items) assert.ok(!("hotPick" in i) && !("selectedRoles" in i));
  switches.industryRoleScoring = false;
  try {
    const legacy = await loadTimeline({ ...filter, now: AT, limit: 40 });
    assert.deepEqual(own(legacy.cards.map((c) => c.item)), [...mine].sort());
    for (const c of legacy.cards) assert.ok(!("hotPick" in c.item) && !("selectedRoles" in c.item));
    assert.deepEqual(own((await v1Items({ ...base, mode: "selected" }, AT)).items), [...mine].sort());
  } finally { switches.industryRoleScoring = true; }
});
