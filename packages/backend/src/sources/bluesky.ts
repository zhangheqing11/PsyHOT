// Bluesky accounts through the public AppView (app.bsky.feed.getAuthorFeed; no key): a json_list source
// with adapter "bluesky_feed". Each post is an item at its bsky.app address, a repost included (the
// account passing a post on is attention too). The links a post carries (its link card, links in the
// text, a quoted post's text and card) go into the body, so a discussion post sharing a paper we hold
// joins that paper's story (events/group.ts linkedReports).
import { collapseWhitespace } from "../lib/text.ts";
import type { Candidate } from "./types.ts";

interface Facet {
  features?: Array<{ $type?: string; uri?: string }>;
}
interface External {
  uri?: string;
  title?: string;
  description?: string;
}
/** The embed views a post can carry (app.bsky.embed.*#view); only text and links are read. */
interface EmbedView {
  $type?: string;
  external?: External;
  record?: QuotedView & { record?: QuotedView };
  media?: EmbedView;
}
interface QuotedView {
  $type?: string;
  uri?: string;
  author?: { handle?: string };
  value?: { text?: string; facets?: Facet[] };
  embeds?: EmbedView[];
}
interface Post {
  uri: string;
  author: { did: string; handle: string };
  record: { text?: string; createdAt?: string; langs?: string[]; facets?: Facet[] };
  embed?: EmbedView;
  likeCount?: number;
  repostCount?: number;
  quoteCount?: number;
}
export interface FeedItem {
  post: Post;
  reason?: { $type?: string; by?: { handle?: string }; indexedAt?: string };
}

/** bsky.app address of a post: at://did/app.bsky.feed.post/<rkey> → /profile/<handle>/post/<rkey>. */
export function postUrl(post: Pick<Post, "uri" | "author">): string | null {
  const rkey = /\/app\.bsky\.feed\.post\/([^/]+)$/.exec(post.uri)?.[1];
  return rkey ? `https://bsky.app/profile/${post.author.handle}/post/${rkey}` : null;
}

const facetLinks = (facets: Facet[] | undefined) =>
  (facets ?? []).flatMap((f) => (f.features ?? []).filter((x) => x.$type === "app.bsky.richtext.facet#link" && x.uri).map((x) => x.uri!));

/** The link card of an embed, and the quoted post (alone, or with media). */
function parts(embed: EmbedView | undefined): { card: External | null; quoted: QuotedView | null } {
  if (!embed) return { card: null, quoted: null };
  const card = embed.external?.uri ? embed.external : embed.media?.external?.uri ? embed.media.external : null;
  const rec = embed.record?.record?.value ? embed.record.record : embed.record?.value ? embed.record : null;
  return { card, quoted: rec ?? null };
}

export function blueskyCandidate(item: FeedItem): Candidate | null {
  const p = item.post;
  const url = p?.uri && p.author ? postUrl(p) : null;
  if (!url) return null;
  const text = (p.record?.text ?? "").trim();
  const { card, quoted } = parts(p.embed);
  const quotedCard = parts(quoted?.embeds?.[0]).card;
  const links = [...new Set([card?.uri, ...facetLinks(p.record?.facets), ...facetLinks(quoted?.value?.facets), quotedCard?.uri].filter((u): u is string => !!u))];
  const firstLine = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  const title = firstLine || card?.title?.trim() || quoted?.value?.text?.split("\n")[0]?.trim() || "";
  if (!title) return null; // images or video alone: nothing to match
  const body = [
    text,
    quoted?.value?.text ? `【引用 @${quoted.author?.handle ?? ""}】${quoted.value.text}` : "",
    ...[card, quotedCard].filter((c): c is External => !!c?.uri).map((c) => [c.title, c.description, c.uri].filter(Boolean).join("\n")),
    ...links.filter((u) => u !== card?.uri && u !== quotedCard?.uri),
  ].filter(Boolean).join("\n\n");
  const repost = /reasonRepost$/.test(item.reason?.$type ?? "");
  const when = (repost && item.reason?.indexedAt) || p.record?.createdAt;
  return {
    url,
    title: collapseWhitespace(title).slice(0, 300),
    author: p.author.handle,
    language: p.record?.langs?.[0] ?? null,
    publishedAt: when ? new Date(when) : null,
    excerpt: collapseWhitespace(text || card?.title || "").slice(0, 2000) || null,
    bodyText: body,
    bodyStatus: "ok",
    raw: {
      externalId: p.uri,
      links,
      likes: p.likeCount ?? null,
      reposts: p.repostCount ?? null,
      quotes: p.quoteCount ?? null,
      ...(repost ? { repostedBy: item.reason?.by?.handle ?? null } : {}),
    },
  };
}
