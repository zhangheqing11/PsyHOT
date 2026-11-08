// Render the actual TSX components through Vite, using only in-memory item data.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { createServer, type ViteDevServer } from "vite";
import type { FeedItemSummary, SiteItemDetail } from "@aihot/contracts/site";

const root = fileURLToPath(new URL("..", import.meta.url));
let vite: ViteDevServer;
let switches: { industryRoleScoring: boolean };
let FeedItem: any;
let ItemPage: any;
const item: FeedItemSummary = {
  id: "role-test", title: "新的执业规则", summary: "正式文件改变了具体执业流程。", reason: null,
  source: { name: "测试来源" }, publishedAt: "2026-11-08T00:00:00Z", timelineAt: "2026-11-08T00:00:00Z",
  category: "policy", tags: [], roles: ["counselor"], impact: "rule", selectedRoles: [], hotPick: true,
  score: 40, selected: true, channel: "news", x: null,
};
before(async () => {
  vite = await createServer({ configFile: false, root, appType: "custom", server: { middlewareMode: true },
    ssr: { external: ["react", "react-dom", "react-router", "@aihot/contracts", "@aihot/industry"] }, optimizeDeps: { noDiscovery: true } });
  const { FEATURES } = await vite.ssrLoadModule("@aihot/industry/features");
  switches = FEATURES as unknown as { industryRoleScoring: boolean };
  FeedItem = (await vite.ssrLoadModule("/app/features/feed/FeedItem.tsx")).FeedItem;
  ItemPage = (await vite.ssrLoadModule("/app/routes/item.tsx")).default;
});
after(async () => { switches.industryRoleScoring = false; await vite?.close(); });
const card = (data = item, showTags = true) => renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(FeedItem, { item: data, showTags })));
function detail(data = item) {
  const full: SiteItemDetail = { ...data, revision: 1, originalTitle: null, discoveredAt: data.timelineAt, source: { ...data.source, id: "test", kind: "rss", firstParty: true, iconUrl: null },
    links: { aihot: `/items/${data.id}`, original: "https://example.com/source" }, story: null, x: null, author: null, language: "zh",
    readingMode: "summary-only", abstract: null, body: null, outline: [], relatedStories: [], indexable: false, markdownAvailable: false, group: null,
    hasTranslation: false, bodyLanguage: "original" };
  const router = createMemoryRouter([{ id: "item", path: "/", Component: ItemPage }], { initialEntries: ["/"], hydrationData: { loaderData: { item: { item: full } } } });
  try { return renderToStaticMarkup(createElement(RouterProvider, { router })); }
  finally { router.dispose(); }
}

test("enabled industry card and detail hide AI scores; the hot mark is shown", () => {
  switches.industryRoleScoring = true;
  assert.doesNotMatch(card(), /AI 评分/);
  assert.match(card(), /热点/);
  assert.match(card(), /规则/);
  assert.match(card(item, false), /热点/, "selected cards also show the mark without tags");
  assert.doesNotMatch(detail(), /AI 评分/);
  const academic = { ...item, category: "research" as const, hotPick: false };
  assert.match(card(academic), /AI 评分/);
  assert.match(detail(academic), /AI 评分/);
});

test("the hot mark sits beside promotion in the header while impact and tags keep their desktop-only row", () => {
  switches.industryRoleScoring = true;
  const data = { ...item, promotion: true as const, tags: ["执业"] };
  const marked = card(data);
  const header = marked.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)![1];
  const badgeClass = "shrink-0 rounded border border-line px-1 text-[11px] leading-[16px] text-ink-4";
  assert.ok(header.includes(`<span class="${badgeClass}">推广</span><span class="${badgeClass}">热点</span>`));
  const tagRow = marked.match(/<div class="relative z-10 mt-2 hidden flex-wrap gap-x-2\.5 gap-y-1 text-\[12px\] text-ink-4 lg:flex">([\s\S]*?)<\/div>/)![1];
  assert.match(tagRow, /规则/);
  assert.match(tagRow, /#执业/);
  assert.doesNotMatch(tagRow, /热点/);
  const withoutTags = card(data, false);
  assert.match(withoutTags.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)![1], /热点/);
  assert.doesNotMatch(withoutTags, />规则<|#执业|relative z-10 mt-2/);
});

test("disabled renders the same card and detail regardless of the new fields", () => {
  switches.industryRoleScoring = false;
  const { hotPick, selectedRoles, ...old } = item;
  assert.equal(card(), card(old));
  assert.equal(detail(), detail(old));
  assert.match(card(), /AI 评分/);
  assert.match(detail(), /AI 评分/);
  assert.doesNotMatch(card(), /热点/);
});
