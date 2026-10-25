// A source may identify itself transparently for a strict official feed without pretending to be a
// browser. The request stays local to this fixture and never calls a real source.
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchRss } from "@aihot/backend/sources/rss";

let seen: string | undefined;
const server = http.createServer((req, res) => {
  seen = req.headers["user-agent"];
  res.writeHead(200, { "content-type": "application/rss+xml" });
  res.end("<rss version=\"2.0\"><channel><title>Test</title></channel></rss>");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const previousPrivate = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivate;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("RSS sends a source-local transparent user agent", async () => {
  await fetchRss({ config: { feedUrl: `${base}/feed.xml`, userAgent: "PsyHOTBot/1.0" }, cursor: null } as never, { force: true });
  assert.equal(seen, "PsyHOTBot/1.0");
});
