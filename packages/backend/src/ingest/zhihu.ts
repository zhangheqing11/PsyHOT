// MediaCrawler's anonymised Zhihu contents export → an external discussion item.
// Each creator is a source/participant, just like a Bluesky account; no scores or identity data enter here.
import * as cheerio from "cheerio";
import { normalizeUrl } from "../lib/url.ts";

export interface ZhihuSignal {
  sourceId: string;
  sourceName: string;
  contentText: string;
  item: {
    title: string; url: string; publishedAt: string; bodyText: string; excerpt: string; language: string;
    raw: { collector: string; platform: string; contentType: string; contentId: string; creatorHash: string; sourceUpdatedTime: number; links: string[] };
  };
}

function reference(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let url = URL.parse(input.trim());
  if (url?.hostname === "link.zhihu.com") url = URL.parse(url.searchParams.get("target") ?? "");
  return url && !url.username && !url.password && /^https?:$/.test(url.protocol) ? normalizeUrl(url.toString()) : null;
}

export function zhihuSignal(input: unknown): ZhihuSignal | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  const id = typeof r.content_id === "string" ? r.content_id : "";
  const creator = typeof r.creator_hash === "string" ? r.creator_hash.toLowerCase() : "";
  if (!/^\d+$/.test(id) || !/^[a-f0-9]{16}$/.test(creator) || !["answer", "article"].includes(String(r.content_type))) return null;
  const url = typeof r.content_url === "string" ? URL.parse(r.content_url) : null;
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const question = typeof r.question_id === "string" ? r.question_id : "";
  const valid = r.content_type === "answer"
    ? /^\d+$/.test(question) && /^(?:www\.)?zhihu\.com$/.test(url.hostname) && new RegExp(`^/question/${question}/answer/${id}/?$`).test(url.pathname)
    : url.hostname === "zhuanlan.zhihu.com" && new RegExp(`^/p/${id}/?$`).test(url.pathname);
  if (!valid) return null;
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  if (r.content_type === "answer") url.hostname = "www.zhihu.com";

  const seconds = typeof r.created_time === "number" ? r.created_time : Number.NaN;
  const published = new Date(seconds * 1000);
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(published.getTime())) return null;
  const original = typeof r.content_text === "string" && r.content_text.trim() ? r.content_text : typeof r.desc === "string" ? r.desc : "";
  if (!original.trim() || original.length > 200_000) return null;
  const $ = cheerio.load(original, null, false);
  $("script,style").remove();
  const hrefs = $("a[href]").toArray().map((a) => $(a).attr("href"));
  $("br").replaceWith("\n");
  $("p,div,li,h1,h2,h3,blockquote").after("\n");
  const text = $.root().text().replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return null;
  const links = [...new Set([...hrefs, ...(Array.isArray(r.content_links) ? r.content_links : []), ...(text.match(/https?:\/\/[^\s<>"'）)]+/g) ?? [])]
    .map(reference).filter((u): u is string => !!u))];
  const bodyText = [text, ...links.filter((link) => !text.includes(link))].join("\n\n");
  if (bodyText.length > 200_000) return null;
  const title = (typeof r.title === "string" ? cheerio.load(r.title, null, false).text().trim() : "") || text.split("\n")[0];
  return {
    sourceId: `mc-zhihu-${creator}`, sourceName: `知乎讨论 ${creator.slice(0, 8)}`, contentText: text,
    item: {
      title: title.slice(0, 300), url: url.toString(), publishedAt: published.toISOString(), bodyText,
      excerpt: text.replace(/\s+/g, " ").slice(0, 2000), language: "zh",
      raw: { collector: "mediacrawler", platform: "zhihu", contentType: String(r.content_type), contentId: id, creatorHash: creator, sourceUpdatedTime: typeof r.updated_time === "number" && Number.isFinite(r.updated_time) ? r.updated_time : 0, links },
    },
  };
}

/** Search exports append repeated snapshots: keep the newest version and the fullest copy of it.
 * Copies of the same version merge citation links; older-version links must not resurrect removed references.
 */
export function mergeZhihuSignals(a: ZhihuSignal, b: ZhihuSignal): ZhihuSignal {
  if (a.item.url !== b.item.url || a.sourceId !== b.sourceId) throw new Error("Conflicting Zhihu content identity");
  if (a.item.raw.sourceUpdatedTime !== b.item.raw.sourceUpdatedTime) return a.item.raw.sourceUpdatedTime > b.item.raw.sourceUpdatedTime ? a : b;
  const best = a.contentText.length !== b.contentText.length ? (a.contentText.length > b.contentText.length ? a : b)
    : (a.contentText.localeCompare(b.contentText) <= 0 ? a : b);
  const links = [...new Set([...a.item.raw.links, ...b.item.raw.links])].sort();
  const bodyText = [best.contentText, ...links.filter((link) => !best.contentText.includes(link))].join("\n\n");
  if (bodyText.length > 200_000) throw new Error("Merged Zhihu body exceeds the ingest limit");
  return { ...best, item: { ...best.item, bodyText, raw: { ...best.item.raw, links } } };
}
