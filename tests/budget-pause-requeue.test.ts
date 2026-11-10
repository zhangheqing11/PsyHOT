// The safety net must leave articles held by budget-paused jobs alone, even after the queue
// timestamp goes stale. These tests use the real local queue and never call a provider.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { queueProcessing, sweepUnprocessed } from "@aihot/backend/jobs/content";
import { deferBudgetJob, enqueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { BudgetExceededError } from "@aihot/backend/providers/receipts";

const sourceId = `test-budget-pause-${tag()}`;

async function newArticle() {
  const { articleId } = await upsertMaterial({
    sourceId, url: `https://example.org/budget-pause-${tag()}`, title: "Budget-paused article",
    bodyText: "A confirmed article body.", bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  return articleId;
}

async function makeStale(articleId: string) {
  await sql`UPDATE articles SET created_at = now() - interval '31 minutes',
              processing_queued_at = now() - interval '31 minutes' WHERE id = ${articleId}`;
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, participation_mode, next_fetch_at)
            VALUES (${sourceId}, 'Test budget pause', 'rss', 'editorial', '2100-01-01')`;
});

after(async () => {
  await stopBoss();
  await sql`DELETE FROM pgboss.job WHERE singleton_key IN (SELECT id FROM articles WHERE source_id = ${sourceId})`;
  await sql`DELETE FROM articles WHERE source_id = ${sourceId}`;
  await sql`DELETE FROM sources WHERE id = ${sourceId}`;
  await closeDb();
});

test("the safety net keeps only the original analysis job during a three-hour budget pause", async () => {
  const articleId = await newArticle();
  const jobId = await queueProcessing(articleId);
  assert.ok(jobId);
  // Claim this exact job: other test files may have left work in the shared analysis queue.
  const [active] = await sql<{ id: string; name: string }[]>`
    UPDATE pgboss.job SET state = 'active', started_on = now()
    WHERE id = ${jobId} AND name = ${QUEUES.analyze} AND state = 'created' RETURNING id, name`;
  assert.ok(active);
  const pauseSeconds = 3 * 60 * 60;
  const beforePause = Date.now();
  const detail = await deferBudgetJob(active, new BudgetExceededError("deepseek", "day", pauseSeconds));
  assert.ok(detail);
  const [paused] = await sql<{ state: string; start_after: Date }[]>`
    SELECT state, start_after FROM pgboss.job WHERE id = ${jobId} AND name = ${QUEUES.analyze}`;
  assert.equal(paused!.state, "retry");
  assert.equal(paused!.start_after.toISOString(), detail.retryAt);
  assert.ok(paused!.start_after.getTime() >= beforePause + pauseSeconds * 1000);

  await makeStale(articleId);
  await sweepUnprocessed();
  const jobs = await sql<{ id: string; state: string }[]>`
    SELECT id, state FROM pgboss.job WHERE name = ${QUEUES.analyze} AND singleton_key = ${articleId}
      AND state IN ('created', 'retry', 'active')`;
  assert.equal(jobs.length, 1, `the budget-paused job must be the only live job: ${JSON.stringify(jobs)}`);
  assert.equal(jobs[0]!.id, jobId);
  assert.equal(jobs[0]!.state, "retry");
});

for (const queue of [QUEUES.analyze, QUEUES.extractBody, QUEUES.group]) {
  for (const state of ["created", "retry", "active"] as const) {
    test(`the safety net leaves a stale article held by a ${state} ${queue} job alone`, async () => {
      const articleId = await newArticle();
      const jobId = await enqueue(queue, { articleId }, { singletonKey: articleId });
      assert.ok(jobId);
      await sql`UPDATE pgboss.job SET state = ${state} WHERE id = ${jobId} AND name = ${queue}`;
      await makeStale(articleId);

      await sweepUnprocessed();
      const jobs = await sql<{ id: string; name: string; state: string }[]>`
        SELECT id, name, state FROM pgboss.job WHERE singleton_key = ${articleId}`;
      assert.equal(jobs.length, 1, JSON.stringify(jobs));
      assert.equal(jobs[0]!.id, jobId);
      assert.equal(jobs[0]!.name, queue);
      assert.equal(jobs[0]!.state, state);
      const [article] = await sql<{ stale: boolean }[]>`
        SELECT processing_queued_at < now() - interval '30 minutes' AS stale FROM articles WHERE id = ${articleId}`;
      assert.equal(article!.stale, true, "the safety net must not refresh a queue-held article's timestamp");
    });
  }
}

for (const state of ["completed", "failed"] as const) {
  test(`the safety net requeues a stale new article when its only job is ${state}`, async () => {
    const articleId = await newArticle();
    const jobId = await queueProcessing(articleId);
    assert.ok(jobId);
    await sql`UPDATE pgboss.job SET state = ${state}, completed_on = now()
              WHERE id = ${jobId} AND name = ${QUEUES.analyze}`;
    await makeStale(articleId);

    await sweepUnprocessed();
    const jobs = await sql<{ id: string; state: string }[]>`
      SELECT id, state FROM pgboss.job WHERE name = ${QUEUES.analyze} AND singleton_key = ${articleId}`;
    assert.equal(jobs.length, 2, "a terminal job must not block recovery of an unprocessed article");
    assert.equal(jobs.find((job) => job.id === jobId)?.state, state);
    const live = jobs.filter((job) => ["created", "retry", "active"].includes(job.state));
    assert.equal(live.length, 1);
    assert.notEqual(live[0]!.id, jobId);
    assert.equal(live[0]!.state, "created");
    const [article] = await sql<{ processing_state: string; recently_queued: boolean }[]>`
      SELECT processing_state, processing_queued_at > now() - interval '1 minute' AS recently_queued
      FROM articles WHERE id = ${articleId}`;
    assert.equal(article!.processing_state, "new");
    assert.equal(article!.recently_queued, true);
  });
}
