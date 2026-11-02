// Article bodies: a page that closes </html> early (中国政府网's policy pages) used to crash Readability,
// and without a Jina key a page nothing could read left its article stuck on "JINA_API_KEY is not configured".
import "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { extractFromUrl, readable } from "@aihot/backend/content/extract";

const TEXT = "国家卫生健康委等部门印发实施方案，健全社会心理服务体系和危机干预机制，明确各部门职责。".repeat(10);
const PROSE = "A real report explains how password managers fill a sign-in form and why autofill is safer than typing. ".repeat(4);
const page = (title: string, text: string) => `<html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${text}</p></article></body></html>`;
const server = http.createServer((req, res) => {
  // A source URL the site sends to its sign-in form; a registry page that only gains a trailing slash.
  if (req.url === "/redirect") { res.writeHead(302, { location: "/login" }); return void res.end(); }
  if (req.url === "/brand/register") { res.writeHead(301, { location: "/brand/register/" }); return void res.end(); }
  // The form itself is long enough to be mistaken for a body by the length and density checks.
  const ok: Record<string, string> = {
    "/login": page("Sign in to Example", "Sign in to your account. Enter your email address and password to continue. ".repeat(6)),
    "/article": page("Password autofill in browsers", PROSE),
    "/brand/register/": page("The certified products register", PROSE),
  };
  if (req.url && ok[req.url]) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return void res.end(ok[req.url]); }
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

// A redirect to the site's sign-in form is an error page: the form's length and density pass the body
// checks, and a source that builds arxiv.org URLs once stored HuggingFace's login page as the article
// body (its navigation changed between fetches, so it became 26 revisions of a title "220").
test("a redirect to a sign-in form cannot become the body", async () => {
  const previousKey = process.env.JINA_API_KEY;
  delete process.env.JINA_API_KEY;
  try {
    // Without the redirect check this page is accepted: it is long enough and reads like an article.
    assert.ok(readable(await (await fetch(`${site}/login`)).text(), `${site}/login`), "the sign-in form passes the body checks: that is the trap");
    assert.equal(await extractFromUrl(`${site}/redirect`, { allowJina: true, subject: "test" }), null);
    // An article that merely mentions signing in and passwords is still an article.
    const got = await extractFromUrl(`${site}/article`, { allowJina: true, subject: "test" });
    assert.ok(got?.text.includes("password managers"), "text about sign-in forms is not a sign-in redirect");
    // A page that is itself on such a path and only gains a trailing slash was not sent to sign in.
    const registry = await extractFromUrl(`${site}/brand/register`, { allowJina: true, subject: "test" });
    assert.ok(registry?.text.includes("real report"), "a redirect between two addresses of the same page is no sign-in redirect");
  } finally {
    if (previousKey !== undefined) process.env.JINA_API_KEY = previousKey;
  }
});
