// Cached feeds from an operator-owned WeRSS instance. No paid fallback and no access to its cookies.
import { fetch } from "undici";
import { credential } from "../config.ts";
import { parseRss } from "../sources/rss.ts";
import { FetchError, type SourceRow } from "../sources/types.ts";

export async function readWeRss(source: SourceRow) {
  const base = credential("collectors", "WECHAT_RSS_BASE_URL");
  if (!base) throw new FetchError("WECHAT_RSS_BASE_URL is not configured; fixed accounts use WeRSS only");
  const root = new URL(base);
  if (!["http:", "https:"].includes(root.protocol) || root.username || root.password || root.search || root.hash) {
    throw new FetchError("Invalid operator-owned WeRSS base URL");
  }
  const feedId = String(source.config.werssFeedId ?? "");
  const biz = String(source.config.wechatBiz ?? "");
  if (!/^MP_WXS_\d+$/.test(feedId) || !/^[A-Za-z0-9+/]+={0,2}$/.test(biz) ||
      feedId !== `MP_WXS_${Buffer.from(biz, "base64").toString()}`) {
    throw new FetchError("WeRSS feed/publisher mapping is missing or inconsistent");
  }
  // The URL comes only from backend operator configuration; source config supplies a numeric ID.
  // Refuse redirects so this private-service exception cannot become an arbitrary HTTP fetch.
  const url = `${base.replace(/\/+$/, "")}/feed/${feedId}.xml`;
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(25_000),
    headers: { accept: "application/rss+xml, application/xml" } });
  if (res.status !== 200) { await res.body?.cancel(); throw new FetchError(`WeRSS HTTP ${res.status}`, res.status); }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const part of res.body ?? []) {
    bytes += part.byteLength;
    if (bytes > 3_000_000) throw new FetchError("WeRSS feed exceeds 3 MB");
    chunks.push(part);
  }
  const rows = parseRss(Buffer.concat(chunks).toString("utf8"), source, url);
  if (!rows.length) throw new FetchError("WeRSS feed is empty; check WeRSS authorization and collection task");
  const candidates = rows.filter((r) => {
    const link = new URL(r.url);
    return link.origin === "https://mp.weixin.qq.com" && !link.username && !link.password &&
      link.pathname === "/s" && link.searchParams.get("__biz") === biz &&
      !!link.searchParams.get("mid") && !!link.searchParams.get("idx") &&
      r.publishedAt && Number.isFinite(r.publishedAt.getTime()) && r.publishedAt.getTime() <= Date.now() + 3600_000 &&
      !/当前环境异常|完成验证后即可继续访问|该内容已被发布者删除/.test(r.bodyText ?? r.excerpt ?? "");
  });
  if (!candidates.length) throw new FetchError("WeRSS returned no verifiable articles for this publisher");
  return candidates.map((r) => ({ ...r, author: r.author ?? source.name,
    // Missing full text may be filled by a later WeRSS refresh, never a paid detail request.
    bodyStatus: r.bodyText ? "ok" as const : "none" as const,
    raw: { ...r.raw as object, collector: "werss", feedId, fakeid: biz } }));
}
