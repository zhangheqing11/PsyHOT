// Redirects across origins: a paid API's key and request body never follow them.
import "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";

config.allowPrivateNetworkFetch = true; // both servers listen on 127.0.0.1, on different ports (origins)

const seen: Array<{ method: string; authorization: string | null; body: string }> = [];
const target = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    seen.push({ method: req.method ?? "", authorization: req.headers.authorization ?? null, body: Buffer.concat(chunks).toString() });
    res.end("ok");
  });
});
const origin = http.createServer((req, res) => {
  const status = Number(new URL(req.url ?? "/", "http://x").searchParams.get("status") ?? 302);
  res.writeHead(status, { location: `http://127.0.0.1:${(target.address() as { port: number }).port}/landing` }).end();
});
for (const s of [target, origin]) await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
const from = (status: number) => `http://127.0.0.1:${(origin.address() as { port: number }).port}/?status=${status}`;
after(() => { target.close(); origin.close(); });

test("another origin gets neither the credentials nor a POST body", async () => {
  await guardedFetch(from(302), { headers: { authorization: "Bearer SYNTHETIC", cookie: "a=b", accept: "text/plain" } });
  assert.deepEqual(seen.at(-1), { method: "GET", authorization: null, body: "" });
  await guardedFetch(from(302), { method: "POST", headers: { authorization: "Bearer SYNTHETIC" }, body: "{\"secret\":1}" });
  assert.deepEqual(seen.at(-1), { method: "GET", authorization: null, body: "" }, "a POST continues as a GET without its body");
  const before = seen.length;
  await assert.rejects(guardedFetch(from(307), { method: "POST", headers: { authorization: "Bearer SYNTHETIC" }, body: "{\"secret\":1}" }), /another origin/);
  assert.equal(seen.length, before, "a 307 never resends the body elsewhere");
});
