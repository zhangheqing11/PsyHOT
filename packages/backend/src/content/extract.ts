// Article body extraction: readable text from the article page, or "unconfirmed" — never a wrong body.
// Jina Reader (else DeepSeek Fetch) is the budgeted fallback for pages that only render in a browser.
// Neither is asked for a page its site refused us: a robot check is never worked around.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { credential } from "../config.ts";
import { sql } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { deepseekFetch, deepseekToolsKey } from "../providers/deepseek-tools.ts";
import { jinaRead } from "../providers/jina.ts";
import { BudgetExceededError, ProviderRejectedError } from "../providers/receipts.ts";
import { getArticle } from "../providers/socialdata.ts";
import { onlyXArticleLink, xArticleText } from "../sources/x.ts";
import { sanitizeBody, trimTrailingChrome } from "./sanitize.ts";
import { contentHash } from "./materials.ts";
import { markdownBody } from "./markdown.ts";

export interface ExtractedBody {
  html: string;
  text: string;
  images: Array<{ kind: "image"; url: string; width: number | null; height: number | null }>;
  via: "readability" | "jina" | "deepseek";
}

const MIN_BODY_CHARS = 200;

export function readable(html: string, url: string): ExtractedBody | null {
  const { document } = parseHTML(html);
  // Markup after an early </html> (中国政府网's policy pages close it twice) is parsed beside <html>, and
  // Readability, looking for the BODY above its best candidate, fails on it. It belongs to the body.
  for (const node of [...document.childNodes]) {
    if (node.nodeType === 1 && node !== document.documentElement && document.body) document.body.appendChild(node);
  }
  try {
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head?.appendChild(base);
  } catch {
    // no head
  }
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: MIN_BODY_CHARS, keepClasses: false }).parse();
  if (!article?.content) return null;
  const clean = trimTrailingChrome(sanitizeBody(article.content, url));
  const text = stripTags(clean);
  if (text.length < MIN_BODY_CHARS) return null;
  const images: ExtractedBody["images"] = [];
  for (const m of clean.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)) {
    const w = /\bwidth="(\d+)"/.exec(m[0]);
    const h = /\bheight="(\d+)"/.exec(m[0]);
    images.push({ kind: "image", url: m[1]!.replace(/&amp;/g, "&"), width: w ? Number(w[1]) : null, height: h ? Number(h[1]) : null });
    if (images.length >= 12) break;
  }
  return { html: clean, text, images, via: "readability" };
}

// Statuses of a site that refused us (login, robot check, rate limit, legal block), and sites whose
// pages sit behind a robot check even when they answer 200 (ScienceDirect, 瑞数 on NHC and NMPA,
// Aliyun's acw_sc__v2 on 健康界).
const REFUSED = new Set([401, 403, 407, 412, 429, 451]);
const ROBOT_CHECKED = /(^|\.)(sciencedirect\.com|nhc\.gov\.cn|nmpa\.gov\.cn|cn-healthcare\.com)$/i;

/** Whether a fallback reader may be asked for this page: not when its site refused us or checks for robots. */
export function fallbackAllowed(url: string, status: number | null): boolean {
  if (status !== null && REFUSED.has(status)) return false;
  try {
    return !ROBOT_CHECKED.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export async function extractFromUrl(url: string, opts: { allowJina: boolean; subject: string }): Promise<ExtractedBody | null> {
  let status: number | null = null;
  try {
    const res = await guardedFetch(url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024 });
    status = res.status;
    const type = res.headers.get("content-type") ?? "";
    if (res.status === 200 && /html/.test(type)) {
      const got = readable(res.text(), res.url);
      if (got) return got;
    }
  } catch {
    // fall through to a reader
  }
  // Without a reader key there is no fallback: the article goes on with what its source gave.
  if (!opts.allowJina || !fallbackAllowed(url, status)) return null;
  try {
    if (credential("collectors", "JINA_API_KEY")) {
      const page = await jinaRead(url, { purpose: "body_fallback", subject: opts.subject });
      return markdownExtract(page.markdown, url, "jina");
    }
    if (process.env.DEEPSEEK_BODY_FALLBACK !== "false" && deepseekToolsKey()) {
      const page = await deepseekFetch(url, { purpose: "body_fallback", subject: opts.subject });
      return markdownExtract(page.markdown, url, "deepseek");
    }
    return null;
  } catch (error) {
    // A spent budget, or a page the reader could not get (DeepSeek's 404 is "no usable content").
    if (error instanceof BudgetExceededError || (error instanceof ProviderRejectedError && !error.retryable)) return null;
    throw error;
  }
}

function markdownExtract(markdown: string, url: string, via: ExtractedBody["via"]): ExtractedBody | null {
  const html = markdownBody(markdown, url);
  const text = stripTags(html);
  return text.length < MIN_BODY_CHARS ? null : { html, text, images: [], via };
}

/** Pages extraction can fetch: ordinary web pages (X posts and WeChat articles arrive whole or not at all). */
export function pageFetchable(url: string, sourceKind: string): boolean {
  if (sourceKind === "x_search" || sourceKind === "mp_account") return false;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && !/(^|\.)(x\.com|twitter\.com|mp\.weixin\.qq\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Fetches and stores the body of one article. Unconfirmed bodies are recorded as such. */
export async function extractArticleBody(articleId: string, allowJina = process.env.JINA_BODY_FALLBACK !== "false"): Promise<"ok" | "unconfirmed" | "skipped"> {
  const [a] = await sql<{ id: string; url: string; body_status: string; revision: number; x_post: { tweetId?: string } | null }[]>`
    SELECT id, url, body_status, revision, x_post FROM articles WHERE id = ${articleId} AND duplicate_of IS NULL`;
  if (!a || a.body_status === "ok") return "skipped";
  if (a.x_post?.tweetId) return extractXArticle(a.id, a.x_post.tweetId);
  const got = await extractFromUrl(a.url, { allowJina, subject: `article:${a.id}` });
  if (!got) {
    await sql`UPDATE articles SET body_status = 'unconfirmed', updated_at = now() WHERE id = ${articleId} AND body_status <> 'ok'`;
    return "unconfirmed";
  }
  // The body is new content: a new revision, so an analysis of the body-less input counts as stale.
  await sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null }[]>`SELECT title, excerpt FROM articles WHERE id = ${articleId} AND duplicate_of IS NULL FOR UPDATE`;
    if (!row) return;
    const hash = contentHash({ title: row.title, bodyText: got.text, excerpt: row.excerpt });
    const [r] = await tx<{ revision: number }[]>`
      UPDATE articles SET body_html = ${got.html}, body_text = ${got.text}, body_status = 'ok',
        media = CASE WHEN jsonb_array_length(media) = 0 THEN ${tx.json(got.images as never)}::jsonb ELSE media END,
        revision = revision + 1, content_hash = ${hash}, processing_state = 'new', updated_at = now()
      WHERE id = ${articleId} RETURNING revision`;
    await tx`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
             VALUES (${articleId}, ${r!.revision}, ${hash}, ${row.title}, ${got.text})`;
  });
  return "ok";
}

/**
 * The X Article a post published (SocialData, paid, by the post's own id). The article joins the
 * post's body as a new revision; a post that is only the article's link takes the article's title.
 * No article (the link points at someone else's, or X has none) leaves the post "unconfirmed", and
 * the judging steps are told the article was not fetched.
 */
async function extractXArticle(articleId: string, tweetId: string): Promise<"ok" | "unconfirmed"> {
  const found = await getArticle(tweetId, { purpose: "x_article", subject: `article:${articleId}` });
  const got = found ? xArticleText(found) : null;
  if (!got) {
    await sql`UPDATE articles SET body_status = 'unconfirmed', updated_at = now() WHERE id = ${articleId} AND body_status <> 'ok'`;
    return "unconfirmed";
  }
  await sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null; body_text: string | null; x_post: { text?: string } | null }[]>`
      SELECT title, excerpt, body_text, x_post FROM articles WHERE id = ${articleId} FOR UPDATE`;
    if (!row) return;
    const title = got.title && onlyXArticleLink(row.x_post?.text) ? got.title : row.title;
    const bodyText = [row.body_text ?? "", got.title ? `# ${got.title}` : "", got.text].filter(Boolean).join("\n\n");
    const hash = contentHash({ title, bodyText, excerpt: row.excerpt });
    const [r] = await tx<{ revision: number }[]>`
      UPDATE articles SET title = ${title}, body_text = ${bodyText}, x_article = ${tx.json(got as never)}, body_status = 'ok',
        revision = revision + 1, content_hash = ${hash}, processing_state = 'new', updated_at = now()
      WHERE id = ${articleId} RETURNING revision`;
    await tx`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
             VALUES (${articleId}, ${r!.revision}, ${hash}, ${title}, ${bodyText})`;
  });
  return "ok";
}

export { collapseWhitespace };
