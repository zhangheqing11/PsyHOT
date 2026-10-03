import assert from "node:assert/strict";
import { test } from "node:test";
import { isPeak, nextOffPeak } from "@aihot/backend/lib/offpeak";

// Beijing time is UTC+8; 2026-10-12 is a Monday.
const bj = (s: string) => new Date(`${s}+08:00`);

test("peak is weekday 9–12 and 14–18 Beijing time; lunch, evenings, weekends and listed holidays are off-peak", () => {
  const none = new Set<string>();
  assert.equal(isPeak(bj("2026-10-12T08:59:59"), none), false);
  assert.equal(isPeak(bj("2026-10-12T09:00:00"), none), true);
  assert.equal(isPeak(bj("2026-10-12T11:59:59"), none), true);
  assert.equal(isPeak(bj("2026-10-12T12:30:00"), none), false);
  assert.equal(isPeak(bj("2026-10-12T17:59:00"), none), true);
  assert.equal(isPeak(bj("2026-10-12T18:00:00"), none), false);
  assert.equal(isPeak(bj("2026-10-17T10:00:00"), none), false, "Saturday");
  assert.equal(isPeak(bj("2026-10-12T10:00:00"), new Set(["2026-10-12"])), false, "listed holiday");
});

test("the next off-peak start is the end of the current peak window", () => {
  const none = new Set<string>();
  assert.equal(nextOffPeak(bj("2026-10-12T10:20:00"), none).toISOString(), bj("2026-10-12T12:00:00").toISOString());
  assert.equal(nextOffPeak(bj("2026-10-12T14:05:00"), none).toISOString(), bj("2026-10-12T18:00:00").toISOString());
  const evening = bj("2026-10-12T20:00:00");
  assert.equal(nextOffPeak(evening, none).getTime(), evening.getTime());
});
