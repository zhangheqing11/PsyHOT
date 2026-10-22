import assert from "node:assert/strict";
import { test } from "node:test";
import { identityKeyForUrl, normalizeUrl, tweetIdFromUrl } from "../packages/backend/src/lib/url.ts";

test("X and Twitter status URL variants keep the same material identity", () => {
  for (const host of ["x.com", "twitter.com", "www.x.com", "www.twitter.com", "mobile.twitter.com", "m.twitter.com"]) {
    for (const path of ["/openai/status/1234567890", "/openai/statuses/1234567890", "/i/status/1234567890"]) {
      const url = `https://${host}${path}?s=20#thread`;
      assert.equal(tweetIdFromUrl(url), "1234567890", url);
      assert.equal(identityKeyForUrl(url), "x:1234567890", url);
    }
  }
  assert.equal(tweetIdFromUrl("http://TWITTER.COM/openai/status/1234567890/photo/1"), "1234567890");
});

test("other sites containing a tweet URL keep their own material identity", () => {
  const tweet = "https://x.com/openai/status/1234567890";
  const urls = [
    `https://news.example.org/article/42?related=${tweet}`,
    `https://news.example.org/article/42#${tweet}`,
    `https://news.example.org/archive/${tweet}`,
    "https://notx.com/openai/status/1234567890",
    "https://nottwitter.com/openai/status/1234567890",
    "https://x.com.example.org/openai/status/1234567890",
    "https://x.com@news.example.org/openai/status/1234567890",
  ];
  for (const url of urls) {
    assert.equal(tweetIdFromUrl(url), null, url);
    assert.equal(identityKeyForUrl(url), `url:${normalizeUrl(url)}`, url);
    assert.notEqual(identityKeyForUrl(url), identityKeyForUrl(tweet), url);
  }
});

test("only a complete status id at the expected path identifies a tweet", () => {
  for (const url of [
    "https://x.com/search?q=https://x.com/openai/status/1234567890",
    "https://x.com/archive/openai/status/1234567890",
    "https://x.com/openai/status/1234567890junk",
    "https://x.com/openai/status/",
    "https://x.com/openai/status/not-a-number",
  ]) assert.equal(tweetIdFromUrl(url), null, url);
});

test("invalid and non-HTTP URLs cannot acquire a tweet identity", () => {
  for (const url of ["not a URL", "x.com/openai/status/1234567890", "ftp://x.com/openai/status/1234567890"]) {
    assert.equal(tweetIdFromUrl(url), null, url);
    assert.equal(identityKeyForUrl(url), null, url);
  }
});

test("Xiaohongshu signed links and mobile paths identify a note, never its search token", () => {
  const id = "6ad553df000000001901e400";
  const expected = `xhs:${id}`;
  for (const url of [
    `https://www.xiaohongshu.com/explore/${id}?xsec_token=first%3D&xsec_source=pc_search`,
    `https://xiaohongshu.com/explore/${id}?xsec_token=second#comments`,
    `http://m.xiaohongshu.com/discovery/item/${id}/?share_id=another`,
    `https://www.xiaohongshu.com/explore/${id.toUpperCase()}`,
  ]) {
    assert.equal(identityKeyForUrl(url), expected);
    assert.equal(identityKeyForUrl(url, { keepFragment: true }), expected);
  }
  assert.notEqual(identityKeyForUrl("https://www.xiaohongshu.com/explore/6ad63c89000000002902e957"), expected);
});

test("only a complete note path on a Xiaohongshu host gets a note identity", () => {
  for (const url of [
    "https://xiaohongshu.com.example.org/explore/6ad553df000000001901e400",
    "https://xiaohongshu.com@news.example.org/explore/6ad553df000000001901e400",
    "https://news.example.org/?link=https://xiaohongshu.com/explore/6ad553df000000001901e400",
    "https://www.xiaohongshu.com/explore/6ad553df000000001901e400junk",
    "https://www.xiaohongshu.com/explore/6ad553df000000001901e400/extra",
    "https://www.xiaohongshu.com/user/profile/6ad553df000000001901e400",
    "https://www.xiaohongshu.com/explore/not-a-note-id",
  ]) assert.equal(identityKeyForUrl(url), `url:${normalizeUrl(url)}`, url);
});

test("publisher date-slug aliases share identity while independent reports stay separate", () => {
  const path = "https://www.bacp.co.uk/news/news-from-bacp/2026/9-";
  assert.equal(identityKeyForUrl(`${path}oct-mental-health-support-should-not-depend-on-diagnosis/`),
    identityKeyForUrl(`${path}october-mental-health-support-should-not-depend-on-diagnosis/`));
  assert.notEqual(identityKeyForUrl(`${path}oct-one-report`), identityKeyForUrl(`${path}oct-another-report`));
  assert.notEqual(identityKeyForUrl("https://example.com/news/news-from-bacp/2026/9-oct-article"),
    identityKeyForUrl("https://example.com/news/news-from-bacp/2026/9-october-article"));
  assert.equal(identityKeyForUrl("https://example.com/article/?utm_source=rss&a=1"),
    identityKeyForUrl("https://example.com/article?a=1"));
});
