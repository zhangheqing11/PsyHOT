// Bluesky accounts as json_list sources (adapter "bluesky_feed"): each post at its bsky.app address,
// with the links it carries in its body (link card, links in the text, a quoted post's card); a repost
// dated when it was reposted; image-only posts skipped; the adapter allowed for json_list only.
import { stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { blueskyCandidate, postUrl, type FeedItem } from "@aihot/backend/sources/bluesky";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";
import { fetchJsonList } from "@aihot/backend/sources/json-list";

const author = { did: "did:plc:abc", handle: "lakens.bsky.social" };
const LINK = "app.bsky.richtext.facet#link";
const FEED: FeedItem[] = [
  {
    post: {
      uri: "at://did:plc:abc/app.bsky.feed.post/3mcard", author,
      record: { text: "New preprint on equivalence tests\nThread below", createdAt: "2026-10-05T10:00:00.000Z", langs: ["en"], facets: [{ features: [{ $type: LINK, uri: "https://osf.io/abcd" }] }] },
      embed: { $type: "app.bsky.embed.external#view", external: { uri: "https://doi.org/10.1177/25152459261234567", title: "Equivalence testing", description: "We show" } },
      likeCount: 12, repostCount: 3,
    },
  },
  {
    post: {
      uri: "at://did:plc:xyz/app.bsky.feed.post/3mquoted", author: { did: "did:plc:xyz", handle: "someone.bsky.social" },
      record: { text: "Great paper", createdAt: "2026-09-01T10:00:00.000Z" },
      embed: { $type: "app.bsky.embed.recordWithMedia#view", media: { $type: "app.bsky.embed.images#view" },
        record: { record: { $type: "app.bsky.embed.record#viewRecord", uri: "at://did:plc:j/app.bsky.feed.post/1", author: { handle: "natrevpsychol.nature.com" }, value: { text: "Out now: a review" },
          embeds: [{ $type: "app.bsky.embed.external#view", external: { uri: "https://www.nature.com/articles/s44159-026-00001-2", title: "A review" } }] } } },
    },
    reason: { $type: "app.bsky.feed.defs#reasonRepost", by: { handle: "lakens.bsky.social" }, indexedAt: "2026-10-05T12:00:00.000Z" },
  },
  { post: { uri: "at://did:plc:abc/app.bsky.feed.post/3mimage", author, record: { text: "", createdAt: "2026-10-05T10:00:00.000Z" }, embed: { $type: "app.bsky.embed.images#view" } } },
];

const api = await stub(() => ({ feed: FEED, cursor: "x" }));
config.allowPrivateNetworkFetch = true;
after(async () => {
  await api.close();
  await closeDb();
});

test("posts: the bsky.app address, the first line as title, the links in the body", () => {
  assert.equal(postUrl(FEED[0]!.post), "https://bsky.app/profile/lakens.bsky.social/post/3mcard");
  const c = blueskyCandidate(FEED[0]!)!;
  assert.equal(c.title, "New preprint on equivalence tests");
  assert.ok(c.bodyText!.includes("https://doi.org/10.1177/25152459261234567") && c.bodyText!.includes("https://osf.io/abcd"));
  assert.deepEqual((c.raw as { links: string[] }).links, ["https://doi.org/10.1177/25152459261234567", "https://osf.io/abcd"]);
  assert.equal(c.publishedAt?.toISOString(), "2026-10-05T10:00:00.000Z");
  assert.equal(c.bodyStatus, "ok", "no page to fetch");
});

test("a repost is dated when it was reposted and carries the quoted post's link", () => {
  const c = blueskyCandidate(FEED[1]!)!;
  assert.equal(c.url, "https://bsky.app/profile/someone.bsky.social/post/3mquoted");
  assert.equal(c.publishedAt?.toISOString(), "2026-10-05T12:00:00.000Z");
  assert.ok(c.bodyText!.includes("【引用 @natrevpsychol.nature.com】Out now: a review"));
  assert.ok(c.bodyText!.includes("https://www.nature.com/articles/s44159-026-00001-2"));
  assert.equal((c.raw as { repostedBy?: string }).repostedBy, "lakens.bsky.social");
  assert.equal(blueskyCandidate(FEED[2]!), null, "an image alone has nothing to match");
});

test("the source reads the public feed; the adapter belongs to json_list", async () => {
  const source = { id: "bsky-test", name: "Test", kind: "json_list", config: { url: `${api.url}/xrpc/app.bsky.feed.getAuthorFeed?actor=did:plc:abc`, adapter: "bluesky_feed" }, tier: "T2",
    participation_mode: "hot_signal", first_party: false, interval_minutes: 60, enabled: true, cursor: null, fail_count: 0 } as const;
  const found = await fetchJsonList(source as never);
  assert.deepEqual(found.map((c) => c.url), ["https://bsky.app/profile/lakens.bsky.social/post/3mcard", "https://bsky.app/profile/someone.bsky.social/post/3mquoted"]);
  assert.deepEqual(unsupportedConfig("json_list", { adapter: "bluesky_feed", url: "x" }), []);
  assert.deepEqual(unsupportedConfig("json_list", { adapter: "mimo_home" }), ["adapter=mimo_home"]);
  assert.deepEqual(unsupportedConfig("web_list", { adapter: "bluesky_feed" }), ["adapter=bluesky_feed"]);
});
