import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
let nav: typeof import("../app/components/shell/nav.ts");
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), appType: "custom",
    server: { middlewareMode: true, ws: false }, ssr: { external: ["react", "@aihot/industry"] }, optimizeDeps: { noDiscovery: true } });
  nav = await vite.ssrLoadModule("/app/components/shell/nav.ts") as typeof nav;
});
after(async () => { await vite?.close(); });

const activeTabs = (path: string) => nav.TABBAR.filter((item) => nav.tabIsActive(item, path)).map((item) => item.to);

test("mobile navigation has five tabs in reading order", () => {
  assert.deepEqual(nav.TABBAR.map((item) => item.to), ["/", "/all", "/topics", "/daily", "/more"]);
});

test("topic directory and topic details highlight only the topics tab", () => {
  for (const path of ["/topics", "/topics/cognition-neuro"]) assert.deepEqual(activeTabs(path), ["/topics"]);
});

test("hot and starred pages keep more active, including nested paths", () => {
  for (const path of ["/hot", "/starred", "/hot/story", "/privacy"]) assert.deepEqual(activeTabs(path), ["/more"]);
  assert.deepEqual(activeTabs("/topics-other"), []);
});

test("home is exact and reports retain the daily tab", () => {
  assert.deepEqual(activeTabs("/"), ["/"]);
  assert.deepEqual(activeTabs("/all"), ["/all"]);
  for (const path of ["/daily", "/daily/2026-11-18", "/weekly/2026-11-16", "/monthly/2026-11"]) {
    assert.deepEqual(activeTabs(path), ["/daily"]);
  }
});
