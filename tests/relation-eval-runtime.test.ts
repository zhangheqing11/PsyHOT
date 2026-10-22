import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { REPO_ROOT } from "@aihot/backend/config";
import type { RelationGoldRow } from "../scripts/eval-relations-core.ts";

const exec = promisify(execFile);
const answer = JSON.stringify({ a: "A", b: "B", relation: "UNRELATED", difference: "different events", confidence: 0.99 });
const row = (caseId: string, input: string, relation: RelationGoldRow["gold"]["relation"]): RelationGoldRow => ({
  caseId,
  a: { title: `${input} A`, source: "Example", firstParty: false, publishedAt: null, summary: null },
  b: { title: `${input} B`, source: "Example", firstParty: false, publishedAt: null, summary: null },
  gold: { relation },
});

interface Result {
  summary: { evaluated: number; errors: number; accuracy: number; tokensIn: number; tokensOut: number };
  confusionMatrix: unknown;
  cases: Array<{ caseId: string; receiptId: number; decision: string | null; error: string | null }>;
}

async function evaluate(rows: RelationGoldRow[], providerUrl: string, concurrency = 6): Promise<Result> {
  const dir = mkdtempSync(path.join(tmpdir(), "relation-eval-"));
  let report: string | undefined;
  try {
    const gold = path.join(dir, "gold.jsonl");
    writeFileSync(gold, rows.map((item) => JSON.stringify(item)).join("\n"));
    const { stdout } = await exec(process.execPath, [
      "scripts/eval-relations.ts", "--now", "--gold", gold, "--models", "deepseek-flash", "--concurrency", String(concurrency),
    ], {
      cwd: REPO_ROOT,
      env: { ...process.env, MODEL_CALLS_ENABLED: "true", DEEPSEEK_BASE_URL: `${providerUrl}/v1`, DEEPSEEK_API_KEY: "test-key" },
      timeout: 15_000,
    });
    report = stdout.split("\n").find((line) => line.startsWith("report: "))?.slice(8);
    assert.ok(report, stdout);
    return (JSON.parse(readFileSync(report, "utf8")) as { models: Record<string, Result> }).models["deepseek-flash"]!;
  } finally {
    if (report) rmSync(report);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("identical pair inputs retain every gold case on both cold and cached evaluations", async (t) => {
  const provider = await stub(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { choices: [{ message: { content: answer } }], usage: { prompt_tokens: 100, completion_tokens: 20 } };
  });
  t.after(() => provider.close());
  const input = tag();
  const rows = [row("duplicate-1", input, "SAME_OCCURRENCE"), row("duplicate-2", input, "SAME_OCCURRENCE"), row("unique", `${input}-unique`, "UNRELATED")];
  const cold = await evaluate(rows, provider.url);
  const warm = await evaluate(rows, provider.url);
  assert.equal(provider.hits(), 2, "one provider request per distinct input across both runs");
  for (const result of [cold, warm]) {
    assert.equal(result.summary.evaluated, 3);
    assert.equal(result.summary.errors, 0);
    assert.equal(result.summary.accuracy, 0.333);
    assert.equal(result.summary.tokensIn, 200, "shared receipts count once");
    assert.equal(new Set(result.cases.map((item) => item.caseId)).size, 3);
  }
  assert.deepEqual(cold.confusionMatrix, warm.confusionMatrix);
  assert.equal(cold.cases.find((item) => item.caseId === "duplicate-1")!.receiptId,
    cold.cases.find((item) => item.caseId === "duplicate-2")!.receiptId);
});

test("failed duplicate inputs share one attempt and a later retry retains all response usage", async (t) => {
  const provider = await stub((hit) => ({
    choices: [{ message: { content: hit === 1 ? "not JSON" : answer } }],
    usage: { prompt_tokens: hit === 1 ? 100 : 300, completion_tokens: 20 },
  }));
  t.after(() => provider.close());
  const input = tag();
  const rows = [row("retry-1", input, "UNRELATED"), row("retry-2", input, "UNRELATED")];
  const failed = await evaluate(rows, provider.url, 1);
  assert.equal(provider.hits(), 1, "sequential duplicate cases do not retry the failed response");
  assert.equal(failed.summary.errors, 2);
  assert.equal(failed.summary.tokensIn, 100);
  const retried = await evaluate(rows, provider.url, 1);
  assert.equal(provider.hits(), 2);
  assert.equal(retried.summary.errors, 0);
  assert.equal(retried.summary.evaluated, 2);
  assert.equal(retried.summary.tokensIn, 400, "both attempts count, including the unusable response");
  assert.equal(retried.summary.tokensOut, 40);
  assert.equal(retried.cases[0]!.receiptId, failed.cases[0]!.receiptId);
});
