import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { createServer, type ViteDevServer } from "vite";
import type { FeedItemSummary } from "@aihot/contracts/site";

let vite: ViteDevServer;
let topics: typeof import("../app/routes/topics.tsx");
let topic: typeof import("../app/routes/topic.tsx");
let dayList: typeof import("../app/features/feed/DayList.tsx");
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), appType: "custom",
    server: { middlewareMode: true, ws: false }, ssr: { external: ["react", "react-dom", "react-router", "@aihot/contracts"], noExternal: ["@aihot/industry"] }, optimizeDeps: { noDiscovery: true } });
  topics = await vite.ssrLoadModule("/app/routes/topics.tsx") as typeof topics;
  topic = await vite.ssrLoadModule("/app/routes/topic.tsx") as typeof topic;
  dayList = await vite.ssrLoadModule("/app/features/feed/DayList.tsx") as typeof dayList;
});
after(async () => { await vite?.close(); });

function render(Component: ComponentType, data: unknown, path: string) {
  const router = createMemoryRouter([{ id: "test", path: "*", Component }], { initialEntries: [path], hydrationData: { loaderData: { test: data } } });
  try { return renderToStaticMarkup(createElement(RouterProvider, { router })); }
  finally { router.dispose(); }
}

const summary = { slug: "cognition-neuro", name: "认知与脑科学", group: "field" as const, definition: "注意、记忆与决策的研究。",
  total: 24, recent: 5, indexable: true, hasPicks: true, latestAt: new Date().toISOString(), latestItems: [{ id: "latest-one", title: "第一条最新标题" }, { id: "latest-two", title: "第二条最新标题" }] };
const pick: FeedItemSummary = { id: "pick-one", title: "领域中的一项新发现", summary: "这是一条领域补选的摘要。", reason: null, source: { name: "领域期刊" },
  publishedAt: null, timelineAt: new Date().toISOString(), category: "research", tags: ["抑郁"], score: 53, selected: false, channel: "news", x: null };
const selected: FeedItemSummary = { ...pick, id: "global-one", title: "全站精选研究", selected: true };
const data = {
  topic: { slug: "mood-trauma", name: "抑郁、焦虑与创伤", group: "field", definition: "机制与干预证据。", total: 5, allTotal: 24, indexable: true, hasPicks: true,
    subtags: [{ tag: "抑郁", total: 15 }, { tag: "焦虑", total: 12 }], related: [] },
  items: [selected, pick], fieldPickIds: [pick.id], page: 2, pageCount: 2,
};

test("topic directory shows cards, sparse chips and latest links while hiding zero-count topics", () => {
  const html = render(topics.default, { topics: [summary,
    { ...summary, slug: "sparse", name: "积累方向", total: 3, indexable: false, definition: "不能显示为卡片的定义" },
    { ...summary, slug: "empty", name: "空主题", total: 0 }], track: "academic" }, "/topics?track=academic");
  assert.equal((html.match(/class="card card-hover/g) ?? []).length, 1);
  assert.match(html, /内容还在积累/);
  assert.match(html, /href="\/topics\/sparse\?track=academic"/);
  assert.doesNotMatch(html, /空主题|不能显示为卡片的定义/);
  for (const id of ["latest-one", "latest-two"]) assert.ok(html.includes(`href="/items/${id}"`));
  assert.match(html, /近 30 天 5 条/);
  assert.match(html, /查看 24 条领域精选 →/);
  for (const group of ["field", "genre", "company"]) {
    assert.ok(html.includes(`href="#topics-${group}"`));
    assert.ok(html.includes(`id="topics-${group}"`));
  }
  let depth = 0;
  for (const anchor of html.match(/<\/?a\b[^>]*>/g) ?? []) {
    if (anchor.startsWith("</")) depth--;
    else { assert.equal(depth, 0, "links must not contain other links"); depth++; }
  }
  assert.equal(depth, 0);
});

test("topic directory loader forwards validated tracks and metadata uses the new group order", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ topics: [] }), { headers: { "content-type": "application/json" } });
  });
  assert.equal((await topics.loader({ request: new Request("https://example.com/topics?track=industry") })).track, "industry");
  assert.ok(calls[0].endsWith("/api/site/topics?track=industry"));
  assert.equal((await topics.loader({ request: new Request("https://example.com/topics?track=invalid") })).track, null);
  assert.ok(calls[1].endsWith("/api/site/topics"));
  assert.match(JSON.stringify(topics.meta()), /领域与议题、内容形态、机构与学会/);
});

test("subtag links preserve filters, reset paging and show the full-topic count", () => {
  const html = render(topic.default, { data, track: "academic", tag: "焦虑" }, "/topics/mood-trauma/page/2?track=academic&region=domestic&role=counselor&tag=焦虑");
  assert.match(html, /aria-label="子议题"/);
  assert.match(html, /全部<span[^>]*>24<\/span>/);
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));
  const depression = hrefs.find((href) => new URL(href, "https://example.com").searchParams.get("tag") === "抑郁")!;
  const url = new URL(depression, "https://example.com");
  assert.equal(url.pathname, "/topics/mood-trauma");
  assert.equal(url.searchParams.get("track"), "academic");
  assert.equal(url.searchParams.get("region"), "domestic");
  assert.equal(url.searchParams.get("role"), "counselor");
  assert.doesNotMatch(html, /领域内值得看/);
});

test("field topics show one combined list and mark only the current page's supplementary picks", () => {
  const html = render(topic.default, { data: { ...data, page: 1 }, track: null, tag: null }, "/topics/mood-trauma");
  assert.match(html, /<h2[^>]*>领域精选<\/h2>/);
  assert.match(html, /全站精选，加上本领域评分靠前的内容/);
  assert.match(html, /条领域精选/);
  assert.doesNotMatch(html, /topic-worth|领域内值得看|近 14 天未进精选|最新精选/);
  const supplement = html.match(/<article[^>]*data-item-id="pick-one"[^>]*>([\s\S]*?)<\/article>/)![1];
  const global = html.match(/<article[^>]*data-item-id="global-one"[^>]*>([\s\S]*?)<\/article>/)![1];
  const badge = supplement.match(/<span class="([^"]*)">领域精选<\/span>/)!;
  assert.ok(badge);
  assert.match(badge[1], /rounded border border-line/);
  assert.doesNotMatch(badge[1], /hidden/, "the pick mark is visible on mobile as well as desktop");
  assert.doesNotMatch(global, /领域精选/);
  assert.ok(html.indexOf('data-item-id="global-one"') < html.indexOf('data-item-id="pick-one"'));
});

test("topics without a pick floor retain the selected-list title and count wording", () => {
  const html = render(topic.default, { data: { ...data, topic: { ...data.topic, hasPicks: false }, items: [selected], fieldPickIds: [] }, track: null, tag: null }, "/topics/research");
  assert.match(html, /最新精选/);
  assert.doesNotMatch(html, /领域精选|全站精选，加上/);
  const directory = render(topics.default, { topics: [{ ...summary, hasPicks: false }], track: null }, "/topics");
  assert.match(directory, /查看 24 条精选 →/);
  assert.doesNotMatch(directory, /领域精选/);
});

test("DayList marks picks only when explicitly supplied and preserves other feeds", () => {
  const plain = render(() => createElement(dayList.DayList, { items: [selected, pick] }), null, "/all");
  assert.doesNotMatch(plain, /领域精选/);
  const marked = render(() => createElement(dayList.DayList, { items: [selected, pick], fieldPickIds: new Set([pick.id]) }), null, "/topics/mood-trauma");
  assert.equal((marked.match(/>领域精选<\/span>/g) ?? []).length, 1);
  assert.match(plain, /data-item-id="global-one"/);
  assert.match(marked, /data-item-id="global-one"/);
});

test("tag pages are noindex while canonical URLs remain free of queries", () => {
  const meta = topic.meta({ loaderData: { data, track: null, tag: "抑郁" } } as unknown as Parameters<typeof topic.meta>[0]);
  assert.ok(meta.some((m) => "name" in m && m.name === "robots" && "content" in m && String(m.content).includes("noindex")));
  const canonical = meta.find((m) => "rel" in m && m.rel === "canonical") as { href: string };
  assert.equal(new URL(canonical.href).pathname, "/topics/mood-trauma/page/2");
  assert.equal(new URL(canonical.href).search, "");
});

test("the route loader sends 308 for aliases and retains filters on live page/1 redirects", async () => {
  for (const [slug, page, expected] of [["depression", "5", "/topics/mood-trauma"], ["psychosis", undefined, "/topics/disorders-addiction"], ["mood-trauma", "1", "/topics/mood-trauma"]] as const) {
    await assert.rejects(topic.loader({ params: { slug, page }, request: new Request(`https://example.com/topics/${slug}?track=academic&region=domestic&role=counselor&tag=抑郁`) } as Parameters<typeof topic.loader>[0]), (error: unknown) => {
      assert.ok(error instanceof Response);
      assert.equal(error.status, 308);
      const target = new URL(error.headers.get("Location")!, "https://example.com");
      assert.equal(target.pathname, expected);
      assert.equal(target.searchParams.get("track"), "academic");
      assert.equal(target.searchParams.get("region"), "domestic");
      assert.equal(target.searchParams.get("role"), "counselor");
      assert.equal(target.searchParams.get("tag"), slug === "psychosis" ? null : "抑郁");
      return true;
    });
  }
});
