import assert from "node:assert/strict";
import { test } from "node:test";
import { asBiz, candidates, matchingCandidate } from "../scripts/resolve-wechat-accounts-logic.ts";

test("matches EveryInfra decimal biz to the configured base64 __biz", () => {
  const decimalBiz = "3931328140";
  const configuredBiz = Buffer.from(decimalBiz).toString("base64");
  const found = candidates([
    { ghid: "gh_92be14ed2cc6", name: "目标账号", biz: decimalBiz },
    { ghid: "gh_488f0fffb927", name: "另一个账号", biz: "1234567890" },
  ]);

  assert.equal(asBiz(decimalBiz), configuredBiz);
  assert.equal(matchingCandidate(found, configuredBiz)?.ghid, "gh_92be14ed2cc6");
  assert.equal(matchingCandidate(found, Buffer.from("987654321").toString("base64")), null);
});
