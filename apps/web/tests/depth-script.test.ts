import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../deploy/depth.sh", import.meta.url));
const midnight = 1794931200; // 2026-11-18 00:00 Beijing
function log(uri: string, ua: string, ip = "192.0.2.1", ts = midnight, client = false) {
  return JSON.stringify({ ts, request: { uri, [client ? "client_ip" : "remote_ip"]: ip, headers: { "User-Agent": [ua] } } });
}
function event(page: string, d: number, x: number, ua = "iPhone Mobile", ts = midnight, view = "") {
  const params = new URLSearchParams({ k: "depth", p: page, d: String(d), x: String(x), w: "375" });
  if (view) params.set("v", view);
  return log(`/_ev?${params}`, ua, "192.0.2.1", ts);
}
function report(lines: string[], args: string[] = []) {
  const result = spawnSync("sh", [script, "--stdin", ...args], { input: lines.join("\n") + "\n", encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("depth script computes per-day device and per-page medians, rates and expansion means", () => {
  const output = report([
    event("/", 0, 0, "MicroMessenger Mobile"), event("/", 10, 2, "MicroMessenger Mobile"),
    event("/all?q=睡眠", 3, 2), event("/topics/cognition-neuro/page/2", 5, 1), event("/starred", 7, 0, "iPhone Mobile", midnight - 1),
  ]);
  assert.ok(output.includes("2026-11-18\t微信内\t2\t5\t50.0%\t50.0%\t50.0%\t1.00"));
  assert.ok(output.includes("2026-11-18\t其他手机\t2\t4\t100.0%\t50.0%\t0.0%\t1.50"));
  assert.ok(output.includes("2026-11-17\t其他手机\t1\t7\t100.0%\t100.0%\t0.0%\t0.00"));
  assert.ok(output.includes("/all\t1\t3\t100.0%\t0.0%\t0.0%\t2.00"));
  assert.ok(output.includes("/topics/*\t1\t5\t100.0%\t100.0%\t0.0%\t1.00"));
});

test("funnel sorts rotated log order, uses client_ip fallback and excludes bots and non-home entries", () => {
  const output = report([
    log("/_pv?p=%2Fitems%2Fone", "Desktop", "192.0.2.1", midnight + 60),
    log("/_pv?p=%2F", "Desktop", "192.0.2.1", midnight),
    log("/_pv?p=%2F%3Ftrack%3Dacademic", "iPhone Mobile", "192.0.2.2"),
    log("/_pv?p=%2F", "MicroMessenger Mobile", "192.0.2.3", midnight, true),
    log("/_pv?p=%2Fstory%2Fone", "MicroMessenger Mobile", "192.0.2.3", midnight + 60, true),
    ...["SomeBOT", "Spider", "crawler"].map((ua) => log("/_pv?p=%2F", ua, "192.0.2.4")),
    log("/_pv?p=%2Fall", "Desktop", "192.0.2.5", midnight),
    log("/_pv?p=%2F", "Desktop", "192.0.2.5", midnight + 60),
  ]);
  assert.ok(output.includes("电脑\t1\t100.0%\t0.0%"));
  assert.ok(output.includes("手机\t1\t0.0%\t100.0%"));
  assert.ok(output.includes("微信\t1\t100.0%\t0.0%"));
  assert.ok(output.includes("2026-11-18\t电脑\t1\t100.0%\t0.0%"));
});

test("date filters include both Beijing boundary dates and visits are grouped by IP, UA and day", () => {
  const logs = [
    event("/", 100, 0, "Mobile", midnight - 1), event("/", 0, 0, "Mobile", midnight),
    event("/", 10, 0, "Mobile", midnight + 86399), event("/", 100, 0, "Mobile", midnight + 86400),
    log("/_pv?p=%2F", "Desktop", "192.0.2.1", midnight - 1),
    log("/_pv?p=%2F", "Desktop", "192.0.2.1", midnight),
    log("/_pv?p=%2F", "Mobile", "192.0.2.1", midnight),
    log("/_pv?p=%2F", "Desktop", "192.0.2.1", midnight + 86400),
  ];
  const output = report(logs, ["--since", "2026-11-18", "--until", "2026-11-18"]);
  assert.ok(output.includes("2026-11-18\t其他手机\t2\t5\t50.0%\t50.0%\t50.0%\t0.00"));
  assert.doesNotMatch(output, /2026-11-17|2026-11-19/);
  assert.ok(output.includes("电脑\t1\t0.0%\t100.0%"));
  assert.ok(output.includes("手机\t1\t0.0%\t100.0%"));
  assert.ok(report(logs).includes("电脑\t3\t0.0%\t100.0%"));
});

test("malformed lines and invalid beacon data are skipped without hiding valid zero-depth visits", () => {
  const output = report([
    "not-json", "[]", "null", '{"ts":null,"request":{}}', '{"ts":true,"request":{}}',
    '{"ts":1e200,"request":{}}', JSON.stringify({ ts: midnight, request: { uri: [] } }),
    log("/_ev?k=depth&p=%2F&d=-1&x=0", "Mobile"), log("/_ev?k=depth&p=%2F&d=0.5&x=0", "Mobile"),
    log(`/_ev?k=depth&p=%2F&d=${"9".repeat(400)}&x=0`, "Mobile"),
    log("/_ev?k=depth&p=%2Ftopics&d=10&x=1", "Mobile"), log("/_ev?k=other&p=%2F&d=10&x=1", "Mobile"),
    log("/_pv?p=https%3A%2F%2Fexample.com", "Mobile"), log("/_pv?p=%2F", "Mobile", ""),
    event("/", 0, 0),
  ]);
  assert.ok(output.includes("/\t1\t0\t0.0%\t0.0%\t0.0%\t0.00"));
  assert.ok(output.includes("手机\t0\t0.0%\t0.0%"));
});

test("invalid calendar dates and reversed ranges fail before analysis", () => {
  for (const args of [["--since", "2026-02-30"], ["--since", "20261118"], ["--since", "2026-11-19", "--until", "2026-11-18"]]) {
    const result = spawnSync("sh", [script, "--stdin", ...args], { input: "", encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /error:/);
  }
});

test("log collection failures cannot masquerade as an empty successful report", () => {
  const result = spawnSync("sh", [script, "--stdin"], { input: '{"_depth_log_read_failed":true}\n', encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not read Caddy access logs/);
  assert.equal(result.stdout, "");
});

test("repeated reports with one visit id merge into one view at the maximum depth and expansions", () => {
  const output = report([
    event("/", 3, 0, "iPhone Mobile", midnight, "same-view"),
    event("/", 8, 1, "iPhone Mobile", midnight + 60, "same-view"),
  ]);
  assert.ok(output.includes("日期\t设备\t浏览数\t深度中位数"));
  assert.ok(output.includes("页面\t浏览数\t深度中位数"));
  assert.ok(output.includes("2026-11-18\t其他手机\t1\t8\t100.0%\t100.0%\t0.0%\t1.00"));
  assert.ok(output.includes("/\t1\t8\t100.0%\t100.0%\t0.0%\t1.00"));
});

test("visit merging keeps the first page and UA, takes expansion maxima independently and preserves legacy rows", () => {
  const output = report([
    event("/", 3, 2, "MicroMessenger Mobile", midnight, "same-view"),
    event("/all", 8, 1, "iPhone Mobile", midnight + 60, "same-view"),
    event("/starred", 3, 0), event("/starred", 3, 0),
  ]);
  assert.ok(output.includes("2026-11-18\t微信内\t1\t8\t100.0%\t100.0%\t0.0%\t2.00"));
  assert.ok(output.includes("/\t1\t8\t100.0%\t100.0%\t0.0%\t2.00"));
  assert.ok(output.includes("/all\t0\t0\t0.0%\t0.0%\t0.0%\t0.00"));
  assert.ok(output.includes("/starred\t2\t3\t100.0%\t0.0%\t0.0%\t0.00"));
});
