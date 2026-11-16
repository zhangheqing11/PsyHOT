import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
let topicAliasRedirect: typeof import("../app/lib/topic-alias.ts").topicAliasRedirect;
before(async () => {
  // Use the web app's existing JSON transform without changing its ES2022 compiler target.
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), appType: "custom",
    server: { middlewareMode: true, ws: false }, ssr: { noExternal: ["@aihot/industry"] }, optimizeDeps: { noDiscovery: true } });
  ({ topicAliasRedirect } = await vite.ssrLoadModule("/app/lib/topic-alias.ts"));
});
after(async () => { await vite?.close(); });

test("legacy topic redirects include the encoded subtag", () => {
  assert.equal(topicAliasRedirect("depression", 1, new URLSearchParams()), `/topics/mood-trauma?tag=${encodeURIComponent("抑郁")}`);
  assert.equal(topicAliasRedirect("neuro", 1, new URLSearchParams()), `/topics/cognition-neuro?tag=${encodeURIComponent("生理/神经")}`);
});

test("multi-tag legacy topics redirect without a subtag", () => {
  assert.equal(topicAliasRedirect("psychosis", 1, new URLSearchParams()), "/topics/disorders-addiction");
});

test("redirects preserve track, region and role while the alias owns the subtag", () => {
  const params = new URLSearchParams({ track: "academic", role: "counselor", region: "domestic", tag: "焦虑", q: "ignored" });
  const result = new URL(topicAliasRedirect("depression", 1, params)!, "https://example.com");
  assert.equal(result.pathname, "/topics/mood-trauma");
  assert.deepEqual(Object.fromEntries(result.searchParams), { tag: "抑郁", track: "academic", region: "domestic", role: "counselor" });
  assert.equal(params.get("tag"), "焦虑", "the helper does not mutate the request");
  const withoutTag = new URL(topicAliasRedirect("psychosis", 1, params)!, "https://example.com");
  assert.equal(withoutTag.searchParams.has("tag"), false);
  assert.equal(withoutTag.searchParams.get("role"), "counselor");
});

test("legacy page/N addresses always redirect to the new first page", () => {
  const result = topicAliasRedirect("methods", 4, new URLSearchParams({ track: "academic", page: "4" }));
  assert.ok(result);
  assert.ok(result.startsWith("/topics/methods-integrity?"));
  assert.ok(!result.includes("/page/"));
  const params = new URL(result, "https://example.com").searchParams;
  assert.equal(params.has("page"), false);
  assert.equal(params.get("tag"), "方法/统计");
  assert.equal(params.get("track"), "academic");
});

test("live and unknown slugs are not aliases", () => {
  for (const slug of ["psychotherapy", "mood-trauma", "does-not-exist", "__proto__", "toString"]) {
    assert.equal(topicAliasRedirect(slug, 1, new URLSearchParams()), null, slug);
  }
});
