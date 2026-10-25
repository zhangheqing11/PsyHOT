import assert from "node:assert/strict";
import { test } from "node:test";
import { isPoolEligible } from "@aihot/backend/publication/rules";
import { assertSupportedConfig, unsupportedConfig } from "@aihot/backend/sources/config-keys";

const ready = { participationMode: "editorial", relevance: "pass", title: "中文标题", summary: "中文摘要" };

test("a source pool minimum requires a score at least equal to the configured floor", () => {
  assert.equal(isPoolEligible({ ...ready, poolMinScore: 40, score: 39.9 }), false);
  assert.equal(isPoolEligible({ ...ready, poolMinScore: 40, score: null }), false);
  assert.equal(isPoolEligible({ ...ready, poolMinScore: 40 }), false);
  assert.equal(isPoolEligible({ ...ready, poolMinScore: 40, score: 40 }), true);
  assert.equal(isPoolEligible({ ...ready, poolMinScore: 40, score: 85 }), true);
  assert.equal(isPoolEligible({ ...ready, poolMinScore: 0, score: null }), false);
  assert.equal(isPoolEligible({ ...ready, poolMinScore: 0, score: 0 }), true);
  assert.equal(isPoolEligible({ ...ready, poolMinScore: 40, score: 99, relevance: "block" }), false);
  assert.equal(isPoolEligible({ ...ready, poolMinScore: 40, score: 99, participationMode: "hot_signal" }), false);
});

test("sources without a pool minimum keep their existing unscored and low-score entries", () => {
  assert.equal(isPoolEligible(ready), true);
  assert.equal(isPoolEligible({ ...ready, score: null }), true);
  assert.equal(isPoolEligible({ ...ready, score: 1 }), true);
});

test("every source kind accepts a numeric pool minimum from zero to one hundred only", () => {
  for (const kind of ["rss", "web_list", "json_list", "x_search", "mp_account", "external"] as const) {
    for (const poolMinScore of [0, 40, 40.5, 100]) assert.deepEqual(unsupportedConfig(kind, { poolMinScore }), []);
    for (const poolMinScore of [-1, 101, "40", null, NaN, Infinity, true]) {
      assert.throws(() => assertSupportedConfig(kind, { poolMinScore }), /poolMinScore/);
    }
  }
});
