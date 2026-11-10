// Admin "模型与评测": the model each capability uses and where that choice comes from,
// the prompt versions in use, quality / latency / cost of the last days per model, the switch history
// and the SelectBench runs that compare models on the same batch. A switch is audited and applies to
// new work only.
import { sql } from "../db.ts";
import { CAPABILITIES, invalidateModelCache, modelSources, type Capability, type CapabilityKey } from "../editorial/models.ts";
import { MODELS } from "../providers/llm.ts";
import { estimateCost, pickPrice } from "../providers/prices.ts";
import { audit } from "./auth.ts";

interface UsageRow {
  purpose: string;
  model: string | null;
  service: string | null;
  prompt_version: string | null;
  calls: number;
  ok: number;
  failed: number;
  unknown: number;
  p50: number | null;
  p95: number | null;
  tokens_in: string | null;
  tokens_cached: string | null;
  tokens_out: string | null;
  actual_cost: string | null;
  estimated_cost: string | null;
  unpriced_calls: number;
  tokens_in_unpriced: string | null;
  tokens_cached_unpriced: string | null;
  tokens_out_unpriced: string | null;
  currency: string | null;
}

export async function modelsOverview(days = 7) {
  const since = new Date(Date.now() - days * 86400_000);
  const [sources, usage, prices, history, benches] = await Promise.all([
    modelSources(),
    sql<UsageRow[]>`
      SELECT r.purpose, a.model, a.service, r.request->>'promptVersion' AS prompt_version, count(*)::int AS calls,
             count(*) FILTER (WHERE a.status = 'received')::int AS ok,
             count(*) FILTER (WHERE a.status = 'failed')::int AS failed,
             count(*) FILTER (WHERE a.status = 'unknown')::int AS unknown,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY a.latency_ms) AS p50,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY a.latency_ms) AS p95,
             sum((a.usage->>'prompt_tokens')::bigint) AS tokens_in,
             sum(coalesce(a.usage->>'prompt_cache_hit_tokens', a.usage->'prompt_tokens_details'->>'cached_tokens')::bigint) AS tokens_cached, sum((a.usage->>'completion_tokens')::bigint) AS tokens_out,
             sum(a.cost) FILTER (WHERE a.cost_basis = 'actual') AS actual_cost,
             sum(a.cost) FILTER (WHERE a.cost_basis = 'estimated') AS estimated_cost,
             count(*) FILTER (WHERE a.status = 'received' AND a.cost IS NULL)::int AS unpriced_calls,
             sum((a.usage->>'prompt_tokens')::bigint) FILTER (WHERE a.cost IS NULL) AS tokens_in_unpriced,
             sum(coalesce(a.usage->>'prompt_cache_hit_tokens', a.usage->'prompt_tokens_details'->>'cached_tokens')::bigint) FILTER (WHERE a.cost IS NULL) AS tokens_cached_unpriced,
             sum((a.usage->>'completion_tokens')::bigint) FILTER (WHERE a.cost IS NULL) AS tokens_out_unpriced, max(a.currency) AS currency
      FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
      WHERE a.started_at >= ${since} AND a.origin = 'live' AND a.model IS NOT NULL
      GROUP BY 1, 2, 3, 4 ORDER BY 1, 5 DESC`,
    sql<{ service: string; model: string; currency: string; input_per_mtok: string | null; cached_per_mtok: string | null; output_per_mtok: string | null; per_request: string | null }[]>`
      SELECT service, model, currency, input_per_mtok, cached_per_mtok, output_per_mtok, per_request FROM service_prices`,
    sql<{ at: Date; actor: string; subject: string; reason: string | null; before: unknown; after: unknown }[]>`
      SELECT created_at AS at, actor, subject, reason, before, after FROM audit_log WHERE action = 'models.switch' ORDER BY created_at DESC LIMIT 30`,
    sql<{ id: string; label: string; sample_size: number; prompt_version: string | null; models: string[]; summary: unknown; created_at: Date }[]>`
      SELECT id, label, sample_size, prompt_version, models,
             (SELECT coalesce(jsonb_object_agg(key, value - 'sweep'), '{}'::jsonb) FROM jsonb_each(r.summary)) AS summary,
             created_at FROM selectbench_runs r ORDER BY created_at DESC LIMIT 8`,
  ]);
  // Stored estimates (priced at the time of each call) plus, for attempts without one (older ones), tokens
  // at the base row, which is the peak price: an upper bound. The receipt's own service names the row (a
  // deployment's default model is service "llm", not the vendor's name).
  const priced = (u: UsageRow) => {
    const stored = u.estimated_cost === null ? null : Number(u.estimated_cost);
    const base = u.unpriced_calls
      ? estimateCost(pickPrice(prices, u.service, u.model), { tokensIn: Number(u.tokens_in_unpriced ?? 0), tokensCached: Number(u.tokens_cached_unpriced ?? 0), tokensOut: Number(u.tokens_out_unpriced ?? 0), requests: u.unpriced_calls })
      : null;
    if (stored === null && !base) return null;
    const currency = base?.currency ?? u.currency ?? "CNY";
    return { amount: (stored ?? 0) + (base?.amount ?? 0), currency };
  };
  const capabilities = (Object.entries(CAPABILITIES) as Array<[CapabilityKey, Capability]>).map(([key, c]) => ({
    key,
    label: c.label,
    env: c.env,
    defaultModel: c.default,
    vision: !!c.vision,
    current: sources[key]!,
    usage: usage
      .filter((u) => c.purposes.includes(u.purpose))
      .map((u) => ({
        purpose: u.purpose,
        model: u.model,
        promptVersion: u.prompt_version,
        calls: u.calls,
        ok: u.ok,
        failed: u.failed,
        unknown: u.unknown,
        p50: u.p50,
        p95: u.p95,
        tokensIn: Number(u.tokens_in ?? 0),
        tokensOut: Number(u.tokens_out ?? 0),
        actualCost: u.actual_cost === null ? null : Number(u.actual_cost),
        currency: u.currency,
        estimate: priced(u),
      })),
  }));
  const choices = Object.values(MODELS).map((m) => ({ key: m.key, service: m.service, vision: !!m.vision }));
  return { days, capabilities, choices, history, benches };
}

/** Switches a capability to another registered model (or back to the environment/default when null). */
export async function switchModel(capability: string, model: string | null, reason: string, actor: string) {
  const c = (CAPABILITIES as Record<string, Capability>)[capability];
  if (!c) throw Object.assign(new Error("unknown capability"), { statusCode: 400 });
  if (!reason.trim()) throw Object.assign(new Error("a reason is required"), { statusCode: 400 });
  if (model !== null) {
    const spec = MODELS[model];
    if (!spec) throw Object.assign(new Error("unknown model"), { statusCode: 400 });
    if (!!c.vision !== !!spec.vision) throw Object.assign(new Error(c.vision ? "this capability needs a vision model" : "a vision-only model cannot do this"), { statusCode: 400 });
  }
  const before = (await modelSources())[capability];
  if (model === null) await sql`DELETE FROM settings WHERE key = ${`models.${capability}`}`;
  else {
    await sql`INSERT INTO settings (key, value, updated_by) VALUES (${`models.${capability}`}, ${sql.json({ model })}, ${actor})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  }
  invalidateModelCache();
  const after = (await modelSources())[capability];
  await audit(actor, "models.switch", `capability:${capability}`, reason, before ?? null, after ?? null);
  return { capability, before, after };
}
