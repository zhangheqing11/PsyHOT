// Operator-run experiment only: no material writes, grouping, model calls or scheduler registration.
import { BudgetExceededError } from "../providers/receipts.ts";
import { everyInfraXCandidate } from "../sources/everyinfra-x.ts";
import { probeQueries, matchingXPost, matchingXPosts, xPostEngagement, type StoryQuery, type StoryReport } from "./x-story-query.ts";

export interface ProbeStory { storyId: number; title: string; reports: StoryReport[] }
export interface ProbeCall { results: unknown; receiptId: number; reused: boolean; costUsd: number | null }
export interface ProbeResult {
  storyId: number;
  title: string;
  query: StoryQuery;
  receiptId: number;
  reused: boolean;
  receiptCostUsd: number | null;
  newCostUsd: number | null;
  received: number;
  matched: number;
  selected: number;
  samples: Array<{ url: string; text: string; ruleMatch: boolean; selected: boolean; engagement: number; review: null }>;
}

export async function runXProbe(stories: ProbeStory[], at: Date,
  request: (story: ProbeStory, query: StoryQuery) => Promise<ProbeCall>,
  record: (result: ProbeResult) => Promise<void>): Promise<{ completed: number; stopped: "budget" | null }> {
  if (!Number.isFinite(at.getTime()) || stories.length > 10 || new Set(stories.map((s) => s.storyId)).size !== stories.length ||
      stories.some((s) => !Number.isSafeInteger(s.storyId) || s.storyId < 1)) throw new Error("Probe needs at most 10 unique positive story ids and a valid date");
  let completed = 0;
  for (const story of stories) for (const query of probeQueries(story.reports, at)) {
    let call: ProbeCall;
    try { call = await request(story, query); }
    catch (error) {
      if (error instanceof BudgetExceededError) return { completed, stopped: "budget" };
      throw error; // In particular, never retry unknown outcomes.
    }
    if (!Array.isArray(call.results)) throw new Error(`Receipt ${call.receiptId}: X results is not an array`);
    const unique = new Map<string, { post: NonNullable<ReturnType<typeof everyInfraXCandidate>>; ruleMatch: boolean }>();
    for (const row of call.results) {
      const post = everyInfraXCandidate(row);
      if (!post) continue;
      const ruleMatch = !!matchingXPost(row, query, at);
      const previous = unique.get(post.identityKey!);
      if (!previous || (ruleMatch && !previous.ruleMatch) || (ruleMatch === previous.ruleMatch && xPostEngagement(post) > xPostEngagement(previous.post))) {
        unique.set(post.identityKey!, { post, ruleMatch });
      }
    }
    const selected = new Set(matchingXPosts(call.results, query, at).map((p) => p.identityKey));
    const samples = [...unique.values()].map(({ post, ruleMatch }) => ({ url: post.url, text: post.bodyText!,
      ruleMatch, selected: selected.has(post.identityKey), engagement: xPostEngagement(post), review: null }));
    await record({ storyId: story.storyId, title: story.title, query, receiptId: call.receiptId, reused: call.reused,
      receiptCostUsd: call.costUsd, newCostUsd: call.reused ? 0 : call.costUsd, received: call.results.length,
      matched: samples.filter((s) => s.ruleMatch).length, selected: selected.size, samples });
    completed++;
  }
  return { completed, stopped: null };
}
