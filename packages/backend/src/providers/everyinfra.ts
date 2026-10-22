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
      // Each platform has its own share of the daily budget: one cannot use up another's.
      pool: `everyinfra:${opts.platform}`,
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

/** Paid discovery only: results remain candidates until their identity/quality is reviewed. */
export async function discoverWechatAccounts(keyword: string, window: string) {
  if (!keyword.trim()) throw new Error("WeChat discovery keyword required");
  return everyInfraCall<unknown[]>({ platform: "wechat_oa", action: "account_search",
    params: { keyword: keyword.trim() }, subject: "wechat-discovery", purpose: "wechat_discovery", window });
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
