// Cross-year ambiguity of the report pages' printed calendar days (features/report/format.ts). Failure cases, the
// same class as day-header-year.test.ts: on 2 January 2027 the phone switcher's chip for the 31 December issue reads
// "12月31日" and the "前一日" link on the 1 January issue reads "前一日 · 12月31日", both as 2027's; and the week of
// 28 December to 3 January is headed "12.28 — 01.03" with only one year above it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chipLabel, dateLine, neighbourLabel, periodGrid } from "../app/features/report/format.ts";

const index = [
  { key: "2026-12-31", issueNumber: 400, title: "第400期" },
  { key: "2027-01-01", issueNumber: 401, title: "第401期" },
];

test("the phone chip names the year of another Beijing year", () => {
  assert.equal(chipLabel("daily", "2027-01-02", index, "2027-01-02"), "今天");
  assert.equal(chipLabel("daily", "2027-01-01", index, "2027-01-02"), "1月1日");
  assert.equal(chipLabel("daily", "2026-12-31", index, "2027-01-02"), "2026年12月31日");
  assert.equal(chipLabel("monthly", "2026-12", [], "2027-01-02"), "2026 年 12 月");
  assert.equal(chipLabel("monthly", "2027-01", [], "2027-01-02"), "1 月");
});

test("the prev/next links name the year across the year boundary", () => {
  assert.equal(neighbourLabel("daily", "2026-12-30", "prev", "2026-12-31"), "前一日 · 12月30日");
  assert.equal(neighbourLabel("daily", "2027-01-01", "next", "2026-12-31"), "后一日 · 2027年1月1日");
  assert.equal(neighbourLabel("daily", "2026-12-31", "prev", "2027-01-01"), "前一日 · 2026年12月31日");
  assert.equal(neighbourLabel("daily", "2027-01-02", "next", "2027-01-01"), "后一日 · 1月2日");
  assert.equal(neighbourLabel("weekly", "2026-W52", "prev", "2027-01-05"), "上一期 · 2026 年第 52 周");
  assert.equal(neighbourLabel("monthly", "2026-12", "prev", "2027-01-05"), "上一期 · 2026 年 12 月");
  assert.equal(neighbourLabel("weekly", "2027-W01", "next", "2027-01-05"), "下一期 · 第 1 周");
});

test("a week across New Year names both years, one inside a year does not", () => {
  assert.equal(dateLine("weekly", "2026-W53"), "2026 年第 53 周 · 2026.12.28 — 2027.01.03");
  assert.equal(dateLine("weekly", "2026-W38"), "2026 年第 38 周 · 09.14 — 09.20");
  const week53 = periodGrid("weekly", "2026-W53", []).cells.at(-1)!;
  assert.match(week53.label, /^第 53 周（2026\.12\.28—2027\.01\.03）/);
});
