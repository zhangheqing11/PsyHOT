// EveryInfra unified public-content API. The API key is read only on the backend and every
// billable request goes through the same receipt and budget guard as the other paid providers.
import { credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { paidRequest, ProviderRejectedError, type CallOutcome } from "./receipts.ts";

export interface EveryInfraEnvelope<T = unknown> {
  id?: string;
  results?: T;
  billing?: { charged_usd?: number; charged?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

function apiBase(): string {
  return (credential("collectors", "EVERYINFRA_BASE_URL") ?? "https://api.everyinfra.com").replace(/\/$/, "");
}

function apiKey(): string {
  const key = credential("collectors", "EVERYINFRA_API_KEY");
  if (!key) throw new Error("EVERYINFRA_API_KEY is not configured");
  return key;
}

function responseCost(json: EveryInfraEnvelope): CallOutcome["cost"] {
  const amount = json.billing?.charged_usd;
  return typeof amount === "number" ? { amount, currency: "USD", basis: "actual" } : null;
}

/** One EveryInfra capability call. Do not retry unknown outcomes: the provider may already have billed it. */
export async function everyInfraCall<T = unknown>(opts: {
  platform: string;
  action: string;
  params?: Record<string, unknown>;
  subject: string;
  purpose: string;
  window?: string;
  /** The budget share; the platform's by default. */
  pool?: string;
}): Promise<{ results: T; receiptId: number; reused: boolean; response: EveryInfraEnvelope<T> }> {
  const key = apiKey();
  const params = opts.params ?? {};
  const receipt = await paidRequest(
    {
      service: "everyinfra",
      purpose: opts.purpose,
      subject: opts.subject,
      identity: { platform: opts.platform, action: opts.action, params, window: opts.window ?? null },
      requestSummary: { platform: opts.platform, action: opts.action, params },
      // Each platform has its own share of the daily budget: one cannot use up another's.
      pool: opts.pool ?? `everyinfra:${opts.platform}`,
    },
    async () => {
      // The API never redirects; a redirect is refused before the key or the request goes anywhere else.
      const res = await guardedFetch(`${apiBase()}/api/v1/social`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ platform: opts.platform, action: opts.action, params }),
        timeoutMs: 60_000,
        maxBytes: 16 * 1024 * 1024,
        maxRedirects: 0,
        route: "direct",
      }).catch((error: unknown) => {
        if (error instanceof Error && error.message.startsWith("Too many redirects")) throw new ProviderRejectedError("everyinfra answered with a redirect", null, false);
        throw error;
      });
      const text = res.text();
      if (res.status === 401 || res.status === 402 || res.status === 422) {
        throw new ProviderRejectedError(`everyinfra HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, false);
      }
      if (res.status === 429 || res.status === 503 || res.status >= 500) {
        throw new ProviderRejectedError(`everyinfra HTTP ${res.status}`, res.status, true);
      }
      if (res.status < 200 || res.status >= 300) {
        throw new ProviderRejectedError(`everyinfra HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, false);
      }
      let json: EveryInfraEnvelope<T>;
      try {
        json = JSON.parse(text) as EveryInfraEnvelope<T>;
      } catch {
        throw new Error("everyinfra returned invalid JSON");
      }
      return { response: json, requestId: typeof json.id === "string" ? json.id : null, cost: responseCost(json) };
    },
  );
  const response = receipt.response as EveryInfraEnvelope<T>;
  return { results: response.results as T, receiptId: receipt.receiptId, reused: receipt.reused, response };
}

export interface EveryInfraMpPost {
  url: string;
  title: string;
  postedAt: Date | null;
  ghid: string | null;
}

/** An account's latest articles: link, title and time only (no digest); each body is a separate call. */
export async function everyInfraMpHistory(account: string, opts: { subject: string; window: string; pool?: string }) {
  const call = await everyInfraCall<unknown[]>({
    platform: "wechat_oa",
    action: "account_articles",
    params: { account, limit: 30 },
    subject: opts.subject,
    purpose: "mp_history",
    window: opts.window,
    pool: opts.pool,
  });
  const rows: unknown[] = Array.isArray(call.results) ? call.results : [];
  const posts = rows.flatMap((row): EveryInfraMpPost[] => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    if (typeof r.url !== "string" || typeof r.title !== "string" || !r.url || !r.title) return [];
    const posted = typeof r.posted_at === "string" || typeof r.posted_at === "number" ? Date.parse(String(r.posted_at)) : NaN;
    return [{ url: r.url, title: r.title, postedAt: Number.isFinite(posted) ? new Date(posted) : null,
      ghid: typeof r.account_ghid === "string" ? r.account_ghid : null }];
  });
  return { posts, receiptId: call.receiptId, reused: call.reused };
}

export async function everyInfraMpArticle(articleUrl: string, opts: { subject: string; identity: string }) {
  const call = await everyInfraCall<Record<string, unknown>>({
    platform: "wechat_oa",
    action: "article_detail",
    params: { url: articleUrl },
    subject: opts.subject,
    purpose: "mp_article",
    window: opts.identity,
  });
  const row = call.results && typeof call.results === "object" ? call.results : {};
  return {
    html: typeof row.content_html === "string" && row.content_html ? row.content_html : null,
    text: typeof row.content_text === "string" && row.content_text ? row.content_text : null,
    author: typeof row.author === "string" && row.author ? row.author : null,
    digest: typeof row.digest === "string" && row.digest ? row.digest : null,
    receiptId: call.receiptId,
  };
}

/** Operator-run account discovery and resolution have their own share: they never take collection's. */
export const DISCOVERY_POOL = "everyinfra:discovery";

/** Paid discovery only: results remain candidates until their identity/quality is reviewed. */
export async function discoverWechatAccounts(keyword: string, window: string) {
  if (!keyword.trim()) throw new Error("WeChat discovery keyword required");
  return everyInfraCall<unknown[]>({ platform: "wechat_oa", action: "account_search",
    params: { keyword: keyword.trim() }, subject: "wechat-discovery", purpose: "wechat_discovery", window, pool: DISCOVERY_POOL });
}

export async function everyInfraXhsNote(noteUrl: string, opts: { subject: string; identity: string }) {
  const call = await everyInfraCall<Record<string, unknown>>({
    platform: "xiaohongshu",
    action: "note",
    params: { url: noteUrl },
    subject: opts.subject,
    purpose: "xhs_note",
    window: opts.identity,
  });
  const row = call.results && typeof call.results === "object" ? call.results : {};
  return {
    title: typeof row.title === "string" ? row.title : null,
    text: typeof row.text === "string" ? row.text : null,
    author: typeof row.author_name === "string" ? row.author_name : null,
    postedAt: typeof row.posted_at === "string" ? row.posted_at : null,
    raw: row,
    receiptId: call.receiptId,
  };
}
