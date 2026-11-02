// An error as one line of stored text (sources.last_error, fetch_runs.error, abstract lookups).

/**
 * undici reports every connection failure as `TypeError: fetch failed` and keeps the real reason
 * (ENOTFOUND, ECONNRESET, UND_ERR_CONNECT_TIMEOUT, a certificate error) in `error.cause`, so a stored
 * `error.message` alone cannot tell a dead host from a refused handshake. The text keeps the code and
 * message of each cause, for example "fetch failed (ECONNRESET: socket hang up)".
 */
const SECRET_NAME = "api[-_]?key|access[-_]?token|token|key|secret|password|passwd|pwd|signature|sign|auth|authorization|session(?:id)?";

/** Credentials that error text can carry: a URL's user info and secret-named parameters, Bearer/Basic values, `sk-` keys. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1")
    .replace(new RegExp(`(^|[?&;,\\s{"'])(${SECRET_NAME})(=|"?\\s*:\\s*")[^&#\\s"')]+`, "gi"), "$1$2$3[redacted]")
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, "$1 [redacted]")
    .replace(/\bsk-[\w-]{16,}/g, "sk-[redacted]");
}

/** The code and message of one error in a cause chain, without repeating a code its message already names. */
function detail(error: { code?: unknown; message?: unknown }): string {
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";
  if (!message) return code;
  return !code || message.includes(code) ? message : `${code}: ${message}`;
}

/** The error's own message followed by its causes (an AggregateError's first failures included), cut to `max` characters. */
export function describeError(error: unknown, max = 500): string {
  const base = error instanceof Error ? error.message : String(error);
  const details: string[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || seen.has(node) || depth > 4) return;
    seen.add(node);
    // The error itself is already the message; only its code can add to it.
    const text = depth === 0 ? detail({ code: (node as { code?: unknown }).code }) : detail(node as { code?: unknown; message?: unknown });
    if (text && !base.includes(text) && !details.includes(text)) details.push(text);
    const nested = (node as { errors?: unknown }).errors;
    if (Array.isArray(nested)) for (const inner of nested.slice(0, 3)) visit(inner, depth + 1);
    visit((node as { cause?: unknown }).cause, depth + 1);
  };
  visit(error, 0);
  return redactSecrets(details.length ? `${base} (${details.join("; ")})` : base).slice(0, max);
}
