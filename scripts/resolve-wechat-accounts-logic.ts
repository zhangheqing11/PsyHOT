export interface WechatAccountCandidate {
  ghid: string;
  name: string;
  biz: string | null;
}

/** EveryInfra may return __biz as decimal digits while source config stores base64. */
export function asBiz(value: string | null): string | null {
  return value && /^\d+$/.test(value) ? Buffer.from(value).toString("base64") : value;
}

export function candidates(results: unknown): WechatAccountCandidate[] {
  const rows = Array.isArray(results) ? results : [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const ghid = [r.ghid, r.account_ghid, r.username, r.id].find((v): v is string => typeof v === "string" && /^gh_[0-9a-f]{12}$/.test(v));
    const name = [r.name, r.nickname, r.account_name].find((v): v is string => typeof v === "string") ?? "";
    const biz = [r.biz, r.__biz].find((v): v is string => typeof v === "string") ?? null;
    return ghid ? [{ ghid, name, biz }] : [];
  });
}

export function matchingCandidate(found: WechatAccountCandidate[], expectedBiz: string | undefined): WechatAccountCandidate | null {
  return found.find((candidate) => asBiz(candidate.biz) === expectedBiz) ?? null;
}
