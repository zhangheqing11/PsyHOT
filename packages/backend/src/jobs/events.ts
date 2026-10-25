// Event jobs: serial grouping, debounced digests.
import type { PgBoss } from "pg-boss";
import { groupArticle } from "../events/group.ts";
import { composeStoryDigest } from "../events/digest.ts";
import { BudgetExceededError, ReceiptBusyError } from "../providers/receipts.ts";
import { settleNonEditorial } from "./content.ts";
import { ensureQueue, enqueue, QUEUES, runBudgetAware } from "./queue.ts";

export async function registerEventJobs(boss: PgBoss) {
  await ensureQueue(QUEUES.group);
  // Serial on purpose: two reports of the same new fact must not both create it.
  await boss.work<{ articleId: string; signalOnly?: boolean; force?: boolean }>(QUEUES.group, { localConcurrency: 1, pollingIntervalSeconds: 0.5, includeMetadata: true }, async ([job]) => {
    if (!job) return;
    return runBudgetAware(job, async () => {
      try {
        // A discussion post comes here straight from collection: record it first (settleNonEditorial).
        if (job.data.signalOnly && !job.data.force && !(await settleNonEditorial(job.data.articleId)).group) return { verdict: "skipped" };
        const result = await groupArticle(job.data.articleId, { signalOnly: job.data.signalOnly, force: job.data.force });
        if (result.storyId && !result.verdict.startsWith("signal")) {
          await enqueue(QUEUES.digest, { storyId: result.storyId }, { singletonKey: `story:${result.storyId}`, startAfter: 60 });
        }
        return result;
      } catch (error) {
        if (error instanceof BudgetExceededError || error instanceof ReceiptBusyError) throw error;
        throw error;
      }
    });
  });
  await ensureQueue(QUEUES.digest);
  await boss.work<{ storyId: number; afterCorrection?: boolean }>(QUEUES.digest, { localConcurrency: 3, pollingIntervalSeconds: 5, includeMetadata: true }, async ([job]) => {
    if (!job) return;
    return runBudgetAware(job, () => composeStoryDigest(job.data.storyId, { afterCorrection: job.data.afterCorrection }));
  });
}
