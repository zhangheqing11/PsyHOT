// TypeSafe System One, through the same receipts, balance pause and budgets as other paid models.
import { setTimeout as delay } from "node:timers/promises";
import { config, credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { ModelOutputError } from "./llm.ts";
import { typesafeCost } from "./prices.ts";
import { paidRequest, ProviderRejectedError, rejectReceivedResponse } from "./receipts.ts";

export type TypeSafeQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string };
export interface TypeSafeAnswer {
  probabilities?: Record<string, number>;
  choice?: string;
  confidence?: number;
  noul?: number;
}
export function typesafeModel(): string {
  const model = process.env.TYPESAFE_MODEL || "jev-1.14.0";
  if (!/^jev-\d+\.\d+\.\d+$/.test(model)) throw new Error("TYPESAFE_MODEL must be a pinned Jev version, e.g. jev-1.14.0");
  return model;
}

function parseAnswers(raw: unknown, questions: Record<string, TypeSafeQuestion>): Record<string, TypeSafeAnswer> {
  if (!raw || typeof raw !== "object") throw new Error("missing answers");
  const answers = raw as Record<string, TypeSafeAnswer>;
  for (const [name, q] of Object.entries(questions)) {
    const a = answers[name];
    if (!a || typeof a !== "object") throw new Error(`missing answer ${name}`);
    if (q.type === "noul") {
      if (typeof a.noul !== "number" || !Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1) throw new Error(`invalid noul ${name}`);
      continue;
    }
    const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    const p = a.probabilities;
    if (!p || Object.keys(p).length !== keys.length || keys.some((k) => typeof p[k] !== "number" || !Number.isFinite(p[k]) || p[k]! < 0 || p[k]! > 1)
      || Math.abs(keys.reduce((sum, k) => sum + p[k]!, 0) - 1) > 0.02) throw new Error(`invalid probabilities ${name}`);
    if (q.type === "choice" && (!a.choice || !keys.includes(a.choice))) throw new Error(`invalid choice ${name}`);
  }
  return answers;
}

export async function systemOne(opts: {
  state: Record<string, unknown>; questions: Record<string, TypeSafeQuestion>;
  subject: string; promptVersion: string; attemptTag?: string; timeoutMs?: number;
}) {
  if (!config.modelCallsEnabled) throw new Error("Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  const key = credential("models", "TYPESAFE_API_KEY");
  if (!key) throw new Error("TYPESAFE_API_KEY is not configured");
  const model = typesafeModel();
  const base = (credential("models", "TYPESAFE_BASE_URL") ?? "https://api.typesafe.ai").replace(/\/$/, "");
  const body = { model, state: opts.state, questions: opts.questions };
  const request = {
    service: "typesafe", model, purpose: "score_roles", subject: opts.subject,
    identity: { ...body, subject: opts.subject, promptVersion: opts.promptVersion },
    requestSummary: { promptVersion: opts.promptVersion, stateHash: sha256(stableJson(opts.state)), questionsHash: sha256(stableJson(opts.questions)) },
    attemptTag: opts.attemptTag,
  };
  // Three attempts total. Each retry reclaims the failed receipt and counts against the budget.
  for (let attempt = 0; ; attempt++) {
    let receipt;
    try {
      receipt = await paidRequest(request, async () => {
        const res = await guardedFetch(`${base}/v1/systemone`, {
          method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(body), timeoutMs: opts.timeoutMs ?? 30_000, maxBytes: 2 * 1024 * 1024, maxRedirects: 0, route: "egress",
        }).catch((error: unknown) => {
          const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string })?.code;
          // These failures precede sending; unlike a response timeout, they are safe to retry.
          if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED"].includes(code ?? "")) {
            throw new ProviderRejectedError(`typesafe connect failed: ${code}`, null, true);
          }
          throw error;
        });
        // Status-only errors keep credentials and arbitrary response bodies out of alerts/logs.
        if (res.status !== 200) throw new ProviderRejectedError(`typesafe HTTP ${res.status}`, res.status, res.status === 429 || res.status >= 500);
        let response: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(res.text());
          response = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
        }
        catch { response = {}; }
        const usage = response.usage as Record<string, unknown> | undefined;
        return { response, requestId: res.headers.get("x-request-id"), usage, cost: typesafeCost(usage) };
      });
    } catch (error) {
      // Timeouts remain unknown: the provider may have billed them. Existing receipt recovery owns retries.
      if (!(error instanceof ProviderRejectedError) || !error.retryable || attempt >= 2) throw error;
      await delay(250 * 2 ** attempt);
      continue;
    }
    const response = receipt.response as { model?: string; answers?: unknown };
    try {
      if (response.model !== model) throw new Error("unexpected model version");
      const answers = parseAnswers(response.answers, opts.questions);
      return { ...receipt, model, answers };
    } catch (error) {
      await rejectReceivedResponse(receipt.receiptId, `unusable TypeSafe output: ${String(error).slice(0, 300)}`);
      throw new ModelOutputError(`TypeSafe returned unusable output for ${opts.subject}`, receipt.receiptId);
    }
  }
}
