// Only identifiers and explicitly labelled/bibliographic titles leave this parser. Arbitrary links
// in an untrusted report are never fetched: the resolver talks only to scholarly metadata APIs.
import * as cheerio from "cheerio";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { sha256 } from "../lib/ids.ts";

export interface PaperReference { key: string; doi: string | null; title: string | null; pii: string | null }

export const normalizePaperTitle = (s: string) => collapseWhitespace(stripTags(s).replace(/^\[(?:Articles?|Reviews?|Personal View|Comment|Correspondence|Editorial|News|Letters?)\]\s*/i, "").normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " "));

export function paperPiiFromUrl(raw: string): string | null {
  try {
    const path = new URL(raw).pathname;
    const candidate = /(?:\/pii\/|\/PII)(S?[0-9X()\-]{16,24})(?:\/|$)/i.exec(path)?.[1]?.replace(/[^a-z0-9]/gi, "").toUpperCase();
    return candidate && /^S?[0-9X]{16,17}$/.test(candidate) ? candidate : null;
  } catch { return null; }
}

export function normalizeDoi(raw: string): string | null {
  let s = raw;
  try { s = decodeURIComponent(s); } catch { /* keep literal text */ }
  s = /\b10\.\d{4,9}\/[a-z0-9._;()/:+\-]+/i.exec(s)?.[0] ?? "";
  s = s.replace(/[.,;:]+$/, "");
  while (s.endsWith(")") && (s.match(/\)/g)?.length ?? 0) > (s.match(/\(/g)?.length ?? 0)) s = s.slice(0, -1);
  return s.length > 6 && s.length <= 300 ? s.toLowerCase() : null;
}

export function paperDoiFromUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const doi = normalizeDoi(u.pathname);
  if (doi) return doi;
  const nature = /^(?:www\.)?nature\.com$/i.test(u.hostname) && /^\/articles\/(s\d{5}-[a-z0-9-]+)\/?$/i.exec(u.pathname);
  if (nature) return `10.1038/${nature[1]!.toLowerCase()}`;
  const lancet = /^(?:www\.)?thelancet\.com$/i.test(u.hostname) && /\/PII(S\d{4}-\d{4}\(\d{2}\)\d{5}-[0-9X])/i.exec(u.pathname);
  return lancet ? `10.1016/${lancet[1]!.toLowerCase()}` : null;
}

export function extractPaperReferences(text: string, html?: string | null): PaperReference[] {
  const body = text.slice(0, 100_000);
  const refs = new Map<string, PaperReference>();
  const add = (r: PaperReference) => { if (!refs.has(r.key) && refs.size < 8) refs.set(r.key, r); };
  const focus = body.search(/论文信息|原文信息|文献来源|文献索引/);
  const identifierText = focus >= 0 ? `${body.slice(focus)}\n${body.slice(0, focus)}` : body;
  for (const m of identifierText.matchAll(/\b10\.\d{4,9}\/[a-z0-9._;()/:+\-]+/gi)) {
    const doi = normalizeDoi(m[0]);
    if (doi) add({ key: `doi:${doi}`, doi, title: null, pii: null });
  }
  const links: string[] = body.match(/https?:\/\/[^\s<>"'）]+/gi) ?? [];
  const linkedTitles: string[] = [];
  if (html) {
    const $ = cheerio.load(html.slice(0, 300_000));
    $("a[href]").each((_, a) => {
      const href = $(a).attr("href");
      if (!href) return;
      links.push(href);
      try {
        if (/(^|\.)(?:karger\.com|pubmed\.ncbi\.nlm\.nih\.gov|nature\.com|science\.org|sciencedirect\.com|springer\.com|wiley\.com|jmir\.org)$/.test(new URL(href).hostname)) linkedTitles.push($(a).text());
      } catch { /* not a publisher link */ }
    });
  }
  for (const raw of links.slice(0, 100)) {
    const doi = paperDoiFromUrl(raw.replace(/[.,;]+$/, ""));
    if (doi) { add({ key: `doi:${doi}`, doi, title: null, pii: null }); continue; }
    try {
      const u = new URL(raw);
      const pii = /^(?:www\.)?sciencedirect\.com$/.test(u.hostname) && /^\/science\/article\/pii\/(S?[0-9X]{16,17})\b/i.exec(u.pathname)?.[1];
      if (pii) add({ key: `pii:${pii.toUpperCase()}`, pii: pii.toUpperCase(), doi: null, title: null });
    } catch { /* not an academic link */ }
  }
  const titles: string[] = [...linkedTitles];
  for (const m of body.matchAll(/(?:原题|论文标题|文章标题|论文题名|Original title|Article title)\s*[:：]?\s*[“"]?(.{15,350}?)(?=[”"\n]|\s+(?:期刊|作者|类型|DOI\b|Journal\b|Authors?\b)|$)/gi)) titles.push(m[1]!);
  // Restrict APA-style recognition to the bibliography: narrative dates cannot become paper titles.
  const bibliography = body.search(/文献来源|参考文献|文献索引|References\b/i);
  if (bibliography >= 0) {
    for (const m of body.slice(bibliography).matchAll(/\(\d{4}[a-z]?\)\.\s+([^\n]{15,350}?)\.\s+[A-Z\u4e00-\u9fff]/g)) titles.push(m[1]!);
  }
  const unique = [...new Set(titles.map((t) => collapseWhitespace(t).replace(/[。.”"]+$/, "")))].filter((t) => t.length <= 350 &&
    ((/[a-z]{3}/i.test(t) && normalizePaperTitle(t).split(" ").length >= 4) || (t.match(/\p{Script=Han}/gu)?.length ?? 0) >= 6));
  if (refs.size === 1 && unique.length === 1) [...refs.values()][0]!.title = unique[0]!;
  else if (refs.size === 0) for (const title of unique) add({ key: `title:${sha256(normalizePaperTitle(title))}`, doi: null, pii: null, title });
  return [...refs.values()];
}
