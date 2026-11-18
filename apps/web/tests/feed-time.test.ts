import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { createServer, type ViteDevServer } from "vite";
import type { FeedItemSummary, TimelineResponse } from "@aihot/contracts/site";
import { beijingTime } from "../app/lib/format.ts";

let vite: ViteDevServer;
let feed: typeof import("../app/features/feed/FeedItem.tsx");
let timeline: typeof import("../app/features/feed/Timeline.tsx");
let dayList: typeof import("../app/features/feed/DayList.tsx");
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), appType: "custom",
    server: { middlewareMode: true, ws: false }, ssr: { external: ["react", "react-dom", "react-router", "@aihot/contracts", "@aihot/industry"] }, optimizeDeps: { noDiscovery: true } });
  feed = await vite.ssrLoadModule("/app/features/feed/FeedItem.tsx") as typeof feed;
  timeline = await vite.ssrLoadModule("/app/features/feed/Timeline.tsx") as typeof timeline;
  dayList = await vite.ssrLoadModule("/app/features/feed/DayList.tsx") as typeof dayList;
});
after(async () => { await vite?.close(); });

const item: FeedItemSummary = {
  id: "time-one", title: "一项研究", summary: "导读。", reason: "推荐理由。", source: { name: "一份名称很长的研究期刊与心理学新闻来源" },
  publishedAt: "2026-11-16T02:03:00Z", timelineAt: "2026-11-17T22:12:00Z", category: "research", tags: [], score: 70, selected: true, channel: "news", x: null,
};
const anchorAt = "2026-11-18T14:50:00Z";
function render(content: ReactNode) {
  const router = createMemoryRouter([{ path: "*", Component: () => content }], { initialEntries: ["/"] });
  try { return renderToStaticMarkup(createElement(RouterProvider, { router })); }
  finally { router.dispose(); }
}
const headerOf = (html: string) => html.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)![1];
const timesOf = (html: string) => [...html.matchAll(/<time\b[^>]*>([^<]*)<\/time>/g)].map((match) => match[1]);

test("standalone cards do not infer header time from their item", () => {
  const html = render(createElement(feed.FeedItem, { item }));
  assert.doesNotMatch(headerOf(html), /<time\b/);
  assert.match(html, /aria-expanded="false"/, "the existing fold control remains available");
});

test("supplied time precedes the source on mobile and is hidden on desktop without shrinking time or score", () => {
  const header = headerOf(render(createElement(feed.FeedItem, { item, time: anchorAt })));
  const time = header.match(/<time\b[^>]*>([^<]*)<\/time>/)![0];
  assert.equal(timesOf(header)[0], beijingTime(anchorAt));
  assert.ok(time.includes(`dateTime="${anchorAt}"`));
  for (const cls of ["mono", "shrink-0", "whitespace-nowrap", "lg:hidden"]) assert.ok(time.includes(cls));
  assert.ok(header.indexOf(time) < header.indexOf(item.source.name));
  assert.match(header, />·<\/span>/);
  assert.match(header, /class="min-w-0 truncate text-ink-4"/, "the source can shrink and ellipsize");
  assert.match(header, /class="ml-auto flex shrink-0/, "the score keeps its width");
});

test("slots become one mobile column while the desktop rail and independent day header keep their layout", () => {
  const html = render(createElement("ol", {}, createElement(timeline.TimelineSlot, { at: anchorAt, children: "card" })));
  assert.match(html, /\bgrid-cols-1\b/);
  assert.match(html, /lg:grid-cols-\[64px_22px_minmax\(0,1fr\)\]/);
  assert.match(html, /<time\b[^>]*class="[^"]*hidden lg:block/);
  assert.deepEqual(timesOf(html), [beijingTime(anchorAt)]);
  const day = render(createElement(timeline.DayHeader, { day: "2026-11-18", today: "2026-11-18", count: 1, collapsed: false, onToggle: () => {} }));
  assert.match(day, /class="flex h-9 items-center gap-2 lg:hidden"/);
  assert.match(day, /class="hidden h-11 grid-cols-\[64px_22px_minmax\(0,1fr\)\] items-center lg:grid"/);
  assert.match(day, /aria-expanded="true"/);
});

test("home timeline header uses the slot anchor even when the item's own time differs", () => {
  const initial: TimelineResponse = { filters: { channel: "all", category: null, tag: null }, cards: [{ key: "time-card", anchorAt, item, group: null }],
    nextCursor: null, refreshAt: null, hot: null, dayCounts: {}, generatedAt: anchorAt };
  const html = render(createElement(timeline.Timeline, { initial, filters: initial.filters }));
  assert.deepEqual(timesOf(headerOf(html)), [beijingTime(anchorAt)]);
  assert.deepEqual(timesOf(html), [beijingTime(anchorAt), beijingTime(anchorAt)]);
  assert.notEqual(beijingTime(anchorAt), beijingTime(item.timelineAt));
});

test("DayList header uses the same timelineAt as its original time column", () => {
  const html = render(createElement(dayList.DayList, { items: [item] }));
  assert.deepEqual(timesOf(headerOf(html)), [beijingTime(item.timelineAt)]);
  assert.deepEqual(timesOf(html), [beijingTime(item.timelineAt), beijingTime(item.timelineAt)]);
  assert.notEqual(beijingTime(item.timelineAt), beijingTime(item.publishedAt!));
});
