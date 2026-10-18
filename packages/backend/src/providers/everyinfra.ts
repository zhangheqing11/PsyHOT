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
    },
    async () => {
      const res = await guardedFetch(`${apiBase()}/api/v1/social`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ platform: opts.platform, action: opts.action, params }),
        timeoutMs: 60_000,
        maxBytes: 16 * 1024 * 1024,
        route: "direct",
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
  position: number;
  url: string;
  title: string;
  post_time: number;
  digest?: string;
  sn?: string;
  cover_url?: string;
  original?: number;
  item_show_type?: number;
}

export async function everyInfraMpHistory(account: string, opts: { subject: string; window: string }) {
  // No fallback when the account listing is unavailable (EveryInfra answers 503 for some accounts at
  // times; failed calls are not billed): an article search by the account's name returns other accounts'
  // articles too, and their bodies were paid for and thrown away on every retry. The check is retried.
  const call = await everyInfraCall<unknown[]>({
    platform: "wechat_oa",
    action: "account_articles",
    params: { account, limit: 160 },
    subject: opts.subject,
    purpose: "mp_history",
    window: opts.window,
  });
  const rows: unknown[] = Array.isArray(call.results) ? call.results : [];
  const posts = rows.flatMap((row, i) => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const url = typeof r.url === "string" ? r.url : "";
    const title = typeof r.title === "string" ? r.title : "";
    if (!url || !title) return [];
    const posted = typeof r.posted_at === "string" || typeof r.posted_at === "number" ? Date.parse(String(r.posted_at)) : NaN;
    return [{
      position: Number(r.position ?? i + 1), url, title,
      post_time: Number.isFinite(posted) ? Math.floor(posted / 1000) : 0,
      digest: typeof r.digest === "string" ? r.digest : typeof r.summary === "string" ? r.summary : undefined,
      sn: typeof r.id === "string" ? r.id : undefined,
      cover_url: typeof r.cover_image_url === "string" ? r.cover_image_url : undefined,
      original: r.is_original === true ? 1 : r.is_original === false ? 0 : undefined,
      item_show_type: undefined,
    } satisfies EveryInfraMpPost];
  });
  return { posts, nickname: null, remainMoney: null, receiptId: call.receiptId, reused: call.reused };
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
  const content = typeof row.content_html === "string" && row.content_html ? row.content_html : String(row.content_text ?? "");
  return {
    title: String(row.title ?? ""), content,
    author: typeof row.author === "string" ? row.author : null,
    desc: typeof row.digest === "string" ? row.digest : null,
    pubtime: typeof row.posted_at === "string" ? row.posted_at : null,
    receiptId: call.receiptId,
  };
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
