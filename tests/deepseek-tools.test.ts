// DeepSeek Search and Fetch: the rules that keep a search result from counting as coverage, the
// lookup end to end against local stubs (an unselected story that scored 65) (search, then one judge call; kept pages become
// signals of the story under their site), its once-per-twelve-hours limit, and the body fallback
// never asking a reader for a page whose site refused us.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { extractFromUrl, fallbackAllowed } from "@aihot/backend/content/extract";
import { distinctTexts, lookupStoryCoverage, screen, siteOf, titleOverlap, webParticipant, WEB_LOOKUP_SOURCE } from "@aihot/backend/events/web-lookup";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";

const T = tag();
const SOURCE = `test-dst-${T}`;
const TITLE = `睡眠节律紊乱与抑郁亚型相关研究${T}`;
const ORIGINAL = `Researchers identify circadian subtype of depression ${T}`;
const now = new Date();
const day = (d: number) => new Date(now.getTime() + d * 24 * 3600 * 1000).toISOString();

const searches: string[] = [];
const fetched: string[] = [];
const PAGE_TEXT = "这项研究发现睡眠节律紊乱与一类抑郁亚型相关，研究者建议在治疗中评估昼夜节律。".repeat(8);
let judged = 0;
const provider = await stub((_hit, req) => {
  if (req.url.startsWith("/v1/tools/fetch")) {
    fetched.push((JSON.parse(req.body) as { url: string }).url);
    return { title: "页面", content: `# 页面\n\n${PAGE_TEXT}` };
  }
  if (req.url.startsWith("/v1/tools/search")) {
    const { query } = JSON.parse(req.body) as { query: string };
    searches.push(query);
    return { results: [
      { title: `New circadian subtype of depression identified ${T}`, url: `https://www.news-medical.net/news/${T}.aspx`, snippet: "s", summary: "Study in Nature Mental Health", site_name: "News-Medical", date: day(-1), rerank_score: 2, authority: 3 },
      { title: `Circadian subtype of depression ${T} – more`, url: `https://m.news-medical.net/other/${T}`, snippet: "", summary: "", site_name: null, date: day(-1), rerank_score: 1, authority: 3 },
      { title: ORIGINAL, url: `https://pmc.ncbi.nlm.nih.gov/articles/${T}`, snippet: "", summary: "", site_name: "PMC", date: day(-1), rerank_score: 3, authority: 4 },
      { title: ORIGINAL, url: `https://old.example.org/${T}`, snippet: "", summary: "", site_name: null, date: day(-60), rerank_score: 3, authority: 1 },
      { title: ORIGINAL, url: `https://nodate.example.org/${T}`, snippet: "", summary: "", site_name: null, date: null, rerank_score: 3, authority: 1 },
      { title: `睡眠节律紊乱与抑郁亚型${T}：最新研究`, url: `https://www.163.com/dy/article/${T}.html`, snippet: "", summary: "", site_name: "网易", date: day(0), rerank_score: 1.8, authority: 2 },
      { title: `完全无关的标题 ${T}`, url: `https://unrelated.example.com/${T}`, snippet: "", summary: "", site_name: null, date: day(0), rerank_score: 1, authority: 1 },
    ] };
  }
  // Other test files leave stories behind; only this file's story is counted.
  if (req.body.includes(`事件：${TITLE}`)) judged += 1;
  // The judge keeps News-Medical (W1) and turns down the 163.com page (W2).
  const answer = { decisions: [{ id: "W1", coverage: true }, { id: "W2", coverage: false }] };
  return { id: "stub", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
process.env.DEEPSEEK_TOOLS_BASE_URL = provider.url;
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.MODEL_CALLS_ENABLED = "true";
config.allowPrivateNetworkFetch = true;
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("sites and participants: registrable domains, WeChat accounts by __biz", () => {
  assert.equal(siteOf("https://m.163.com/dy/article/x.html"), "163.com");
  assert.equal(siteOf("https://www.cma.org.cn/a"), "cma.org.cn");
  assert.equal(webParticipant("https://mp.weixin.qq.com/s?__biz=MzA5NDU1ODE2NA%3D%3D&mid=1"), "wechat:MzA5NDU1ODE2NA==");
  assert.equal(webParticipant("https://news.qq.com/rain/a/1"), "web:qq.com");
  assert.ok(titleOverlap("睡眠节律紊乱与抑郁亚型", "睡眠节律紊乱与抑郁亚型：最新研究") > 0.7);
  assert.ok(titleOverlap("睡眠节律紊乱与抑郁亚型", "完全无关的标题") < 0.1);
});

test("screening keeps dated pages from the story's time, off scholarly hosts, mirrors and our own copies, from uncounted sites, one per site", () => {
  const story = { id: 1, title: TITLE, firstReportAt: new Date(day(-2)), titles: [TITLE, ORIGINAL], originalTitle: ORIGINAL, countedSites: new Set(["psypost.org"]), platformTitles: ["抑郁症or精神疾病78的准度协助你辨早期"] };
  const results = [
    { title: ORIGINAL, url: "https://www.news-medical.net/a", snippet: "", summary: "", siteName: null, date: new Date(day(-1)), rerankScore: 1, authority: 3 },
    { title: ORIGINAL, url: "https://news-medical.net/b", snippet: "", summary: "", siteName: null, date: new Date(day(-1)), rerankScore: 2, authority: 3 },
    { title: ORIGINAL, url: "https://www.psypost.org/a", snippet: "", summary: "", siteName: null, date: new Date(day(-1)), rerankScore: 2, authority: 3 },
    { title: ORIGINAL, url: "https://www.medrxiv.org/a", snippet: "", summary: "", siteName: null, date: new Date(day(-1)), rerankScore: 2, authority: 3 },
    { title: ORIGINAL, url: "https://https-pubmed-ncbi-nlm-nih-gov-443.webvpn.ynu.edu.cn/a", snippet: "", summary: "", siteName: null, date: new Date(day(-1)), rerankScore: 2, authority: 3 },
    { title: ORIGINAL, url: "https://old.example.org/a", snippet: "", summary: "", siteName: null, date: new Date(day(-30)), rerankScore: 2, authority: 3 },
    // An abstract mirror, a bot's post, and our own WeChat report copied to 网易号: none is anyone discussing it.
    { title: ORIGINAL, url: "https://www.ebiotrade.com/newsf/2026-10/a.htm", snippet: "", summary: "", siteName: null, date: new Date(day(-1)), rerankScore: 2, authority: 3 },
    { title: ORIGINAL, url: "https://clinicians-exchange.org/@psychbot/1", snippet: "", summary: "", siteName: null, date: new Date(day(-1)), rerankScore: 2, authority: 3 },
    { title: `${ORIGINAL} 抑郁症 or 精神疾病？78%的准度协助你辨早期！`, url: "https://www.163.com/dy/article/X.html", snippet: "", summary: "", siteName: null, date: new Date(day(-1)), rerankScore: 2, authority: 3 },
  ];
  const kept = screen(story, [{ query: ORIGINAL, results }], now);
  assert.deepEqual(kept.map((c) => [c.participant, c.url]), [["web:news-medical.net", "https://news-medical.net/b"]]);
});

test("a wire story or press release reprinted by several sites counts once; separate reports each count", () => {
  const page = (url: string, summary: string) => ({ title: ORIGINAL, url, snippet: "", summary, siteName: null, date: new Date(day(-1)), rerankScore: 1, authority: 1, participant: webParticipant(url)!, query: ORIGINAL });
  const wire = "新华社电 一项发表在国际期刊上的研究发现，在线认知行为治疗中由人工智能提供反馈，缓解社交焦虑的效果与人类治疗师接近，研究团队招募了数百名受试者。";
  const kept = distinctTexts([
    page("https://www.gmw.cn/a", wire),
    page("https://www.qzwb.com/b", `${wire}专家表示仍需更多研究。`),
    page("https://www.zaobao.com.sg/c", `（综合报道）${wire}`),
    page("https://www.sina.com.cn/d", "新华读报：AI还是真人？记者采访多位心理咨询师，他们认为AI可作为辅助工具，但无法替代面对面的治疗关系，相关伦理问题仍待讨论。"),
  ]);
  assert.deepEqual(kept.map((c) => c.participant), ["web:gmw.cn", "web:sina.com.cn"]);
});

test("the body fallback is never asked for a page its site refused or that sits behind a robot check", () => {
  assert.equal(fallbackAllowed("https://example.com/a", 403), false);
  assert.equal(fallbackAllowed("https://example.com/a", 412), false);
  assert.equal(fallbackAllowed("https://www.sciencedirect.com/science/article/pii/X", 200), false);
  assert.equal(fallbackAllowed("https://www.nhc.gov.cn/a", null), false);
  assert.equal(fallbackAllowed("https://example.com/a", 200), true);
  assert.equal(fallbackAllowed("https://example.com/a", null), true);
});

test("a page that only renders in a browser is read through DeepSeek Fetch; a refused one is not", async () => {
  const site = await stub((_hit, req) => (req.url === "/refused" ? new Reply(403, {}) : new Reply(200, {})));
  try {
    delete process.env.JINA_API_KEY;
    const got = await extractFromUrl(`${site.url}/script-only`, { allowJina: true, subject: `test:${T}` });
    assert.equal(got?.via, "deepseek");
    assert.ok(got!.text.includes("睡眠节律紊乱"));
    assert.equal(await extractFromUrl(`${site.url}/refused`, { allowJina: true, subject: `test:${T}` }), null);
    assert.deepEqual(fetched, [`${site.url}/script-only`]);
    const [receipt] = await sql<{ service: string; purpose: string }[]>`SELECT service, purpose FROM receipts WHERE subject = ${`test:${T}`}`;
    assert.deepEqual([receipt!.service, receipt!.purpose], ["deepseek-tools", "body_fallback"]);
  } finally {
    await site.close();
  }
});

test("an unselected story scoring 50 or more is searched by both titles, judged once, and its kept page counts as a signal", async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test dst', 'rss', 'T1', 'editorial', '2100-01-01')`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode) VALUES (${WEB_LOOKUP_SOURCE}, '网页 · 事件报道', 'external', 'T2', 'hot_signal') ON CONFLICT (id) DO NOTHING`;
  const [st] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${TITLE}, ${day(-2)}, now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`fact-${randomUUID()}`}, ${st!.id}, ${TITLE}) RETURNING id`;
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://www.psypost.org/${T}`, title: ORIGINAL, bodyText: "body ".repeat(80), bodyStatus: "ok", via: "fetch", publishedAt: new Date(day(-2)) });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'research', ${TITLE}, '摘要', '理由', 65, false)`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${articleId}, 'report')`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  const [pub] = await sql<{ story_id: number | null; selected: boolean }[]>`SELECT story_id, selected FROM publications WHERE article_id = ${articleId}`;
  assert.equal(Number(pub!.story_id), st!.id);
  assert.equal(pub!.selected, false, "a story one source reports and nobody selected is searched too");

  const first = await lookupStoryCoverage();
  assert.ok(searches.includes(TITLE) && searches.includes(ORIGINAL), "searched by the Chinese and the original title");
  assert.equal(judged, 1);
  const signals = await sql<{ participant_key: string; source_id: string; kind: string }[]>`
    SELECT ss.participant_key, ss.source_id, ss.kind FROM story_signals ss WHERE ss.story_id = ${st!.id} AND ss.source_id = ${WEB_LOOKUP_SOURCE}`;
  assert.deepEqual(signals.map((s) => [s.participant_key, s.kind]), [["web:news-medical.net", "signal"]]);
  assert.ok(first.kept >= 1);
  const [page] = await sql<{ processing_state: string; raw: { participant: string } }[]>`SELECT processing_state, raw FROM articles WHERE source_id = ${WEB_LOOKUP_SOURCE} AND url LIKE ${`%${T}.aspx`}`;
  assert.equal(page!.processing_state, "skipped", "a coverage page is never analysed");

  // Within the same twelve hours the story is not searched again.
  const ours = () => searches.filter((q) => q === TITLE || q === ORIGINAL).length;
  const count = ours();
  await lookupStoryCoverage();
  assert.equal(ours(), count);
  assert.equal(judged, 1);
});
