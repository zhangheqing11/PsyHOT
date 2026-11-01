// Published dates on list pages: a date without a zone is read in the source's offset, whatever zone
// the server runs in (Docker runs in UTC; run this file with TZ=UTC and TZ=Asia/Shanghai to see both).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromHtml, parseLooseDate, readRelativeDate } from "@aihot/backend/sources/web-list";

const iso = (v: string, offset?: string) => parseLooseDate(v, offset)?.toISOString() ?? null;

test("a date and time without a zone is in the source's offset, not the server's", () => {
  assert.equal(iso("2026-09-26 10:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026-09-26T10:00:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026/09/26 10:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026年9月26日 10:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026-09-26 10:00", "-07:00"), "2026-09-26T17:00:00.000Z");
});

test("a bare date is midnight in the source's offset; an ISO date alone stays UTC midnight", () => {
  assert.equal(iso("2026/09/26"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("2026年9月26日"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("Sep 26, 2026"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("2026-09-26"), "2026-09-26T00:00:00.000Z");
  assert.equal(iso("September 26th, 2026", "+00:00"), "2026-09-26T00:00:00.000Z");
});

test("a date that carries its zone keeps it", () => {
  assert.equal(iso("2026-09-26T10:00:00Z"), "2026-09-26T10:00:00.000Z");
  assert.equal(iso("2026-09-26T10:00:00.000+09:00"), "2026-09-26T01:00:00.000Z");
  assert.equal(iso("Sat, 26 Sep 2026 10:00:00 GMT"), "2026-09-26T10:00:00.000Z");
  assert.equal(iso("Sat, 26 Sep 2026 10:00:00 +0200", "-07:00"), "2026-09-26T08:00:00.000Z");
});

test("no date at all is null", () => {
  assert.equal(iso(""), null);
  assert.equal(iso("yesterday"), null);
});

test("a date rule's element that prints an age counts back from the moment it is read", () => {
  const now = new Date("2026-10-24T01:30:00.000Z"); // 09:30 in +08:00
  assert.equal(readRelativeDate("20小时前", now)?.toISOString(), "2026-10-23T05:30:00.000Z");
  assert.equal(readRelativeDate(" 15 分钟前 ", now)?.toISOString(), "2026-10-24T01:15:00.000Z");
  assert.equal(readRelativeDate("刚刚", now)?.toISOString(), now.toISOString());
  assert.equal(readRelativeDate("3 hours ago", now, "+00:00")?.toISOString(), "2026-10-23T22:30:00.000Z");
  // More than a day of hours is still hours: its time is kept, not cut to a calendar day.
  assert.equal(readRelativeDate("47小时前", now)?.toISOString(), "2026-10-22T02:30:00.000Z");
  // Days keep the calendar day in the source's offset, as its midnight.
  assert.equal(readRelativeDate("2天前", now)?.toISOString(), "2026-10-21T16:00:00.000Z");
  assert.equal(readRelativeDate("昨天", now)?.toISOString(), "2026-10-22T16:00:00.000Z");
  // 22:30 on the 23rd in -03:00, a day back is the 22nd there.
  assert.equal(readRelativeDate("1 day ago", now, "-03:00")?.toISOString(), "2026-10-22T03:00:00.000Z");
});

test("an age inside other text is no date", () => {
  const now = new Date("2026-10-24T01:30:00.000Z");
  for (const v of ["两天前开业的店", "大约2天前", "2天前 1.1万", "", null]) assert.equal(readRelativeDate(v, now), null, String(v));
});

test("a date rule's element that prints today's or a recent day's time reads it on that day in the source's offset", () => {
  const now = new Date("2026-10-24T10:30:00.000Z"); // 18:30 in +08:00
  assert.equal(readRelativeDate("今天 15:46", now)?.toISOString(), "2026-10-24T07:46:00.000Z");
  assert.equal(readRelativeDate("今天08:29", now)?.toISOString(), "2026-10-24T00:29:00.000Z");
  assert.equal(readRelativeDate("昨天 23:10", now)?.toISOString(), "2026-10-23T15:10:00.000Z");
  assert.equal(readRelativeDate("前天 08:05", now)?.toISOString(), "2026-10-22T00:05:00.000Z");
  // 01:30Z is 09:30 on the 24th in +08:00 but 22:30 on the 23rd in -03:00: "今天" is the source's day.
  assert.equal(readRelativeDate("今天 21:00", new Date("2026-10-24T01:30:00.000Z"), "-03:00")?.toISOString(), "2026-10-24T00:00:00.000Z");
});

test("a byline ahead of the date in the same element is no part of it", () => {
  const now = new Date("2026-10-24T10:30:00.000Z");
  // 创业邦 prints its author and the age in one element: "版面之外·今天 15:46", "创业邦的创作者·48分钟前".
  assert.equal(readRelativeDate("版面之外·今天 15:46", now)?.toISOString(), readRelativeDate("今天 15:46", now)?.toISOString());
  assert.equal(readRelativeDate("创业邦的创作者·48分钟前", now)?.toISOString(), "2026-10-24T09:42:00.000Z");
  assert.equal(readRelativeDate("20社 · 昨天 09:00", now)?.toISOString(), readRelativeDate("昨天 09:00", now)?.toISOString());
});

test("an age in short English units reads like the long ones", () => {
  const now = new Date("2026-10-24T10:30:00.000Z");
  // DealStreetAsia and TNW listings: "16h ago", "29m ago".
  assert.equal(readRelativeDate("16h ago", now, "+00:00")?.toISOString(), "2026-10-23T18:30:00.000Z");
  assert.equal(readRelativeDate("29m ago", now, "+00:00")?.toISOString(), "2026-10-24T10:01:00.000Z");
  assert.equal(readRelativeDate("2d ago", now, "+00:00")?.toISOString(), "2026-10-22T00:00:00.000Z");
});

test("today's time inside other text, a time that does not exist, a bare time and a month-day are no age", () => {
  const now = new Date("2026-10-24T10:30:00.000Z");
  // A bare time read after midnight lands on the wrong day, and a month and day has no year.
  for (const v of ["据说今天 15:46 发布", "今天 24:00", "今天 25:00", "今天 15:61", "版面之外·今天 15:46 1.1万", "关于·两天前开业的店", "甲·乙·今天 15:46", "·今天 15:46", "16h", "29 m ago later", "17:05", "10-23"]) {
    assert.equal(readRelativeDate(v, now), null, v);
  }
});

test("a list's date element is read as a date, else as an age", () => {
  const html = (date: string) => `<li><a href="/post/1">Post one</a><span class="d">${date}</span></li>`;
  const read = (date: string) => fromHtml(html(date), "https://example.org/", { id: "test-list", config: { itemSelector: "li", publishedAtSelector: ".d", publishedAtUtcOffset: "+08:00" } } as never)[0]!.publishedAt;
  assert.equal(read("2026-10-20")?.toISOString(), "2026-10-20T00:00:00.000Z", "a date is read as before");
  const before = Date.now();
  const hoursAgo = read("20小时前")!.getTime();
  assert.ok(hoursAgo >= before - 20 * 3600e3 - 1000 && hoursAgo <= Date.now() - 20 * 3600e3, "20小时前 is 20 hours before the page was read");
  assert.equal(read("两天前开业的店"), null);
  assert.equal(read("17:05"), null);
});
