// Unit prices (service_prices, loaded by scripts/apply-service-prices.ts from industry/service-prices.json)
// turned into estimated costs. An estimate is never a bill: receipts mark it cost_basis = 'estimated'.
// The table is tiny, so it is read whole and cached for a minute, like the model overrides.
import { sql } from "../db.ts";
import { isPeak } from "../lib/offpeak.ts";

export interface Price {
  currency: string;
  input_per_mtok: string | null;
  cached_per_mtok: string | null;
  output_per_mtok: string | null;
  per_request: string | null;
}

export interface UsageTotals {
  tokensIn: number;
  /** Part of tokensIn that hit the provider's prompt cache. */
  tokensCached: number;
  /** DeepSeek counts reasoning tokens inside completion_tokens, so they are already here. */
  tokensOut: number;
  requests: number;
}

/** Cache-hit input tokens from a provider `usage` object (DeepSeek, then the OpenAI-style detail). */
export function cachedTokens(usage: Record<string, unknown> | null | undefined): number {
  const details = usage?.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
  return Number(usage?.prompt_cache_hit_tokens ?? details?.cached_tokens ?? 0) || 0;
}

export function usageTotals(usage: Record<string, unknown> | null | undefined): UsageTotals {
  return { tokensIn: Number(usage?.prompt_tokens ?? 0) || 0, tokensCached: cachedTokens(usage), tokensOut: Number(usage?.completion_tokens ?? 0) || 0, requests: 1 };
}

/** Cost of the usage at a price row; null when the row prices nothing the usage could use. */
export function estimateCost(price: Price | null | undefined, u: UsageTotals): { amount: number; currency: string } | null {
  if (!price) return null;
  const input = price.input_per_mtok === null ? null : Number(price.input_per_mtok);
  const cachedPrice = price.cached_per_mtok === null ? null : Number(price.cached_per_mtok);
  const output = price.output_per_mtok === null ? null : Number(price.output_per_mtok);
  const perRequest = price.per_request === null ? null : Number(price.per_request);
  if (input === null && output === null && perRequest === null) return null;
  const cached = Math.min(Math.max(u.tokensCached, 0), u.tokensIn);
  // Without a cached price, cache hits are charged as ordinary input (an overestimate, never an underestimate).
  const amount =
    ((u.tokensIn - cached) / 1e6) * (input ?? 0) +
    (cached / 1e6) * (cachedPrice ?? input ?? 0) +
    (u.tokensOut / 1e6) * (output ?? 0) +
    u.requests * (perRequest ?? 0);
  return { amount, currency: price.currency };
}

let cache: { at: number; rows: Array<Price & { service: string; model: string }> } | null = null;

async function load() {
  if (cache && Date.now() - cache.at < 60_000) return cache.rows;
  const rows = await sql<Array<Price & { service: string; model: string }>>`
    SELECT service, model, currency, input_per_mtok, cached_per_mtok, output_per_mtok, per_request FROM service_prices`;
  cache = { at: Date.now(), rows };
  return rows;
}

export function invalidatePriceCache() {
  cache = null;
}

export function pickPrice<P extends { service: string; model: string }>(rows: P[], service: string | null, model: string | null): P | null {
  return rows.find((x) => x.service === service && x.model === model) ?? rows.find((x) => x.service === service && x.model === "") ?? null;
}

/**
 * Estimated cost of one call for a receipt. A provider with a cheaper off-peak tier lists it as a second row
 * named `<model>@offpeak` (the plain row is then the peak price); it is used when `at` is off-peak.
 * Never throws: a price lookup must not fail a paid call.
 */
export async function estimateCallCost(
  service: string,
  model: string | null,
  usage: Record<string, unknown> | null | undefined,
  at: Date = new Date(),
): Promise<{ amount: number; currency: string; basis: "estimated" } | null> {
  try {
    const rows = await load();
    const offPeak = model && !isPeak(at) ? rows.find((x) => x.service === service && x.model === `${model}@offpeak`) : undefined;
    const est = estimateCost(offPeak ?? pickPrice(rows, service, model), usageTotals(usage));
    return est ? { ...est, basis: "estimated" } : null;
  } catch {
    return null;
  }
}
