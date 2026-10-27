// Recover only an identified abstract. A paper's ordinary body is never an abstract fallback.
import * as cheerio from "cheerio";
import { collapseWhitespace } from "../lib/text.ts";

const MIN_CHARS = 200;
const MAX_CHARS = 6000;
const ABSTRACT_LABEL = /^(?:abstract|摘要)\s*[:：.]?\s*$/i;
const HEADINGS = "h1, h2, h3, h4, h5, h6";

/** The old feed collector cut every summary at this boundary. Identified HTML/metadata is exempt. */
export function journalAbstractIssue(raw: string | null | undefined, opts: { identified?: boolean } = {}): string | null {
  const text = collapseWhitespace(raw ?? "").replace(/^(?:abstract|摘要)\s*[:：.]?\s*/i, "");
  if (text.length < MIN_CHARS) return "fragment";
  if (text.length > MAX_CHARS) return "oversized";
  if (/^(?:STRENGTHS AND LIMITATIONS OF THIS STUDY|Article title\s*:|Publication date\s*:|Author\(s\)\s*:)/i.test(text)) return "not_abstract";
  if (!opts.identified && raw?.trim().length === 2000) return "legacy_truncation";
  return null;
}

/** Only an explicit statement in the publisher's abstract area proves absence. A title never does. */
export function journalAbstractUnavailable(html: string): boolean {
  const $ = cheerio.load(html, null, false);
  return $("#abstract, #Abstract, .abstract, .abstractSection, [role='doc-abstract'], [itemprop='abstract']")
    .toArray().some((node) => /^(?:abstract\s*[:：.]?\s*)?(?:no abstract (?:is )?available|abstract (?:is )?not available|this article (?:has no|does not have an) abstract)[.!]?$/i.test(collapseWhitespace($(node).text())));
}

function boundedText(html: string): string | null {
  const $ = cheerio.load(html, null, false);
  $("script, style, noscript, nav, aside, button, form").remove();
  $(HEADINGS).filter((_, node) => ABSTRACT_LABEL.test($(node).text().trim())).remove();
  $("br").replaceWith(" ");
  $("p, div, section, li, h1, h2, h3, h4, h5, h6").append(" ");
  const text = collapseWhitespace($.root().text()).replace(/^(?:abstract|摘要)\s*[:：.]\s*/i, "");
  // Reject an oversized section instead of taking the first 6,000 characters of a full paper.
  return journalAbstractIssue(text, { identified: true }) ? null : text;
}

/** Explicit publisher markup, or the small, heading-only structured abstract stored from Wiley. */
export function journalAbstractFromHtml(html: string | null | undefined, opts: { storedBody?: boolean; url?: string } = {}): string | null {
  if (!html?.trim()) return null;
  const $ = cheerio.load(html, null, false);
  for (const meta of $("meta[name]").toArray()) {
    if ($(meta).attr("name")?.toLowerCase() !== "citation_abstract") continue;
    const text = boundedText($(meta).attr("content") ?? "");
    if (text) return text;
  }
  $("script, style, noscript, nav, aside, header, footer, button, form").remove();
  const marked = $("[itemprop='abstract'], [role='doc-abstract'], #Abs1-content, #abstract, #Abstract, .abstract, .abstractSection, [data-title]")
    .filter((_, node) => !$(node).attr("data-title") || ABSTRACT_LABEL.test($(node).attr("data-title")!.trim()));
  for (const node of marked.toArray()) {
    const text = boundedText($.html(node));
    if (text) return text;
  }
  for (const node of $(HEADINGS).toArray()) {
    const heading = $(node);
    if (!ABSTRACT_LABEL.test(heading.text().trim())) continue;
    const level = Number(node.name.slice(1));
    const boundary = Array.from({ length: level }, (_, i) => `h${i + 1}`).join(", ");
    const parts: string[] = [];
    for (const sibling of heading.nextAll().toArray()) {
      const block = $(sibling);
      if (block.is(boundary) || block.find(boundary).length) break;
      parts.push($.html(sibling));
    }
    const text = boundedText(parts.join(" "));
    if (text) return text;
  }
  // Readability sometimes keeps Wiley's four abstract subsections and drops their outer label.
  // This exception is restricted to that publisher and an entire short, four-section stored body.
  let wiley = false;
  try { wiley = /(^|\.)onlinelibrary\.wiley\.com$/i.test(new URL(opts.url ?? "").hostname); } catch { /* no publisher */ }
  if (!opts.storedBody || !wiley) return null;
  const headings = $(HEADINGS).toArray();
  const labels = headings.map((node) => $(node).text().trim().toLowerCase());
  if (labels.join("|") !== "background|methods|results|conclusions") return null;
  if ($.root().children().first()[0] !== headings[0] || $("table, figure, ul, ol").length) return null;
  return boundedText($.html());
}
