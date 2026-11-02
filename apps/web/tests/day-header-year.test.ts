// Dates of another year (features/feed/Timeline.tsx, lib/format.ts). Failure case: an item imported from an
// archive, dated 2019-02-19, sits under a header reading "2月19日" (on the timeline, a story's report days, the
// "月日 时:分" stamps), and readers take it for this year's; or last year's December item, read in January.
import assert from "node:assert/strict";
import { test } from "node:test";
import { monthDay } from "@aihot/contracts/time";
import { monthDay as pageMonthDay, monthDayTime } from "../app/lib/format.ts";
import { dayWord, stamp } from "../app/features/monitor/format.ts";

test("a day of today's year has no year; another year's carries it", () => {
  assert.equal(monthDay("2026-10-05", "2026-10-19"), "10月5日");
  assert.equal(monthDay("2019-02-19", "2026-10-19"), "2019年2月19日");
  assert.equal(monthDay("2025-12-31", "2026-01-01"), "2025年12月31日");
});

test("without today, as everywhere else, it stays month and day", () => {
  assert.equal(monthDay("2019-02-19"), "2月19日");
});

test("the pages' dates carry another Beijing year", () => {
  assert.equal(pageMonthDay("2026-10-05", "2026-10-05"), "10月5日");
  assert.equal(pageMonthDay("2019-02-19", "2026-10-05"), "2019年2月19日");
  assert.equal(monthDayTime("2019-02-19T04:00:00.000Z", "2026-10-05"), "2019年2月19日 12:00");
  assert.equal(monthDayTime("2026-10-05T04:00:00.000Z", "2026-10-05"), "10月5日 12:00");
});

test("the year turns at Beijing midnight, whatever the clock it is read on", () => {
  // 16:30 UTC on 31 December is 00:30 on 1 January in Beijing, so that stamp is of the new year.
  assert.equal(monthDayTime("2026-12-31T16:30:00.000Z", "2027-01-01"), "1月1日 00:30");
  assert.equal(monthDayTime("2026-12-31T15:30:00.000Z", "2027-01-01"), "2026年12月31日 23:30");
  assert.equal(pageMonthDay("2027-01-01", "2026-12-31"), "2027年1月1日");
  assert.equal(pageMonthDay("2026-12-31", "2027-01-01"), "2026年12月31日");
});

test("the reset monitor names another year too", () => {
  assert.equal(dayWord("2026-12-20", "2027-01-02"), "2026年12月20日");
  assert.equal(dayWord("2027-01-01", "2027-01-02"), "昨天");
  assert.equal(stamp("2026-12-31T21:40:00+08:00", "2027-01-02"), "2026/12/31 21:40");
  assert.equal(stamp("2027-01-01T21:40:00+08:00", "2027-01-02"), "1/1 21:40");
});
