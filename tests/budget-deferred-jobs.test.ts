// Budget pauses put the same pg-boss job back in retry without spending a retry slot or creating
// a second row. The test uses a local queue and never calls a provider.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { BudgetExceededError, ProviderRejectedError } from "@aihot/backend/providers/receipts";
import { deferBudgetJob, getBoss, runBudgetAware, stopBoss } from "@aihot/backend/jobs/queue";

const queue = `test.budget-deferred-${tag()}`;
const subject = { test: tag() };

after(async () => {
  await stopBoss();
  await closeDb();
});

test("budget rejection defers the same job, keeps retry_count, and records a skipped run", async () => {
  const boss = await getBoss();
  await boss.createQueue(queue, { policy: "short", retryLimit: 0, expireInSeconds: 120 });
  const id = await boss.send(queue, subject);
  assert.ok(id);

  const [first] = await boss.fetch<typeof subject>(queue, { includeMetadata: true });
  assert.ok(first);
  assert.equal(first.id, id);
  const firstRetryCount = first.retryCount;
  const detail = await deferBudgetJob(first, new BudgetExceededError("deepseek", "minute", 2));
  assert.ok(detail);

  // Make the deferred row immediately fetchable to exercise the second retry. This does not alter
  // retry_count; the next claim increments it exactly as pg-boss normally would.
  await sql`UPDATE pgboss.job SET start_after = now() WHERE id = ${id}`;
  const [second] = await boss.fetch<typeof subject>(queue, { includeMetadata: true });
  assert.ok(second);
  assert.equal(second.id, id, "the retry reuses the original id");
  assert.equal(second.retryCount, firstRetryCount + 1);
  const secondRetryCount = second.retryCount;
  const detail2 = await deferBudgetJob(second, new BudgetExceededError("deepseek", "hour", 4));
  assert.ok(detail2);

  const jobs = await sql<{ id: string; state: string; retry_count: number; start_after: Date }[]>`
    SELECT id, state, retry_count, start_after FROM pgboss.job WHERE id = ${id}`;
  assert.equal(jobs.length, 1, "deferral never creates a duplicate job");
  assert.equal(jobs[0]!.state, "retry");
  assert.equal(jobs[0]!.retry_count, secondRetryCount, "budget waiting does not consume a retry count");
  assert.ok(jobs[0]!.start_after.getTime() > Date.now(), "retryAt is in the future");

  const [run] = await sql<{ status: string; detail: { reason: string; service: string; period: string; retryAt: string } }[]>`
    SELECT status, detail FROM job_runs WHERE job = ${queue} ORDER BY id DESC LIMIT 1`;
  assert.equal(run!.status, "skipped");
  assert.deepEqual(run!.detail.reason, "budget");
  assert.deepEqual(run!.detail.service, "deepseek");
  assert.deepEqual(run!.detail.period, "hour");
  assert.ok(Date.parse(run!.detail.retryAt) > Date.now());

  // A worker restart sees the same deferred row and can claim it once the budget window is open.
  await stopBoss();
  const restarted = await getBoss();
  await sql`UPDATE pgboss.job SET start_after = now() WHERE id = ${id}`;
  const [afterRestart] = await restarted.fetch<typeof subject>(queue, { includeMetadata: true });
  assert.ok(afterRestart);
  assert.equal(afterRestart.id, id);
  assert.equal(afterRestart.retryCount, secondRetryCount + 1);
  await restarted.fail(queue, id, { error: "test cleanup" });
});

test("the wrapper only handles BudgetExceededError", async () => {
  const boss = await getBoss();
  const otherQueue = `${queue}-classification`;
  await boss.createQueue(otherQueue, { policy: "short", retryLimit: 1, expireInSeconds: 120 });
  const id = await boss.send(otherQueue, subject);
  assert.ok(id);
  const [job] = await boss.fetch<typeof subject>(otherQueue, { includeMetadata: true });
  assert.ok(job);
  await assert.rejects(
    runBudgetAware(job, async () => { throw new ProviderRejectedError("provider refused", 400, false); }),
    ProviderRejectedError,
  );
  const [row] = await sql<{ state: string }[]>`SELECT state FROM pgboss.job WHERE id = ${id}`;
  assert.equal(row!.state, "active", "provider refusals retain the ordinary error path");
  await boss.fail(otherQueue, id, { error: "test cleanup" });
});
