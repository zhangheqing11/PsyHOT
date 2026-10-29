import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { config } from "@aihot/backend/config";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import { fetchWebList, fromHanwebRecords } from "@aihot/backend/sources/web-list";
import { parseRss } from "@aihot/backend/sources/rss";
import { FetchError, type SourceRow } from "@aihot/backend/sources/types";

test("Hanweb records use normal selectors, relative links and dates; empty fetches report failure in every mode", async () => {
  const html = `<a href="/menu">Navigation outside records</a>
    <script type="text/xml"><datastore>
      <record><![CDATA[<li><a href="/art/one.html">心理服务价格</a><span>2026-10-28</span></li>]]></record>
      <record><![CDATA[<li><a href="two.html">精神卫生指南</a><span>2026年10月27日</span></li>]]></record>
      <record><![CDATA[<li><a href="/other/skip.html">Other section</a><span>2026-10-26</span></li>]]></record>
    </datastore></script>`;
  const empty = '<script type="text/xml"><datastore /></script><li><a href="/other/menu.html">Menu</a></li>';
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(req.url === "/empty" ? empty : html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const source: SourceRow = {
      id: "test-hanweb", name: "Hanweb test", kind: "web_list", tier: "T1", tags: [],
      participation_mode: "editorial", first_party: true, interval_minutes: 360,
      enabled: true, cursor: null, fail_count: 0,
      config: {
        url: `${origin}/listing`, baseUrl: "https://example.org/art/", parseMode: "hanweb_records",
        itemSelector: "li", linkSelector: "a", publishedAtSelector: "span", publishedAtUtcOffset: "+08:00",
        allowUrlPrefixes: ["https://example.org/art/"],
      },
    };
    assertSupportedConfig("web_list", source.config);
    const items = await fetchWebList(source);
    assert.deepEqual(items.map((item) => [item.title, item.url, item.publishedAt?.toISOString()]), [
      ["心理服务价格", "https://example.org/art/one.html", "2026-10-28T00:00:00.000Z"],
      ["精神卫生指南", "https://example.org/art/two.html", "2026-10-26T16:00:00.000Z"],
    ]);
    source.config.url = `${origin}/empty`;
    assert.deepEqual(fromHanwebRecords(empty, source.config.baseUrl, source), []);
    for (const mode of ["html", "markdown", "docusaurus_changelog", "hanweb_records"]) {
      source.config.parseMode = mode;
      await assert.rejects(fetchWebList(source), (error: unknown) =>
        error instanceof FetchError && error.message === `no items matched (${mode})`,
      );
    }
  } finally {
    config.allowPrivateNetworkFetch = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("RSS nested-element titles ignore attributes and retain text, CDATA and plain-title behavior", () => {
  const titles = [
    '<a href="/wrong-url" hreflang="en"><span>Mental health &amp; care</span></a>',
    '<![CDATA[<a href="/other">Mental health &amp; care</a>]]>',
    "Mental health &amp; care",
    '<a href="/wrong-url" title="not the headline">Mental health &amp; care</a>',
  ];
  const xml = `<rss version="2.0"><channel>${titles.map((title, i) =>
    `<item><title>${title}</title><link>https://example.org/article/${i}</link><pubDate>Wed, 28 Oct 2026 12:00:00 GMT</pubDate></item>`,
  ).join("")}</channel></rss>`;
  const items = parseRss(xml, { config: {} } as SourceRow, "https://example.org/feed");
  assert.equal(items.length, 4);
  for (const [i, item] of items.entries()) {
    assert.equal(item.title, "Mental health & care");
    assert.equal(item.url, `https://example.org/article/${i}`);
    assert.equal(item.publishedAt?.toISOString(), "2026-10-28T12:00:00.000Z");
  }
});

test("RSS publication dates accept an attached am/pm marker without changing ordinary dates", () => {
  const xml = `<rss><channel><item><title>Mental health news</title><link>https://example.org/news</link>
    <pubDate>Oct 28, 2026 5:37pm</pubDate></item></channel></rss>`;
  const [item] = parseRss(xml, { config: {} } as SourceRow, "https://example.org/feed");
  assert.equal(item?.publishedAt?.getTime(), new Date(2026, 9, 28, 17, 37).getTime());
});
