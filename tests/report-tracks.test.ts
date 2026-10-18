// Reports by track: a daily groups its sections academic first, then industry, with one lead for each
// side from a single model call; weekly and monthly reports keep their themes and overview per side.
// The whole report stays what readers that do not know tracks always got (lead, highlights, sections),
// and a track's view shows only that side. Older reports still load.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { dailyEmail } from "@aihot/backend/notify/email-render";
import { loadReport } from "@aihot/backend/publication/reports";
import { publishArticle } from "@aihot/backend/publication/publish";
import { composeDaily, composeWeekly, pickTop } from "@aihot/backend/reports/compose";

const T = tag();
const SOURCE = `test-report-tracks-${T}`;
const DAILY = "2020-03-02";
const WEEK = "2020-W09"; // 2020-02-24 to 2020-03-01
const LEGACY_DAILY = "2020-03-03";
const LEGACY_WEEK = "2020-W08";
const prompts: Array<{ system: string; user: string }> = [];
const provider = await stub((hit, req) => {
  const messages = JSON.parse(req.body).messages as Array<{ role: string; content: string }>;
  const system = messages[0]!.content;
  const user = messages[1]!.content;
  prompts.push({ system, user });
  let content: unknown;
  if (system.includes("日报主编")) {
    const industryFirst = Number(/【业界】\n(\d+)\./.exec(user)?.[1]);
    content = {
      academic: { title: "学界头条", leadParagraph: "学界的一段导语。", highlights: [1, 2] },
      industry: industryFirst ? { title: "业界头条", leadParagraph: "业界的一段导语。", highlights: [industryFirst, 1] } : null,
    };
  } else {
    const industryFirst = user.split("\n").find((l) => l.includes("[业界·"))?.split(".")[0];
    content = {
      headline: "本周主线",
      academic: { overview: "2020-02-24 至 2020-03-01，学界总述。", themes: [{ heading: "学界主题", summary: "学界主题的概述。", refs: [1, industryFirst ? Number(industryFirst) : 1] }] },
      industry: industryFirst ? { overview: "业界总述。", themes: [{ heading: "业界主题", summary: "业界主题的概述。", refs: [Number(industryFirst), 1] }] } : null,
    };
  }
  return { id: `report-tracks-${T}-${hit}`, choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";

before(async () => {
  // Items of an earlier run would fall in the same days.
  await sql`UPDATE publications SET selected = false WHERE source_id LIKE 'test-report-tracks-%'`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Report tracks test', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await sql`DELETE FROM reports WHERE (kind = 'daily' AND key IN (${DAILY}, ${LEGACY_DAILY})) OR (kind = 'weekly' AND key IN (${WEEK}, ${LEGACY_WEEK}))`;
  await provider.close();
  await stopBoss();
  await closeDb();
});

async function selected(label: string, category: string, score: number): Promise<string> {
  const at = new Date("2020-03-01T12:00:00Z");
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/report-tracks-${T}-${label}`, title: `Report tracks ${label}`, bodyText: `Report tracks ${label} body`,
    bodyStatus: "ok", publishedAt: at, discoveredAt: at, via: "fetch",
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', ${category}, ${`标题 ${label}-${T}`}, ${`摘要 ${label}`}, ${score}, true)`;
  await publishArticle(articleId, { now: at, releasedAt: at });
  return articleId;
}

const ids: Record<string, string> = {};

test("a daily groups its sections by track and takes a lead for each side from one model call", async () => {
  // Nine research items: eight in the section, one over as a flash.
  for (let i = 1; i <= 9; i++) ids[`r${i}`] = await selected(`r${i}`, "research", 90 - i);
  ids.p1 = await selected("p1", "policy", 95); // the day's top story is on the industry side
  ids.d1 = await selected("d1", "digital", 70);
  await composeDaily(DAILY);

  const lead = prompts.find((p) => p.system.includes("日报主编"))!;
  assert.match(lead.user, /^【学界】\n1\. .*\n[\s\S]*\n\n【业界】\n\d+\. /, "one call, the entries grouped by track with continuous numbers");
  assert.equal(prompts.filter((p) => p.system.includes("日报主编")).length, 1);

  const [row] = await sql<{ content: Record<string, any> }[]>`SELECT content FROM reports WHERE kind = 'daily' AND key = ${DAILY}`;
  const c = row!.content;
  assert.deepEqual(c.sections.map((s: any) => [s.track, s.label]), [["academic", "研究发现"], ["industry", "行业与政策"]], "academic first, then industry");
  assert.equal(c.sections[0].items.length, 8);
  assert.deepEqual(c.flashes.map((f: any) => [f.itemId, f.track]), [[ids.r9, "academic"]]);
  assert.equal(c.tracks.academic.lead.title, "学界头条");
  assert.equal(c.tracks.industry.lead.title, "业界头条");
  assert.equal(c.lead.title, "业界头条", "the whole report's lead is the side holding the day's top story");
  // Industry highlights: its first entry (the policy item); "1" there is the academic entry and is dropped.
  assert.deepEqual(c.tracks.industry.highlights, [ids.p1]);
  assert.deepEqual(c.tracks.academic.highlights, [ids.r1, ids.r2]);
  assert.deepEqual(c.highlights, [ids.p1, ids.r1, ids.r2], "the sides alternate, the top side first");
});

test("the whole report, then each track's view of it", async () => {
  const all = (await loadReport("daily", DAILY))!;
  assert.equal(all.track, null);
  assert.deepEqual(all.leadParts.map((p) => [p.track, p.label, p.title]), [["academic", "学界", "学界头条"], ["industry", "业界", "业界头条"]]);
  assert.equal(all.lead?.title, "业界头条");
  assert.deepEqual(all.sections.map((s) => [s.track, s.label]), [["academic", "研究发现"], ["industry", "行业与政策"]]);
  assert.equal(all.metrics.totalEvents, 10, "the flash is not one of the day's events");

  const academic = (await loadReport("daily", DAILY, "academic"))!;
  assert.equal(academic.track, "academic");
  assert.deepEqual(academic.sections.map((s) => s.label), ["研究发现"]);
  assert.deepEqual(academic.leadParts, []);
  assert.equal(academic.lead?.title, "学界头条");
  assert.equal(academic.lead?.leadParagraph, "学界的一段导语。");
  assert.deepEqual(academic.highlights.map((h) => h.itemId), [ids.r1, ids.r2]);
  assert.deepEqual(academic.flashes.map((f) => f.itemId), [ids.r9]);
  assert.equal(academic.metrics.totalEvents, 8, "figures count what is shown");

  const industry = (await loadReport("daily", DAILY, "industry"))!;
  assert.deepEqual(industry.sections.map((s) => [s.label, s.items.length]), [["行业与政策", 2]]);
  assert.equal(industry.lead?.title, "业界头条");
  assert.deepEqual(industry.flashes, []);
  assert.equal(industry.metrics.totalEvents, 2);
});

test("a daily composed before tracks still loads, and splits by its section names", async () => {
  const citation = (itemId: string) => ({ itemId, title: `旧 ${itemId}`, summary: "s", sourceName: "x", sourceUrl: "https://example.com/x", sourceId: SOURCE, firstParty: false, role: null, storyPublicId: null, publishedAt: null });
  const content = {
    date: LEGACY_DAILY, lead: { title: "旧导语", leadParagraph: "旧段落。" }, highlights: [ids.r1], metrics: { totalEvents: 2 },
    sections: [{ label: "研究发现", items: [citation(ids.r1!)] }, { label: "行业与政策", items: [citation(ids.p1!)] }],
    flashes: [{ itemId: ids.r2, title: "旧快讯", sourceName: "x", sourceUrl: "https://example.com/y", publishedAt: new Date().toISOString() }],
  };
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, model, origin)
            VALUES ('daily', ${LEGACY_DAILY}, now() - interval '1 day', now(), ${sql.json(content as never)}, now(), 'test', 'model')`;
  const all = (await loadReport("daily", LEGACY_DAILY))!;
  assert.equal(all.lead?.title, "旧导语");
  assert.deepEqual(all.leadParts, [], "no two-part lead where there is none");
  assert.equal(all.flashes.length, 1);
  assert.deepEqual(all.metrics, { totalEvents: 2 }, "stored figures are shown as they were");

  const industry = (await loadReport("daily", LEGACY_DAILY, "industry"))!;
  assert.deepEqual(industry.sections.map((s) => s.label), ["行业与政策"]);
  assert.equal(industry.lead, null, "the day's lead was written for the whole day");
  assert.deepEqual(industry.flashes, [], "a flash without a recorded side is left out of a track's view");
});

test("a weekly keeps its themes and overview per side, cited from its own side only", async () => {
  await composeWeekly(WEEK);
  const prompt = prompts.find((p) => p.system.includes("周报主编"))!;
  assert.match(prompt.user, /\[学界·研究发现\]/);
  assert.match(prompt.user, /\[业界·行业与政策\]/);
  const [row] = await sql<{ content: Record<string, any> }[]>`SELECT content FROM reports WHERE kind = 'weekly' AND key = ${WEEK}`;
  const c = row!.content;
  assert.deepEqual(c.themes.map((t: any) => [t.track, t.heading]), [["academic", "学界主题"], ["industry", "业界主题"]]);
  // The academic theme asked for an industry entry too: it is not cited under the academic theme.
  assert.ok(c.themes[0].storyRefs.every((r: any) => [ids.r1, ids.r2, ids.r3, ids.r4, ids.r5, ids.r6, ids.r7, ids.r8, ids.r9].includes(r.itemId)));
  assert.ok(c.themes[1].storyRefs.every((r: any) => [ids.p1, ids.d1].includes(r.itemId)));
  assert.equal(c.overview, "2020-02-24 至 2020-03-01，学界总述。\n\n业界总述。");

  const all = (await loadReport("weekly", WEEK))!;
  assert.equal(all.trackSplit, true);
  assert.deepEqual(all.leadParts.map((p) => [p.track, p.title, p.leadParagraph]), [["academic", null, "2020-02-24 至 2020-03-01，学界总述。"], ["industry", null, "业界总述。"]]);
  assert.equal(all.lead?.title, "本周主线");
  const industry = (await loadReport("weekly", WEEK, "industry"))!;
  assert.deepEqual(industry.sections.map((s) => [s.track, s.label]), [["industry", "业界主题"]]);
  assert.equal(industry.overview, "业界总述。");
  assert.equal(industry.lead?.leadParagraph, "业界总述。");
  assert.equal(industry.lead?.title, "本周主线");
});

test("a weekly composed before tracks shows whole whatever track is asked for", async () => {
  const content = { kind: "weekly", title: "旧周报", headline: "旧主线", overview: "旧总述。", themes: [{ heading: "旧主题", summary: "s", storyRefs: [{ itemId: ids.r1, title: "旧", summary: "s", sourceName: "x", sourceUrl: "https://example.com/z" }] }], storyOrder: [], metrics: {} };
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, model, origin)
            VALUES ('weekly', ${LEGACY_WEEK}, now() - interval '7 day', now(), ${sql.json(content as never)}, now(), 'test', 'model')`;
  const view = (await loadReport("weekly", LEGACY_WEEK, "industry"))!;
  assert.equal(view.trackSplit, false);
  assert.equal(view.track, null);
  assert.deepEqual(view.sections.map((s) => s.label), ["旧主题"]);
  assert.equal(view.overview, "旧总述。");
});

test("an issue read for a track: its own lead, its own sections, and a link back to that track", async () => {
  const link = "https://example.test/unsubscribe?t=x";
  const whole = dailyEmail((await loadReport("daily", DAILY))!, link)!;
  assert.match(whole.subject, /业界头条/);
  for (const text of ["学界的一段导语。", "业界的一段导语。", "【学界·研究发现】", "【业界·行业与政策】", "标题 r1", "标题 p1"]) assert.ok(whole.text.includes(text), text);

  const industry = dailyEmail((await loadReport("daily", DAILY, "industry"))!, link)!;
  assert.match(industry.subject, /·业界 .*业界头条/);
  assert.ok(industry.text.includes("标题 p1") && industry.text.includes("标题 d1"));
  assert.ok(!industry.text.includes("标题 r1") && !industry.text.includes("学界的一段导语"), "nothing of the other side");
  assert.ok(industry.text.includes(`/daily/${DAILY}?track=industry`), "the link reads that side on the site");
});

test("the places in a weekly or monthly are kept for each side", () => {
  const items = [
    ...Array.from({ length: 8 }, (_, i) => ({ category: "research", n: i })),
    { category: "policy", n: 8 }, { category: "digital", n: 9 },
  ];
  // A quarter of the places (two of eight) for each side, the rest by score.
  assert.deepEqual(pickTop(items, 8).map((i) => i.n), [0, 1, 2, 3, 4, 5, 8, 9]);
  assert.equal(pickTop(items, 100).length, 10);
});
