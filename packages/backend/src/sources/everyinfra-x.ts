import type { Candidate } from "./types.ts";

/** Top-ranked discovery results have no exhaustive Latest watermark. Share X post identities. */
export function everyInfraXCandidate(value: unknown): Candidate | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const text = typeof row.text === "string" ? row.text.trim() : "";
  const id = typeof row.id === "string" ? row.id : "";
  if (!text || !/^\d+$/.test(id)) return null; // numeric ids lose precision; never guess an identity
  let url: URL;
  try { url = new URL(String(row.url)); } catch { return null; }
  const match = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/.exec(url.pathname);
  if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) ||
      url.protocol !== "https:" || url.username || url.password || !match || match[2] !== id) return null;
  const handle = match[1]!;
  const count = (key: string) => typeof row[key] === "number" && Number.isFinite(row[key]) && row[key] >= 0 ? row[key] as number : null;
  const at = typeof row.posted_at === "string" ? Date.parse(row.posted_at) : NaN;
  return {
    url: `https://x.com/${handle}/status/${id}`, identityKey: `x:${id}`,
    title: text.split("\n").find((line) => line.trim())!.slice(0, 140),
    bodyText: text, bodyStatus: "ok", author: handle,
    publishedAt: Number.isFinite(at) ? new Date(at) : null,
    xPost: { tweetId: id, handle, authorName: typeof row.author_name === "string" ? row.author_name : handle,
      avatarUrl: null, text, lang: null, replyTo: null, media: [], quoted: null },
    raw: { collector: "everyinfra", favorite: count("like_count"), retweet: count("retweet_count"),
      views: count("view_count"), like_count: count("like_count"), share_count: count("retweet_count"), comment_count: count("reply_count") },
  };
}
