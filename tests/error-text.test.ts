// Stored error text names what failed underneath: undici wraps every connection failure in
// `fetch failed` and keeps the reason (ECONNRESET, ENOTFOUND, a certificate error) in error.cause.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { describeError, redactSecrets } from "@aihot/backend/lib/error-text";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";

const T = tag();
const cause = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});
const wrapped = (inner: unknown) => new TypeError("fetch failed", { cause: inner });

// A server that closes every connection without answering, and a port nothing listens on.
const closing = http.createServer((req) => req.socket.destroy());
await new Promise<void>((resolve) => closing.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(closing.address() as { port: number }).port}`;
const idle = net.createServer();
await new Promise<void>((resolve) => idle.listen(0, "127.0.0.1", resolve));
const deadPort = (idle.address() as { port: number }).port;
await new Promise<void>((resolve) => idle.close(() => resolve()));
config.allowPrivateNetworkFetch = true;
after(async () => {
  await new Promise<void>((resolve) => closing.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

test("the code and message of the cause follow the message", () => {
  assert.equal(describeError(wrapped(cause("socket hang up", "ECONNRESET"))), "fetch failed (ECONNRESET: socket hang up)");
  assert.equal(describeError(wrapped(cause("connect timeout", "UND_ERR_CONNECT_TIMEOUT"))), "fetch failed (UND_ERR_CONNECT_TIMEOUT: connect timeout)");
  assert.equal(describeError(wrapped(cause("unable to verify the first certificate", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"))),
    "fetch failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE: unable to verify the first certificate)");
  // A message that already names its code is not repeated; a cause with only a code gives the code.
  assert.equal(describeError(wrapped(cause("getaddrinfo ENOTFOUND journal.psych.ac.cn", "ENOTFOUND"))), "fetch failed (getaddrinfo ENOTFOUND journal.psych.ac.cn)");
  assert.equal(describeError(wrapped(cause("", "EPIPE"))), "fetch failed (EPIPE)");
});

test("a chain of causes and an AggregateError's failures are all named, each once", () => {
  const chain = wrapped(cause("tunnel failed", "ERR_PROXY_TUNNEL"));
  (chain.cause as Error).cause = cause("socket hang up", "ECONNRESET");
  assert.equal(describeError(chain), "fetch failed (ERR_PROXY_TUNNEL: tunnel failed; ECONNRESET: socket hang up)");
  const both = Object.assign(new AggregateError([cause("connect ETIMEDOUT 1.2.3.4:443", "ETIMEDOUT"), cause("connect ENETUNREACH ::1:443", "ENETUNREACH"), cause("connect ETIMEDOUT 1.2.3.4:443", "ETIMEDOUT")], ""), { code: "ETIMEDOUT" });
  assert.equal(describeError(wrapped(both)), "fetch failed (ETIMEDOUT; connect ETIMEDOUT 1.2.3.4:443; connect ENETUNREACH ::1:443)");
  // A cause that points back at the error cannot loop.
  const loop = wrapped(cause("again", "EAGAIN"));
  (loop.cause as Error).cause = loop;
  assert.equal(describeError(loop), "fetch failed (EAGAIN: again)");
});

test("errors without a cause keep their own text", () => {
  assert.equal(describeError(new Error("HTTP 403")), "HTTP 403");
  assert.equal(describeError("plain text"), "plain text");
  assert.equal(describeError(undefined), "undefined");
  assert.equal(describeError(Object.assign(new Error("Too many redirects"), { code: "ERR_TOO_MANY_REDIRECTS" })), "Too many redirects (ERR_TOO_MANY_REDIRECTS)");
});

test("the text is cut to the limit, and a credential is never stored", () => {
  assert.equal(describeError(wrapped(cause("x".repeat(2000), "ECONNRESET")), 100).length, 100);
  assert.equal(describeError(new Error("x".repeat(2000))).length, 500);
  const refused = wrapped(cause("connect failed for https://user:pw@host.example/feed?token=abc123&page=2 with Bearer sk-live0123456789abcdefghij", "ECONNREFUSED"));
  const text = describeError(refused);
  assert.ok(!/abc123|user:pw|sk-live0123|Bearer sk/.test(text), text);
  assert.match(text, /^fetch failed \(ECONNREFUSED: connect failed for https:\/\/host\.example\/feed\?token=\[redacted\]&page=2 with Bearer \[redacted\]\)$/);
  // Redacted before it is cut, so a secret cut in half cannot survive.
  assert.ok(!describeError(new Error(`${"a".repeat(90)} api_key=abcdefghijklmnop`), 100).includes("abcdef"));
});

test("only credentials are redacted", () => {
  assert.equal(redactSecrets("https://example.org/a?page=2&key=K1&sign=S2#x"), "https://example.org/a?page=2&key=[redacted]&sign=[redacted]#x");
  assert.equal(redactSecrets('{"error":{"api_key":"abc-123","code":"quota_exhausted"}}'), '{"error":{"api_key":"[redacted]","code":"quota_exhausted"}}');
  assert.equal(redactSecrets("Authorization: Basic dXNlcjpwYXNz"), "Authorization: Basic [redacted]");
  for (const plain of ["getaddrinfo ENOTFOUND journal.psych.ac.cn", "HTTP 402 insufficient quota", "monkey=banana keyboard", "https://example.org/?q=tokens"]) {
    assert.equal(redactSecrets(plain), plain);
  }
});

test("real connection failures keep their reason", async () => {
  const { guardedFetch } = await import("@aihot/backend/lib/http-fetch");
  const closed = await guardedFetch(`${base}/`).then(() => null, (error: unknown) => describeError(error));
  assert.match(closed ?? "", /^fetch failed \((UND_ERR_SOCKET|ECONNRESET)\b.+\)$/);
  const refused = await guardedFetch(`http://127.0.0.1:${deadPort}/`).then(() => null, (error: unknown) => describeError(error));
  assert.match(refused ?? "", /^fetch failed \(.*ECONNREFUSED.*\)$/);
});

test("a source's stored error and its fetch run carry the reason, not only 'fetch failed'", async () => {
  const id = `error-text-${T}`;
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,next_fetch_at)
    VALUES (${id},'Error text test','rss',${sql.json({ feedUrl: `${base}/feed.xml?token=secret-${T}` })},'T1','editorial','2100-01-01')`;
  const result = await collectSource(id);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /^fetch failed \((UND_ERR_SOCKET|ECONNRESET)\b/);
  const [source] = await sql<{ last_error: string }[]>`SELECT last_error FROM sources WHERE id=${id}`;
  const [run] = await sql<{ error: string }[]>`SELECT error FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`;
  assert.equal(source!.last_error, result.error);
  assert.equal(run!.error, result.error);
  assert.ok(!(source!.last_error + run!.error).includes(`secret-${T}`));
});
