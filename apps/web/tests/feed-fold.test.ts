import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { createServer, type ViteDevServer } from "vite";
import type { FeedItemSummary } from "@aihot/contracts/site";

let vite: ViteDevServer;
let FeedItem: ComponentType<{ item: FeedItemSummary }>;
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), appType: "custom",
    server: { middlewareMode: true, ws: false }, ssr: { external: ["react", "react-dom", "react-router", "@aihot/contracts", "@aihot/industry"] }, optimizeDeps: { noDiscovery: true } });
  FeedItem = (await vite.ssrLoadModule("/app/features/feed/FeedItem.tsx")).FeedItem;
});
after(async () => { await vite?.close(); });

const item: FeedItemSummary = {
  id: "fold-one", title: "一项新的研究", summary: "完整导读。", reason: "完整推荐理由。", source: { name: "测试期刊" },
  publishedAt: null, timelineAt: "2026-11-18T00:00:00Z", category: "research", tags: [], score: 70, selected: true, channel: "news", x: null,
};
const card = (data = item) => renderToString(createElement(MemoryRouter, {}, createElement(FeedItem, { item: data })));

test("server cards start collapsed and the toggle controls the summary and reason outside the item link", () => {
  const html = card();
  const button = html.match(/<button\b[^>]*aria-expanded="false"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(button);
  assert.match(button, /导读 · 推荐理由/);
  const controlled = button.match(/aria-controls="([^"]+)"/)![1].split(" ");
  for (const id of controlled) assert.ok(html.includes(`id="${id}"`));
  assert.match(html, /完整导读。/);
  assert.match(html, /完整推荐理由。/);
  assert.match(html, /href="\/items\/fold-one"/);
  assert.ok(html.indexOf("</a>") < html.indexOf(button), "the toggle is not nested inside the item link");
});

test("toggle wording follows the available content and disappears for empty cards", () => {
  assert.match(card({ ...item, reason: null }), />导读</);
  assert.match(card({ ...item, summary: null }), />推荐理由</);
  assert.doesNotMatch(card({ ...item, summary: null, reason: null }), /aria-expanded|aria-controls/);
});

test("saved session state cannot change the server's initial collapsed markup", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  let reads = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { sessionStorage: {
    getItem: () => { reads++; return '["fold-one"]'; },
  } } });
  try {
    assert.match(card(), /aria-expanded="false"/);
    assert.equal(reads, 0, "storage is read only after mounting");
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("X posts retain visible post text and have no fold toggle", () => {
  const html = card({ ...item, channel: "x", x: { authorName: "作者", handle: "author", avatarUrl: null, media: [], quoted: null } });
  assert.doesNotMatch(html, /aria-expanded|aria-controls/);
  assert.match(html, /line-clamp-5 lg:line-clamp-4/);
  assert.match(html, /完整导读。/);
});
