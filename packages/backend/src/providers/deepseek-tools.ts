// DeepSeek Search and Fetch (api.deepseek.com/v1/tools/*): web search results and a page as Markdown.
// Paid per successful request ($0.75 per 1000 each; an empty result, a 404 or a timeout is not
// billed), always behind receipts and the deepseek-tools budget, with one pool per endpoint.
import { credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { paidRequest, ProviderRejectedError } from "./receipts.ts";

const PRICE_USD = 0.75 / 1000;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  summary: string;
  siteName: string | null;
  date: Date | null;
  rerankScore: number | null;
  authority: number | null;
}

function apiBase(): string {
  return (credential("models", "DEEPSEEK_TOOLS_BASE_URL") ?? "https://api.deepseek.com").replace(/\/$/, "");
}

/** The DeepSeek key: its own, else the default model's when that model is DeepSeek. */
export function deepseekToolsKey(): string | null {
  const own = credential("models", "DEEPSEEK_API_KEY");
  if (own) return own;
  const base = credential("models", "LLM_BASE_URL") ?? "";
  return /(^|\/\/)api\.deepseek\.com(\/|$)/.test(base) ? credential("models", "LLM_API_KEY") : null;
}

async function toolCall(endpoint: "search" | "fetch", body: Record<string, unknown>, opts: { purpose: string; subject: string; window?: string; pool?: string }): Promise<{ response: unknown; receiptId: number; reused: boolean }> {
  const key = deepseekToolsKey();
  if (!key) throw new Error("DEEPSEEK_API_KEY is not configured");
  const receipt = await paidRequest(
    {
      service: "deepseek-tools",
      purpose: opts.purpose,
      subject: opts.subject,
      identity: { endpoint, body, window: opts.window ?? null },
      requestSummary: { endpoint, ...body },
      pool: opts.pool ?? `deepseek-tools:${endpoint}`,
    },
    async () => {
      const res = await guardedFetch(`${apiBase()}/v1/tools/${endpoint}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 60_000,
        maxBytes: 8 * 1024 * 1024,
        maxRedirects: 0,
        route: "direct",
      });
      const text = res.text();
      // 408, 429 and 5xx are worth another try later; any other refusal (a 404 is "no usable page") is final.
      if (res.status === 408 || res.status === 429 || res.status >= 500) throw new ProviderRejectedError(`deepseek-tools HTTP ${res.status}`, res.status, true);
      if (res.status !== 200) throw new ProviderRejectedError(`deepseek-tools HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, false);
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error("deepseek-tools returned invalid JSON");
      }
      const billed = endpoint === "search" ? Array.isArray(json.results) && json.results.length > 0 : typeof json.content === "string" && json.content.trim() !== "";
      return { response: json, requestId: res.headers.get("x-request-id"), cost: { amount: billed ? PRICE_USD : 0, currency: "USD", basis: "estimated" } };
    },
  );
  return receipt;
}

function parseResult(row: unknown): WebSearchResult | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (typeof r.url !== "string" || !/^https?:\/\//i.test(r.url) || typeof r.title !== "string" || !r.title.trim()) return null;
  const date = typeof r.date === "string" ? Date.parse(r.date) : NaN;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    title: r.title.trim(),
    url: r.url,
    snippet: typeof r.snippet === "string" ? r.snippet : "",
    summary: typeof r.summary === "string" ? r.summary : "",
    siteName: typeof r.site_name === "string" && r.site_name.trim() ? r.site_name.trim() : null,
    date: Number.isFinite(date) ? new Date(date) : null,
    rerankScore: num(r.rerank_score),
    authority: num(r.authority),
  };
}

/** One web search (the search share unless `pool` names another); `window` makes a repeat within the same window reuse the receipt instead of paying again. */
export async function deepseekSearch(query: string, opts: { purpose: string; subject: string; count?: number; window?: string; pool?: string }): Promise<{ results: WebSearchResult[]; receiptId: number; reused: boolean }> {
  const body = { query: query.slice(0, 128), count: opts.count ?? 10 };
  const call = await toolCall("search", body, opts);
  const rows = (call.response as { results?: unknown })?.results;
  const results = Array.isArray(rows) ? rows.flatMap((r) => parseResult(r) ?? []) : [];
  return { results, receiptId: call.receiptId, reused: call.reused };
}

/** One page as Markdown; a same-day repeat of the same URL reuses the receipt. */
export async function deepseekFetch(url: string, opts: { purpose: string; subject: string }): Promise<{ title: string | null; markdown: string; receiptId: number }> {
  const call = await toolCall("fetch", { url }, { ...opts, window: new Date().toISOString().slice(0, 10) });
  const r = (call.response ?? {}) as { title?: unknown; content?: unknown };
  return { title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : null, markdown: typeof r.content === "string" ? r.content : "", receiptId: call.receiptId };
}
