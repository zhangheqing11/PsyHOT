import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs, { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { closeDb, sql } from "@aihot/backend/db";
import { TOPIC_TAGS } from "@aihot/industry/taxonomy";
import { SELECTION } from "@aihot/industry/selection";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { listTopics, listTopicSummaries, loadTopicPage, loadTopicTags, resolveTopicAlias, seedTopics, topicPageCounts } from "@aihot/backend/publication/topics";
import { buildApp } from "../apps/api/src/app.ts";
import { parseFilters } from "../apps/api/src/routes/site.ts";

const catalog = JSON.parse(readFileSync(new URL("../industry/topics.json", import.meta.url), "utf8")) as {
  groups: Array<{ key: string }>;
  topics: Array<{ slug: string; group: string; tags: string[]; related: string[] }>;
  aliases?: Record<string, { to: string; tag?: string }>;
};

const T = tag();
const SOURCES = [0, 1, 2, 3].map((n) => `topics-${T}-${n}`);
let NOW = new Date("2097-06-15T12:00:00Z");
const DAY = 86400_000;
let sequence = 0;
const app = await buildApp();

before(async () => {
  const [latest] = await sql<{ at: Date | null }[]>`SELECT max(timeline_at) AS at FROM publications`;
  // Keep these fixtures newer than other suites' rows so paginated order stays predictable.
  NOW = new Date(Math.max(NOW.getTime(), (latest.at?.getTime() ?? 0) + 40 * DAY));
  for (const [n, id] of SOURCES.entries()) {
    await sql`INSERT INTO sources (id, name, kind, tier, region, next_fetch_at)
      VALUES (${id}, ${`主题测试来源 ${n}`}, 'rss', 'T1', ${n === 0 ? "domestic" : "international"}, '2200-01-01')`;
  }
});
beforeEach(async () => {
  await sql`DELETE FROM articles WHERE source_id = ANY(${SOURCES}::text[])`;
  await sql`DELETE FROM stories WHERE title = ${`topics-${T}`}`;
  await seedTopics();
});
after(async () => {
  await sql`DELETE FROM articles WHERE source_id = ANY(${SOURCES}::text[])`;
  await sql`DELETE FROM stories WHERE title = ${`topics-${T}`}`;
  await sql`DELETE FROM sources WHERE id = ANY(${SOURCES}::text[])`;
  await app.close();
  await closeDb();
});

async function item(options: {
  tags?: string[]; category?: string; age?: number; source?: number; selected?: boolean;
  visibleAfter?: Date; promotion?: boolean; backfill?: boolean; eligible?: boolean; visibility?: string;
  dims?: { sig: number; nov: number; act: number; cred: number; reson: number };
  dimsSum?: number; scores?: number[] | null | { mean: number }; scoringPath?: string; story?: number | null;
} = {}) {
  const n = ++sequence;
  const source = SOURCES[options.source ?? 0];
  const at = new Date(NOW.getTime() - (options.age ?? 0) * DAY);
  const { articleId: id } = await upsertMaterial({
    sourceId: source, url: `https://example.com/topics-${T}-${n}`, title: `主题条目 ${n}`, bodyText: "测试正文。".repeat(40), bodyStatus: "ok", via: "fetch", publishedAt: at,
  });
  const dims = options.dims ?? { sig: 3, nov: 3, act: 3, cred: 3, reson: 3 };
  const scoringPath = options.scoringPath ?? "dims";
  const output = { scoringPath,
    ...(scoringPath === "dims" ? { dims, dimsSum: options.dimsSum ?? Object.values(dims).reduce((a, b) => a + b, 0) } : {}),
    ...(options.scores !== undefined ? { scores: options.scores } : {}), why: "仅供内部判断", event: "内部事件", contentType: "paper" };
  const [analysis] = await sql<{ id: number }[]>`INSERT INTO analyses (article_id, input_revision, origin, output)
    VALUES (${id}, 1, 'rule', ${sql.json(output)}) RETURNING id`;
  await sql`INSERT INTO publications (article_id, analysis_id, title, summary, tags, category, source_id, channel, url,
      discovered_at, timeline_at, sort_at, selected, visible_after, eligible, promotion, backfill, visibility, story_id)
    VALUES (${id}, ${analysis.id}, ${`主题标题 ${n}`}, '测试摘要', ${options.tags ?? ["抑郁"]}, ${options.category ?? "research"}, ${source}, 'news', ${`https://example.com/topics-${T}-${n}`},
      ${at}, ${at}, ${at}, ${options.selected ?? false}, ${options.visibleAfter ?? new Date(Date.now() - DAY)}, ${options.eligible ?? true},
      ${options.promotion ?? false}, ${options.backfill ?? false}, ${options.visibility ?? "public"}, ${options.story ?? null})`;
  return id;
}

test("topic catalog has 31 topics in field, genre, company order", () => {
  assert.deepEqual(catalog.groups.map((g) => g.key), ["field", "genre", "company"]);
  assert.equal(catalog.topics.length, 31);
  for (const [group, count] of Object.entries({ field: 9, genre: 10, company: 12 })) {
    assert.equal(catalog.topics.filter((t) => t.group === group).length, count, group);
  }
  assert.equal(new Set(catalog.topics.map((t) => t.slug)).size, catalog.topics.length);
});

test("aliases and related topics point to live slugs and valid subtags", () => {
  const topics = new Map(catalog.topics.map((t) => [t.slug, t]));
  assert.ok(catalog.aliases);
  assert.equal(Object.keys(catalog.aliases).length, 36);
  assert.ok(!Object.hasOwn(catalog.aliases, "psychotherapy"));
  for (const [slug, alias] of Object.entries(catalog.aliases)) {
    assert.ok(!topics.has(slug), slug);
    const target = topics.get(alias.to);
    assert.ok(target, slug);
    if (alias.tag) assert.ok(target.tags.includes(alias.tag), `${slug}: ${alias.tag}`);
  }
  for (const t of catalog.topics) {
    assert.ok(t.related.length <= 3, t.slug);
    assert.equal(new Set(t.related).size, t.related.length, t.slug);
    for (const slug of t.related) assert.ok(topics.has(slug), `${t.slug}: ${slug}`);
  }
});

test("field topics cover the taxonomy, with open science explicitly moved to genre", () => {
  const fieldTags = new Set(catalog.topics.filter((t) => t.group === "field").flatMap((t) => t.tags));
  // The requested nine fields exclude 开放科学, which belongs to the merged genre instead.
  for (const label of TOPIC_TAGS.filter((t) => t !== "开放科学")) assert.ok(fieldTags.has(label), label);
  assert.ok(catalog.topics.find((t) => t.slug === "methods-integrity" && t.group === "genre")?.tags.includes("开放科学"));
});

test("seeding twice removes obsolete rows and clears both directory caches", async () => {
  assert.equal(await seedTopics(), 31);
  const slug = `obsolete-${tag()}`;
  await sql`INSERT INTO topics (slug, name, grp, tags, definition, position) VALUES (${slug}, '旧主题', 'field', ${["旧标签"]}, '旧定义', 999)`;
  assert.ok((await listTopics()).some((t) => t.slug === slug));
  assert.ok((await topicPageCounts()).some((t) => t.slug === slug));
  assert.equal(await seedTopics(), 31);
  const rows = await sql<{ slug: string }[]>`SELECT slug FROM topics`;
  assert.equal(rows.length, 31);
  assert.ok(!rows.some((r) => r.slug === slug));
  assert.ok(!(await listTopics()).some((t) => t.slug === slug));
  assert.ok(!(await topicPageCounts()).some((t) => t.slug === slug));
});

test("aliases are loaded lazily once while every seed still rereads the catalog", async (t) => {
  const read = t.mock.method(fs, "readFileSync");
  syncBuiltinESMExports();
  t.after(() => { read.mock.restore(); syncBuiltinESMExports(); });
  // A fresh module instance lets the test observe the first alias lookup independently of other tests.
  const topics = await import(new URL(`../packages/backend/src/publication/topics.ts?alias-cache=${T}`, import.meta.url).href);
  const catalogPath = fileURLToPath(new URL("../industry/topics.json", import.meta.url));
  const reads = () => read.mock.calls.filter((call) => String(call.arguments[0]) === catalogPath).length;
  assert.equal(reads(), 0);
  assert.deepEqual(topics.resolveTopicAlias("depression"), { to: "mood-trauma", tag: "抑郁" });
  assert.deepEqual(topics.resolveTopicAlias("psychosis"), { to: "disorders-addiction", tag: null });
  assert.equal(topics.resolveTopicAlias("unknown-topic"), null);
  assert.equal(reads(), 1);
  assert.equal(await topics.seedTopics(), 31);
  assert.equal(reads(), 2);
  assert.deepEqual(topics.resolveTopicAlias("depression"), { to: "mood-trauma", tag: "抑郁" });
  assert.equal(reads(), 2);
  assert.equal(await topics.seedTopics(), 31);
  assert.equal(reads(), 3);
});

test("legacy topic filters preserve their original scope", async () => {
  await seedTopics();
  assert.deepEqual(await loadTopicTags("depression"), ["抑郁"]);
  assert.deepEqual(await loadTopicTags("psychosis"), ["精神病性障碍", "双相", "孤独症/ADHD", "进食障碍", "成瘾"]);
  assert.equal(await loadTopicTags("does-not-exist"), null);
  assert.deepEqual(resolveTopicAlias("depression"), { to: "mood-trauma", tag: "抑郁" });
  assert.deepEqual(resolveTopicAlias("psychosis"), { to: "disorders-addiction", tag: null });
  assert.equal(resolveTopicAlias("psychotherapy"), null);
  assert.equal(resolveTopicAlias("__proto__"), null);
  assert.deepEqual((await parseFilters({ topic: "depression" })).topicTags, ["抑郁"]);
});

test("topic counts split tracks, obey release gates, count subtags and keep the two latest titles", async () => {
  const subtagsBefore = (await loadTopicPage("cognition-neuro", 1))!.topic.subtags;
  const summariesBefore = await listTopicSummaries();
  const academicBefore = await listTopicSummaries("academic");
  const industryBefore = await listTopicSummaries("industry");
  const newest = await item({ selected: true, tags: ["认知", "决策"], age: -2 });
  const second = await item({ selected: true, tags: ["认知"], category: "policy", age: -1 });
  const third = await item({ selected: true, tags: ["决策"], age: 0 });
  // Old enough to be outside the real clock's 30-day window.
  await item({ selected: true, tags: ["生理/神经"], age: (NOW.getTime() - Date.now()) / DAY + 31 });
  await item({ selected: true, tags: ["认知"], age: -3, visibleAfter: new Date(Date.now() + DAY) });
  await item({ selected: true, tags: ["认知"], visibility: "withdrawn" });
  await seedTopics();
  const summary = (await listTopicSummaries()).find((t) => t.slug === "cognition-neuro")!;
  const academic = (await listTopicSummaries("academic")).find((t) => t.slug === summary.slug)!;
  const industry = (await listTopicSummaries("industry")).find((t) => t.slug === summary.slug)!;
  const previous = summariesBefore.find((t) => t.slug === summary.slug)!;
  assert.equal(summary.total - previous.total, 4);
  assert.equal(summary.recent - previous.recent, 3);
  assert.equal(academic.total - academicBefore.find((t) => t.slug === summary.slug)!.total, 3);
  assert.equal(industry.total - industryBefore.find((t) => t.slug === summary.slug)!.total, 1);
  assert.equal(academic.indexable, summary.indexable);
  assert.equal(industry.indexable, summary.indexable);
  assert.deepEqual(summary.latestItems.map((it) => it.id), [newest, second]);
  assert.deepEqual(academic.latestItems.map((it) => it.id), [newest, third]);
  assert.deepEqual(industry.latestItems.map((it) => it.id), [second]);
  assert.ok(summary.latestItems.every((it) => typeof it.title === "string"));
  const count = (await topicPageCounts()).find((c) => c.slug === summary.slug)!;
  const subtags = (await loadTopicPage(summary.slug, 1))!.topic.subtags;
  for (const [tag, expected] of Object.entries({ "认知": 2, "决策": 2, "生理/神经": 1 })) {
    assert.equal(subtags.find((s) => s.tag === tag)!.total - subtagsBefore.find((s) => s.tag === tag)!.total, expected, tag);
  }
  assert.equal(count.pages, Math.max(1, Math.ceil(summary.total / 20)));
});

test("topic subtag filters narrow selected items and reject tags outside the topic", async () => {
  const previous = await loadTopicPage("mood-trauma", 1, { tag: "抑郁" }, NOW);
  const depression = await item({ selected: true });
  await item({ selected: true, tags: ["焦虑"] });
  await seedTopics();
  const page = await loadTopicPage("mood-trauma", 1, { tag: "抑郁" }, NOW);
  assert.ok(page);
  assert.ok(page.items.some((it) => it.id === depression));
  assert.ok(page.items.every((it) => it.tags.includes("抑郁")));
  assert.equal(page.topic.total, previous!.topic.total + 1);
  assert.deepEqual(page.topic.subtags.map((s) => s.tag), ["抑郁", "焦虑", "创伤/PTSD", "压力/情绪", "睡眠", "自杀/自伤"]);
  assert.equal(page.topic.subtags.find((s) => s.tag === "抑郁")!.total, page.topic.total);
  assert.deepEqual((await loadTopicPage("research", 1, {}, NOW))!.topic.subtags, []);
  assert.equal(await loadTopicPage("mood-trauma", 1, { tag: "认知" }, NOW), null);
  assert.equal(await loadTopicPage("who", 1, { tag: "WHO" }, NOW), null, "company mentions are not subject tags");
});

test("subtag counts follow track, region and role without narrowing to the active tag", async () => {
  const scenarios = [
    { filters: { track: "academic" as const }, total: 2, allTotal: 3, anxiety: 1 },
    { filters: { track: "academic" as const, region: "domestic" as const }, total: 1, allTotal: 2, anxiety: 1 },
    { filters: { track: "industry" as const, region: "domestic" as const, role: "counselor" as const }, total: 1, allTotal: 2, anxiety: 1 },
  ];
  const before = await Promise.all(scenarios.map(({ filters }) => loadTopicPage("mood-trauma", 1, { ...filters, tag: "抑郁" }, NOW)));
  await item({ selected: true });
  await item({ selected: true, tags: ["焦虑"] });
  await item({ selected: true, source: 1, tags: ["抑郁", "抑郁"] });
  const counselorItems = [
    await item({ selected: true, category: "policy" }),
    await item({ selected: true, category: "policy", tags: ["焦虑"] }),
    await item({ selected: true, category: "policy", source: 1 }),
  ];
  await sql`UPDATE publications SET roles = ${["counselor"]}::text[], selected_roles = ${["counselor"]}::text[] WHERE article_id = ANY(${counselorItems}::text[])`;
  await item({ selected: true, category: "policy" }); // Not selected for the counselor role.
  await item({ selected: true, visibleAfter: new Date(NOW.getTime() + DAY) });
  await item({ selected: true, visibility: "withdrawn" });
  await item({ selected: true, tags: ["认知"] });
  await item(); // Unselected items do not contribute to the counts.
  await seedTopics();
  for (const [i, scenario] of scenarios.entries()) {
    const page = await loadTopicPage("mood-trauma", 1, { ...scenario.filters, tag: "抑郁" }, NOW);
    assert.ok(page && before[i]);
    const previous = before[i]!.topic;
    assert.equal(page.topic.total - previous.total, scenario.total);
    assert.equal(page.topic.allTotal - previous.allTotal, scenario.allTotal);
    for (const { tag, total } of page.topic.subtags) {
      const expected = tag === "抑郁" ? scenario.total : tag === "焦虑" ? scenario.anxiety : 0;
      assert.equal(total - previous.subtags.find((s) => s.tag === tag)!.total, expected, `${JSON.stringify(scenario.filters)}: ${tag}`);
      assert.ok(total <= page.topic.allTotal, tag);
    }
  }
});

test("indexability and sitemap pagination always use all tracks", async () => {
  for (let n = 0; n < 19; n++) await item({ selected: true, tags: ["进化"] });
  await item({ selected: true, tags: ["进化"], category: "policy" });
  await seedTopics();
  const all = (await listTopicSummaries()).find((t) => t.slug === "cognition-neuro")!;
  const industry = (await listTopicSummaries("industry")).find((t) => t.slug === all.slug)!;
  assert.ok(all.total >= 20);
  assert.equal(all.indexable, true);
  assert.equal(industry.indexable, true);
  const count = (await topicPageCounts()).find((t) => t.slug === all.slug)!;
  assert.equal(count.total, all.total);
  assert.equal(count.pages, Math.ceil(all.total / 20));
  assert.equal(count.latest?.toISOString(), all.latestAt);
});

/** Tests pin behaviour to the configured floors, so a recalibration only changes the snapshot below. */
const floor = (slug: string) => SELECTION.topicPicks.floors[slug]!;

test("topic pick thresholds use the approved per-topic calibration", () => {
  assert.deepEqual(SELECTION.topicPicks, {
    minSum: 14, minCred: 2,
    floors: { "cognition-neuro": 71, "social-personality": 71, "development-education": 75, "mood-trauma": 75,
      "disorders-addiction": 62, psychotherapy: 72, "medication-neuromodulation": 71, "digital-ai": 71,
      applied: 66, "methods-integrity": 74 },
  });
});

test("topic picks require sum 14, cred 2 and a coarse-score mean at or above the topic floor", async () => {
  const before = (await loadTopicPage("mood-trauma", 1, {}, NOW))!;
  const good = [
    await item({ dims: { sig: 3, nov: 3, act: 3, cred: 2, reson: 3 }, scores: [floor("mood-trauma") - 2, floor("mood-trauma") + 2] }),
    await item({ scores: [floor("mood-trauma") + 1, floor("mood-trauma") + 3] }),
  ];
  const excluded = [
    await item({ dims: { sig: 3, nov: 3, act: 3, cred: 2, reson: 2 }, scores: [100] }),
    await item({ dims: { sig: 4, nov: 4, act: 3, cred: 1, reson: 3 }, scores: [100] }),
    await item({ scores: [floor("mood-trauma") - 1, floor("mood-trauma")] }),
    await item({ scores: [0, 100] }), // The average counts, not the highest coarse score.
    await item(), await item({ scores: [] }), await item({ scores: null }), await item({ scores: { mean: 90 } }),
    await item({ scores: [90], scoringPath: "roles" }),
    await item({ scores: [90], promotion: true }), await item({ scores: [90], backfill: true }),
    await item({ scores: [90], eligible: false }), await item({ scores: [90], visibility: "withdrawn" }),
    await item({ scores: [90], visibility: "summary-only" }),
  ];
  const page = (await loadTopicPage("mood-trauma", 1, {}, NOW))!;
  assert.equal(page.topic.total, before.topic.total + good.length);
  for (const id of good) assert.ok(page.items.some((it) => it.id === id) && page.fieldPickIds.includes(id));
  for (const id of excluded) assert.ok(!page.items.some((it) => it.id === id));
});

test("only configured topics add picks and the same article uses each topic's own floor", async () => {
  const id = await item({ scores: [floor("disorders-addiction")], tags: ["成瘾", "AI与心理", "研究发现", "entity:who"] });
  const methods = await item({ scores: [floor("methods-integrity")], tags: ["方法/统计"] });
  const disorders = (await loadTopicPage("disorders-addiction", 1, {}, NOW))!;
  assert.equal(disorders.topic.hasPicks, true);
  assert.ok(disorders.fieldPickIds.includes(id));
  const digital = (await loadTopicPage("digital-ai", 1, {}, NOW))!;
  assert.equal(digital.topic.hasPicks, true);
  assert.ok(!digital.items.some((it) => it.id === id));
  assert.ok((await loadTopicPage("methods-integrity", 1, {}, NOW))!.fieldPickIds.includes(methods));
  for (const slug of ["research", "who"]) {
    const page = (await loadTopicPage(slug, 1, {}, NOW))!;
    assert.equal(page.topic.hasPicks, false);
    assert.deepEqual(page.fieldPickIds, []);
    assert.ok(!page.items.some((it) => it.id === id));
  }
});

test("a lone qualifying pick remains listed after 30 days and does not expire as time passes", async () => {
  const id = await item({ scores: [80], age: 30 });
  for (const now of [NOW, new Date(NOW.getTime() + 180 * DAY)]) {
    const page = (await loadTopicPage("mood-trauma", 1, {}, now))!;
    assert.ok(page.items.some((it) => it.id === id));
    assert.ok(page.fieldPickIds.includes(id));
  }
});

test("selected items and picks share chronological paging without story, source or six-item caps", async () => {
  const before = (await loadTopicPage("mood-trauma", 1, {}, NOW))!;
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title) VALUES (${randomUUID()}, ${`topics-${T}`}) RETURNING id`;
  const ids: string[] = [];
  const picks: string[] = [];
  for (let n = 0; n < 25; n++) {
    const selected = n % 2 === 0;
    const id = await item({ selected, age: n / 10, scores: [80], story: story.id });
    ids.push(id);
    if (!selected) picks.push(id);
  }
  const first = (await loadTopicPage("mood-trauma", 1, {}, NOW))!;
  const second = (await loadTopicPage("mood-trauma", 2, {}, NOW))!;
  assert.equal(first.topic.total, before.topic.total + 25);
  assert.equal(first.topic.allTotal, first.topic.total);
  assert.equal(first.pageCount, Math.ceil(first.topic.total / 20));
  assert.deepEqual(first.items.map((it) => it.id), ids.slice(0, 20));
  assert.deepEqual(second.items.slice(0, 5).map((it) => it.id), ids.slice(20));
  assert.deepEqual(first.fieldPickIds, ids.slice(0, 20).filter((id) => picks.includes(id)));
  assert.deepEqual(second.fieldPickIds.filter((id) => ids.includes(id)), ids.slice(20).filter((id) => picks.includes(id)));
  for (const page of [first, second]) {
    assert.deepEqual(page.fieldPickIds, page.items.filter((it) => !it.selected).map((it) => it.id));
  }
});

test("subtopics use their parent's floor and include picks in both subtag and whole-topic counts", async () => {
  const previous = (await loadTopicPage("mood-trauma", 1, { tag: "抑郁" }, NOW))!;
  const depression = await item({ scores: [floor("mood-trauma")] });
  const anxiety = await item({ scores: [floor("mood-trauma")], tags: ["焦虑"] });
  const selected = await item({ selected: true, tags: ["焦虑"] });
  const low = await item({ scores: [floor("mood-trauma") - 1], tags: ["焦虑"] });
  const page = (await loadTopicPage("mood-trauma", 1, { tag: "抑郁" }, NOW))!;
  assert.equal(page.topic.total, previous.topic.total + 1);
  assert.equal(page.topic.allTotal, previous.topic.allTotal + 3);
  assert.equal(page.topic.subtags.find((s) => s.tag === "焦虑")!.total, previous.topic.subtags.find((s) => s.tag === "焦虑")!.total + 2);
  assert.ok(page.fieldPickIds.includes(depression));
  for (const id of [anxiety, selected, low]) assert.ok(!page.items.some((it) => it.id === id));
});

test("academic views include picks while industry and role views retain only global selections", async () => {
  const pick = await item({ scores: [80] });
  const industryCandidate = await item({ scores: [100], scoringPath: "roles", category: "policy" });
  const selected = await item({ selected: true, category: "policy", scoringPath: "roles" });
  await sql`UPDATE publications SET roles = ${["counselor"]}::text[], selected_roles = ${["counselor"]}::text[] WHERE article_id = ANY(${[pick, selected]}::text[])`;
  const academic = (await loadTopicPage("mood-trauma", 1, { track: "academic" }, NOW))!;
  assert.ok(academic.fieldPickIds.includes(pick));
  for (const filters of [{ track: "industry" as const }, { role: "counselor" as const }]) {
    const page = (await loadTopicPage("mood-trauma", 1, filters, NOW))!;
    assert.deepEqual(page.fieldPickIds, []);
    assert.ok(page.items.some((it) => it.id === selected));
    assert.ok(!page.items.some((it) => [pick, industryCandidate].includes(it.id)));
  }
});

test("directory counts, latest titles and sitemap pages agree with topic lists for every topic and track", async () => {
  const previous = new Map((await listTopicSummaries()).map((t) => [t.slug, t]));
  await item({ scores: [floor("cognition-neuro")], tags: ["认知", "AI与心理"] });
  await item({ scores: [floor("mood-trauma")], tags: ["抑郁"] });
  await item({ scores: [floor("methods-integrity")], tags: ["方法/统计"] });
  await item({ scores: [floor("medication-neuromodulation")], tags: ["精神药物"], source: 1, age: (NOW.getTime() - Date.now()) / DAY + 35 });
  await item({ scores: [100], tags: ["认知"], backfill: true });
  await item({ scores: [100], tags: ["认知"], promotion: true });
  await item({ scores: [100], tags: ["认知"], visibility: "withdrawn" });
  await item({ selected: true, tags: ["认知"], visibleAfter: new Date(NOW.getTime() + DAY) });
  await item({ selected: true, category: "policy", scoringPath: "roles", tags: ["抑郁"] });
  await item({ selected: true, tags: ["认知"] });
  await seedTopics();
  const counts = new Map((await topicPageCounts()).map((c) => [c.slug, c]));
  const current = new Map((await listTopicSummaries()).map((t) => [t.slug, t]));
  assert.equal(current.get("cognition-neuro")!.recent - previous.get("cognition-neuro")!.recent, 2);
  assert.equal(current.get("medication-neuromodulation")!.total - previous.get("medication-neuromodulation")!.total, 1);
  assert.equal(current.get("medication-neuromodulation")!.recent, previous.get("medication-neuromodulation")!.recent);
  for (const track of [null, "academic", "industry"] as const) {
    for (const summary of await listTopicSummaries(track)) {
      const page = (await loadTopicPage(summary.slug, 1, { track }))!;
      assert.equal(summary.total, page.topic.total, `${track ?? "all"}: ${summary.slug}`);
      assert.equal(summary.hasPicks, Object.hasOwn(SELECTION.topicPicks.floors, summary.slug));
      assert.deepEqual(summary.latestItems.map((it) => it.id), page.items.slice(0, 2).map((it) => it.id), summary.slug);
      assert.equal(summary.latestAt, page.items[0]?.timelineAt ?? null, summary.slug);
      if (!track) assert.equal(counts.get(summary.slug)!.pages, page.pageCount, summary.slug);
    }
  }
});

test("site topics API validates tracks, varies etags and forwards subtag filters", async () => {
  await item({ selected: true });
  await item({ selected: true, category: "policy" });
  const pick = await item({ scores: [80] });
  await seedTopics();
  const all = await app.inject("/api/site/topics");
  const academic = await app.inject("/api/site/topics?track=academic");
  const industry = await app.inject("/api/site/topics?track=industry");
  const total = (response: typeof all) => response.json().topics.find((t: { slug: string }) => t.slug === "mood-trauma").total;
  assert.equal(all.statusCode, 200);
  assert.equal(total(all), total(academic) + total(industry));
  assert.notEqual(all.headers.etag, academic.headers.etag);
  assert.notEqual(academic.headers.etag, industry.headers.etag);
  assert.equal((await app.inject("/api/site/topics?track=invalid")).statusCode, 400);
  assert.equal((await app.inject(`/api/site/topics/mood-trauma?tag=${encodeURIComponent("认知")}`)).statusCode, 404);
  const page = await app.inject(`/api/site/topics/mood-trauma?tag=${encodeURIComponent("抑郁")}`);
  assert.equal(page.statusCode, 200);
  assert.ok(page.json().items.every((it: { tags: string[] }) => it.tags.includes("抑郁")));
  assert.ok(page.json().fieldPickIds.includes(pick));
  assert.equal(page.json().topic.hasPicks, true);
  assert.equal(Object.hasOwn(page.json(), "worth"), false);
  assert.doesNotMatch(page.body, /"(?:dims|dimsSum|scores|scoringPath|why|event|contentType)"/);
});
