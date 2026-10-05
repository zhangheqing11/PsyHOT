// Article bodies: a page that closes </html> early (中国政府网's policy pages) used to crash Readability,
// and without a Jina key a page nothing could read left its article stuck on "JINA_API_KEY is not configured".
import "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { extractFromUrl, readable } from "@aihot/backend/content/extract";

const TEXT = "国家卫生健康委等部门印发实施方案，健全社会心理服务体系和危机干预机制，明确各部门职责。".repeat(10);
const server = http.createServer((_req, res) => {
  res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
  res.end("<html><body><p>Just a moment...</p></body></html>");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const site = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const previousPrivateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivateFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("text after an early </html> is read as the body", () => {
  const html = `<!doctype html><html><head><title>t</title></head><body><div class="header">站点导航</div></body></html>` +
    `<div class="main"><div id="UCAP-CONTENT"><p>${TEXT}</p><p>${TEXT}</p></div></div></body></html>`;
  const got = readable(html, "https://www.gov.cn/zhengce/zhengceku/202604/content_7065035.htm");
  assert.ok(got?.text.includes("健全社会心理服务体系"));
});

test("without a Jina key an unreadable page gives no body instead of an error", async () => {
  const previousKey = process.env.JINA_API_KEY;
  delete process.env.JINA_API_KEY;
  try {
    assert.equal(await extractFromUrl(`${site}/blocked`, { allowJina: true, subject: "test" }), null);
  } finally {
    if (previousKey !== undefined) process.env.JINA_API_KEY = previousKey;
  }
});
