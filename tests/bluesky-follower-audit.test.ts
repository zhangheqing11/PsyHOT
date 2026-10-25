import assert from "node:assert/strict";
import { test } from "node:test";
import { actorDid, auditCsv, followerCounts, recommendation } from "../scripts/bluesky-follower-audit.ts";

test("Bluesky pruning retains every T1 account, 5000 followers, or any heat in the last 30 days", () => {
  assert.equal(recommendation("T1", 0, 0), "保留");
  assert.equal(recommendation("T2", 5000, 0), "保留");
  assert.equal(recommendation("T2", 4999, 1), "保留");
  assert.equal(recommendation("T2", 4999, 0), "停用");
});

test("profile requests batch at 25, deduplicate DIDs and match counts by DID rather than response order", async () => {
  const actors = Array.from({ length: 51 }, (_, i) => `did:plc:${i}`);
  const sizes: number[] = [];
  const counts = await followerCounts([...actors, actors[0]!], (async (input: URL) => {
    assert.equal(input.origin, "https://public.api.bsky.app");
    const batch = input.searchParams.getAll("actors");
    sizes.push(batch.length);
    return Response.json({ profiles: batch.toReversed().map((did) => ({ did, followersCount: Number(did.split(":").at(-1)) })) });
  }) as typeof fetch);
  assert.deepEqual(sizes, [25, 25, 1]);
  assert.equal(counts.size, 51);
  assert.equal(counts.get("did:plc:50"), 50);
});

test("missing or failed public profiles abort rather than advising to disable an unknown account", async () => {
  await assert.rejects(followerCounts(["did:plc:missing"], (async () => Response.json({ profiles: [] })) as typeof fetch), /unavailable/);
  await assert.rejects(followerCounts(["did:plc:missing"], (async () => new Response(null, { status: 429 })) as typeof fetch), /HTTP 429/);
  await assert.rejects(followerCounts(["did:plc:missing"], (async () => Response.json({ profiles: [{ did: "did:plc:missing", followersCount: -1 }] })) as typeof fetch), /unavailable/);
});

test("audit CSV includes the requested columns, quotes names, and refuses a missing DID or count", () => {
  const source = { id: "bsky-test", name: '研究者, "甲"', tier: "T2", config: { url: "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=did%3Aplc%3Atest" }, signals_30d: 0 };
  assert.equal(actorDid(source), "did:plc:test");
  const csv = auditCsv([source], new Map([["did:plc:test", 4999]]));
  assert.ok(csv.startsWith('\uFEFF"id","名称","tier","粉丝数","30天热度记录数","建议"\r\n'));
  assert.ok(csv.includes('"研究者, ""甲""","T2","4999","0","停用"'));
  assert.ok(auditCsv([{ ...source, name: "=FORMULA()" }], new Map([["did:plc:test", 5000]])).includes("'=FORMULA()"));
  assert.throws(() => actorDid({ ...source, config: { url: "https://example.org/?actor=someone" } }), /DID/);
  assert.throws(() => auditCsv([source], new Map()), /Missing followers/);
});
