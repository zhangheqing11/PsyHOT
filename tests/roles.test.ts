// Browsing industry items by practitioner role (industry/features.ts industryRoles, off by default): the
// publication projection carries roles and impact from the structure step's output; every exit accepts `role`
// once the switch is on, and with it off the exits are what they were (role is an unknown parameter).
import { tag } from "./setup.ts";
import { withRoleScoring } from "./feature-flags.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle, v1Payload } from "@aihot/backend/publication/publish";
import { loadPool } from "@aihot/backend/publication/pool";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { v1Items } from "@aihot/backend/publication/v1";
import { itemFeed } from "@aihot/backend/publication/feeds";
import { agentGuide } from "@aihot/backend/publication/agent";
import { FEATURES } from "@aihot/industry/features";
import { IMPACT_LABELS, IMPACT_KEYS, isRoleKey, ROLE_KEYS, ROLE_LABELS } from "@aihot/contracts/taxonomy";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const INDUSTRY = `test-roles-industry-${T}`;
const app = await buildApp();
const switches = FEATURES as { industryRoles: boolean };

/** Runs with the switch on (or off) and puts it back. */
async function withRoles<R>(on: boolean, fn: () => Promise<R>): Promise<R> {
  const before = switches.industryRoles;
  switches.industryRoles = on;
  try {
    return await fn();
  } finally {
    switches.industryRoles = before;
  }
}

after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

let n = 0;
/** A released, selected article whose analysis says what the structure step said. */
async function article(label: string, category: string, output: Record<string, unknown>): Promise<string> {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId: INDUSTRY, url: `https://example.com/roles-${T}-${n}`, title: `Role ${label} ${T}`, bodyText: `${label} ${T} `.repeat(20), bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  } as never);
  await analysis(articleId, 1, category, output);
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  return articleId;
}
async function analysis(articleId: string, revision: number, category: string, output: Record<string, unknown>) {
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected, output)
            VALUES (${articleId}, ${revision}, 'rule', 'pass', ${category}, ${`标题 ${articleId}`}, ${`摘要 ${articleId}`}, '理由', 90, true, ${sql.json(output as never)})`;
}
const publication = async (id: string) =>
  (await sql<{ roles: string[]; impact: string | null; revision: number; tags: string[]; search_text: string }[]>`
    SELECT roles, impact, revision, tags, search_text FROM publications WHERE article_id = ${id}`)[0]!;

const ids: Record<string, string> = {};
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, track, region, next_fetch_at)
            VALUES (${INDUSTRY}, 'Test role regulator', 'rss', 'T1', 'editorial', 'industry', 'domestic', '2100-01-01')`;
  ids.both = await article("both", "policy", { roles: ["school", "counselor"], impact: "rule" });
  ids.counselor = await article("counselor", "profession", { roles: ["counselor"], impact: "risk" });
  ids.none = await article("none", "digital", { roles: [] });
  ids.academic = await article("academic", "research", { roles: ["school"], impact: "rule" });
  ids.promo = await article("promo", "industry", { roles: ["school"], impact: "rule", promotion: true });
  ids.messy = await article("messy", "industry", { roles: ["bogus", "operator", "operator", "psychiatry", "community", "school"], impact: "bogus" });
});

const idsOf = (items: Array<{ id: string }>) => new Set(items.filter((i) => Object.values(ids).includes(i.id)).map((i) => i.id));
const named = (...keys: string[]) => new Set(keys.map((k) => ids[k]!));

async function get(url: string) {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.body };
}

test("vocabulary: role keys come from the pack, with labels and impact labels", () => {
  assert.deepEqual([...ROLE_KEYS], ["counselor", "psychiatry", "school", "community", "operator"]);
  assert.equal(ROLE_LABELS.school, "青少年心理");
  assert.equal(ROLE_LABELS.operator, "机构与产品");
  assert.deepEqual(Object.keys(IMPACT_LABELS), [...IMPACT_KEYS]);
  assert.ok(isRoleKey("school") && !isRoleKey("学校") && !isRoleKey(undefined));
});

test("publish copies valid roles and impact of industry items, and nothing else", async () => {
  assert.deepEqual(await publication(ids.both!).then((p) => [p.roles, p.impact]), [["school", "counselor"], "rule"]);
  assert.deepEqual(await publication(ids.counselor!).then((p) => [p.roles, p.impact]), [["counselor"], "risk"]);
  assert.deepEqual(await publication(ids.none!).then((p) => [p.roles, p.impact]), [[], null]);
  assert.deepEqual(await publication(ids.academic!).then((p) => [p.roles, p.impact]), [[], null], "academic items carry no roles");
  assert.deepEqual(await publication(ids.promo!).then((p) => [p.roles, p.impact]), [[], null], "promotions carry no roles");
  // Unknown keys and repeats dropped, three at most; an unknown impact is none.
  assert.deepEqual(await publication(ids.messy!).then((p) => [p.roles, p.impact]), [["operator", "psychiatry", "community"], null]);
  // Roles are not tags and not search text.
  const p = await publication(ids.both!);
  assert.ok(!p.tags.some((t) => ROLE_KEYS.includes(t as never) || Object.values(ROLE_LABELS).includes(t)));
  assert.ok(!p.search_text.includes("counselor") && !p.search_text.includes("青少年心理"));
});

test("a change of roles or impact updates the publication and bumps its revision", async () => {
  const id = await article("changing", "policy", { roles: ["school"], impact: "rule" });
  const first = await publication(id);
  assert.deepEqual([first.roles, first.impact], [["school"], "rule"]);
  assert.equal((await publishArticle(id))?.changed, false, "nothing changed on a plain republish");
  assert.equal((await publication(id)).revision, first.revision);

  await analysis(id, 2, "policy", { roles: ["psychiatry", "operator"], impact: "resource" });
  assert.equal((await publishArticle(id))?.changed, true);
  const second = await publication(id);
  assert.deepEqual([second.roles, second.impact], [["psychiatry", "operator"], "resource"]);
  assert.equal(second.revision, first.revision + 1);

  // Only the impact moving is a change too; and a move to a non-industry category clears both.
  await analysis(id, 3, "policy", { roles: ["psychiatry", "operator"], impact: "landscape" });
  assert.equal((await publishArticle(id))?.changed, true);
  assert.equal((await publication(id)).impact, "landscape");
  await analysis(id, 4, "research", { roles: ["psychiatry"], impact: "rule" });
  await publishArticle(id);
  assert.deepEqual(await publication(id).then((p) => [p.roles, p.impact]), [[], null]);
});

test("with the switch on, role keeps industry items that carry it; several roles show under each", () => withRoleScoring(false, async () => {
  await withRoles(true, async () => {
    const school = await loadPool({ channel: "all", category: null, tag: null, role: "school" });
    assert.deepEqual(idsOf(school.items), named("both"), "an academic item or promotion with a role in its analysis is not listed");
    assert.equal(school.filters.role, "school");
    const counselor = await loadPool({ channel: "all", category: null, tag: null, role: "counselor" });
    assert.deepEqual(idsOf(counselor.items), named("both", "counselor"), "a two-role item shows under each of its roles");
    const operator = await loadPool({ channel: "all", category: null, tag: null, track: "industry", role: "operator" });
    assert.deepEqual(idsOf(operator.items), named("messy"));
    // An item without roles only shows when no role is asked for.
    const industry = await loadPool({ channel: "all", category: null, tag: null, track: "industry" });
    assert.deepEqual(idsOf(industry.items), named("both", "counselor", "none", "promo", "messy"));
    assert.ok(!("role" in industry.filters));
    // Item summaries carry roles and impact.
    const both = school.items.find((i) => i.id === ids.both)!;
    assert.deepEqual([both.roles, both.impact], [["school", "counselor"], "rule"]);
    // Role with a region and a category narrows further.
    const domestic = await loadPool({ channel: "all", category: null, tag: null, region: "domestic", role: "counselor" });
    assert.deepEqual(idsOf(domestic.items), named("both", "counselor"));
    const international = await loadPool({ channel: "all", category: null, tag: null, region: "international", role: "counselor" });
    assert.deepEqual(idsOf(international.items), named());
    const policy = await loadPool({ channel: "all", category: "policy", tag: null, role: "counselor" });
    assert.deepEqual(idsOf(policy.items), named("both"));

    const timeline = await loadTimeline({ channel: "all", category: null, tag: null, role: "counselor" });
    assert.deepEqual(idsOf(timeline.cards.map((c) => c.item)), named("both", "counselor"));
    assert.equal(timeline.filters.role, "counselor");
    assert.deepEqual(timeline.cards.find((c) => c.item.id === ids.counselor)?.item.roles, ["counselor"]);

    const all = await v1Items({ mode: "all", window: "24h", by: "timeline", category: null, role: "counselor", q: null, limit: 100, cursor: null });
    assert.deepEqual(idsOf(all.items), named("both", "counselor"));
    assert.equal((all.query as Record<string, unknown>).role, "counselor");
    assert.deepEqual(all.items.find((i) => i.id === ids.both)?.roles, ["school", "counselor"]);
    assert.equal(all.items.find((i) => i.id === ids.both)?.impact, "rule");
    // A cursor belongs to its role.
    const page = await v1Items({ mode: "all", window: "24h", by: "timeline", category: null, role: "counselor", q: null, limit: 1, cursor: null });
    assert.ok(page.page.nextCursor);
    await assert.rejects(v1Items({ mode: "all", window: "24h", by: "timeline", category: null, role: "school", q: null, limit: 1, cursor: page.page.nextCursor }));

    const feed = await itemFeed("selected", null, "industry", null, "counselor");
    assert.ok(feed.includes(ids.both!) && feed.includes(ids.counselor!) && !feed.includes(ids.none!));
    assert.ok(feed.includes(`role=counselor`) && feed.includes(ROLE_LABELS.counselor));
  });
}));

test("with the switch on, the exits accept role and reject unknown ones", () => withRoleScoring(false, async () => {
  await withRoles(true, async () => {
    const pool = JSON.parse((await get("/api/site/pool?role=counselor")).body);
    assert.deepEqual(idsOf(pool.items), named("both", "counselor"));
    assert.equal(pool.filters.role, "counselor");
    const timeline = JSON.parse((await get("/api/site/timeline?role=school")).body);
    assert.deepEqual(idsOf(timeline.cards.map((c: { item: { id: string } }) => c.item)), named("both"));
    assert.equal(timeline.hot, null, "a role-filtered timeline has no hot strip");
    assert.equal((await get("/api/site/pool?role=bogus")).status, 400);
    assert.equal((await get("/api/site/timeline?role=bogus")).status, 400);

    const v1 = JSON.parse((await get("/api/v1/items?mode=all&window=24h&role=counselor&limit=100")).body);
    assert.deepEqual(idsOf(v1.items), named("both", "counselor"));
    assert.deepEqual(v1.items.find((i: { id: string }) => i.id === ids.counselor).roles, ["counselor"]);
    assert.equal(v1.items.find((i: { id: string }) => i.id === ids.counselor).impact, "risk");
    const plain = JSON.parse((await get("/api/v1/items?mode=all&window=24h&limit=100")).body);
    assert.deepEqual(plain.items.find((i: { id: string }) => i.id === ids.none).roles, []);
    assert.equal(plain.items.find((i: { id: string }) => i.id === ids.none).impact, null);
    assert.equal((await get("/api/v1/items?role=bogus")).status, 400);

    const latest = await get("/api/v1/agent/latest?mode=all&window=24h&role=counselor&limit=30");
    assert.equal(latest.status, 200);
    assert.match(latest.body, new RegExp(ROLE_LABELS.counselor));
    assert.ok(latest.body.includes(ids.both!) && !latest.body.includes(ids.none!));
    assert.equal((await get("/api/v1/agent/latest?role=bogus")).status, 400);
    assert.equal((await get("/api/v1/agent/search?q=%E6%A0%87%E9%A2%98&role=bogus")).status, 400);
    assert.match(agentGuide(), /role=counselor（咨询与治疗）/);

    const rss = await get("/feed/track/industry.xml?role=counselor");
    assert.equal(rss.status, 200);
    assert.ok(rss.body.includes(ids.counselor!) && !rss.body.includes(ids.none!));
    assert.equal((await get("/feed/track/industry.xml?role=bogus")).status, 404);
    assert.equal((await get("/feed/full/track/industry.xml?role=bogus")).status, 404);
    assert.equal((await get("/feed/track/industry.xml?role=counselor&region=international")).status, 200);
  });
}));

test("with the switch off, nothing changes: role is an unknown parameter and no role fields are sent", () => withRoles(false, async () => {
  const rejected = await get("/api/v1/items?role=counselor");
  assert.equal(rejected.status, 400);
  assert.match(rejected.body, /Unknown query parameter: role/);
  assert.equal((await get("/api/v1/agent/latest?role=counselor")).status, 400);
  assert.equal((await get("/api/v1/agent/search?q=%E6%A0%87%E9%A2%98&role=counselor")).status, 400);

  // The site API ignores it (as it does any unknown parameter), even a bad one.
  for (const role of ["counselor", "bogus"]) {
    const pool = JSON.parse((await get(`/api/site/pool?role=${role}`)).body);
    assert.ok(idsOf(pool.items).has(ids.none!), "the filter is not applied");
    assert.ok(!("role" in pool.filters));
    const timeline = JSON.parse((await get(`/api/site/timeline?role=${role}`)).body);
    assert.ok(!("role" in timeline.filters));
  }
  assert.equal((await get("/feed/track/industry.xml?role=bogus")).status, 200);

  // No roles or impact in any item the exits send.
  const pool = JSON.parse((await get("/api/site/pool?track=industry")).body);
  const own = pool.items.filter((i: { id: string }) => Object.values(ids).includes(i.id));
  assert.ok(own.length >= 4);
  for (const item of own) assert.ok(!("roles" in item) && !("impact" in item));
  const v1 = JSON.parse((await get("/api/v1/items?mode=all&window=24h&limit=100")).body);
  assert.ok(idsOf(v1.items).size >= 4);
  for (const item of v1.items) assert.ok(!("roles" in item) && !("impact" in item));
  const timeline = await loadTimeline({ channel: "all", category: null, tag: null });
  for (const card of timeline.cards) assert.ok(!("roles" in card.item) && !("impact" in card.item));
  assert.ok(!/role=/.test(agentGuide()));
  // The selected sync payloads keep the old shape too.
  const payload = v1Payload({ articleId: ids.both!, title: "t", originalTitle: null, summary: null, sourceName: "s", url: "https://example.com/x",
    publishedAt: null, discoveredAt: new Date(), category: "policy", score: 80, selected: true, reason: null, roles: ["school"], impact: "rule" });
  assert.ok(!("roles" in payload) && !("impact" in payload));
}));

test("the 0059 backfill fills industry items from their analysis, and leaves the rest empty", async () => {
  const text = readFileSync(path.join(REPO_ROOT, "database/migrations/0059_publication_roles.sql"), "utf8");
  const update = text.slice(text.indexOf("UPDATE publications"));
  assert.ok(update.startsWith("UPDATE publications") && update.trimEnd().endsWith(";"));
  const mine = Object.values(ids);
  await sql`UPDATE publications SET roles = '{}', impact = NULL WHERE article_id IN ${sql(mine)}`;
  // An analysis whose roles are not a list must not break the statement.
  const odd = await article("odd", "policy", { roles: "school" });
  await sql`UPDATE publications SET roles = '{}', impact = NULL WHERE article_id = ${odd}`;

  await sql.unsafe(update);
  const checked: string[] = [...mine, odd];
  const rows = Object.fromEntries((await sql<{ article_id: string; roles: string[]; impact: string | null }[]>`
    SELECT article_id, roles, impact FROM publications WHERE article_id IN ${sql(checked)}`).map((r) => [r.article_id, r]));
  assert.deepEqual([rows[ids.both!]!.roles, rows[ids.both!]!.impact], [["school", "counselor"], "rule"]);
  assert.deepEqual([rows[ids.counselor!]!.roles, rows[ids.counselor!]!.impact], [["counselor"], "risk"]);
  assert.deepEqual([rows[ids.messy!]!.roles, rows[ids.messy!]!.impact], [["operator", "psychiatry", "community"], null]);
  for (const key of ["none", "academic", "promo"]) assert.deepEqual([rows[ids[key]!]!.roles, rows[ids[key]!]!.impact], [[], null], key);
  assert.deepEqual([rows[odd]!.roles, rows[odd]!.impact], [[], null], "roles that are not a list are ignored");

  // What the backfill wrote is what publishing derives: no spurious change on the next publish.
  for (const id of mine) assert.equal((await publishArticle(id))?.changed, false, id);
});

async function mcp(method: string, params: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST", url: "/api/mcp",
    headers: { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
  const text = res.body.startsWith("event:") || res.body.includes("\ndata:") ? res.body.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : res.body;
  return { status: res.statusCode, rpc: JSON.parse(text) as { result?: any; error?: any } };
}

test("MCP takes role only with the switch on, and its items carry roles and impact", async () => {
  const toolNames = async () => (await mcp("tools/list", {})).rpc.result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
  const latest = (await toolNames()).find((t) => "mode" in t.inputSchema.properties)!;

  await withRoles(false, async () => {
    assert.ok(!("role" in (await toolNames()).find((t) => t.name === latest.name)!.inputSchema.properties));
    const res = (await mcp("tools/call", { name: latest.name, arguments: { mode: "all", window: "24h", role: "counselor" } })).rpc;
    assert.ok(res.error || res.result?.isError, "role is an unknown argument");
    const ok = (await mcp("tools/call", { name: latest.name, arguments: { mode: "all", window: "24h", limit: 30 } })).rpc.result;
    for (const item of ok.structuredContent.items) assert.ok(!("roles" in item) && !("impact" in item));
  });
  await withRoles(true, async () => {
    assert.ok("role" in (await toolNames()).find((t) => t.name === latest.name)!.inputSchema.properties);
    const result = (await mcp("tools/call", { name: latest.name, arguments: { mode: "all", window: "24h", role: "counselor", limit: 30 } })).rpc.result;
    assert.ok(!result.isError, JSON.stringify(result).slice(0, 300));
    assert.deepEqual(idsOf(result.structuredContent.items), named("both", "counselor"));
    assert.deepEqual(result.structuredContent.items.find((i: { id: string }) => i.id === ids.counselor).roles, ["counselor"]);
    const bad = (await mcp("tools/call", { name: latest.name, arguments: { mode: "all", role: "bogus" } })).rpc;
    assert.ok(bad.error || bad.result?.isError);
  });
});
