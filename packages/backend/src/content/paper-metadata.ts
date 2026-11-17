import { z } from "zod";
import { SITE } from "@aihot/industry/site";
import { guardedFetch } from "../lib/http-fetch.ts";
import { stripTags, collapseWhitespace } from "../lib/text.ts";
import { normalizeDoi, normalizePaperTitle, type PaperReference } from "./paper-references.ts";
import { journalAbstractIssue } from "./journal-abstract.ts";
import { invertedToText } from "./abstracts.ts";

const DateParts = z.object({ "date-parts": z.array(z.array(z.number())) }).optional();
const Work = z.object({
  DOI: z.string(), title: z.array(z.string()).min(1), type: z.string(),
  "container-title": z.array(z.string()).default([]), ISSN: z.array(z.string()).default([]),
  "alternative-id": z.array(z.string()).default([]),
  abstract: z.string().optional(), URL: z.string().optional(),
  resource: z.object({ primary: z.object({ URL: z.string() }) }).optional(),
  "published-online": DateParts, published: DateParts, issued: DateParts,
  author: z.array(z.object({ given: z.string().optional(), family: z.string().optional() })).default([]),
});

export interface PaperMetadata {
  doi: string; title: string; journal: string; issn: string | null; url: string;
  publishedAt: Date | null; abstract: string | null; author: string | null;
  alternativeIds: string[];
  abstractProvider: string | null;
}

async function get(path: string): Promise<unknown> {
  const url = new URL(`${process.env.CROSSREF_API_URL ?? "https://api.crossref.org"}${path}`);
  if (SITE.contactEmail) url.searchParams.set("mailto", SITE.contactEmail);
  const response = await guardedFetch(url.toString(), { timeoutMs: 20_000, maxBytes: 1_000_000, headers: { accept: "application/json" } });
  if (response.status === 404) return null;
  if (response.status !== 200) throw new Error(`Crossref HTTP ${response.status}`);
  return JSON.parse(response.text());
}

function metadata(raw: unknown): PaperMetadata | null {
  const result = Work.safeParse(raw);
  if (!result.success || result.data.type !== "journal-article") return null;
  const w = result.data;
  const doi = normalizeDoi(w.DOI);
  const title = collapseWhitespace(stripTags(w.title[0]!));
  const journal = collapseWhitespace(w["container-title"][0] ?? "");
  if (!doi || title.length < 6 || !journal) return null;
  const parts = (w["published-online"] ?? w.published ?? w.issued)?.["date-parts"][0];
  // Imprecise dates remain unknown rather than claiming an invented publication day.
  const date = parts?.length === 3 ? new Date(Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!)) : null;
  let url = `https://doi.org/${doi}`;
  try {
    const candidate = new URL(w.resource?.primary.URL ?? w.URL ?? url);
    if (candidate.protocol === "https:" && !candidate.username && !candidate.password) url = candidate.toString();
  } catch { /* retain the DOI landing page */ }
  const abstract = w.abstract ? collapseWhitespace(stripTags(w.abstract)) : null;
  return { doi, title, journal, issn: w.ISSN[0] ?? null, url,
    alternativeIds: w['alternative-id'],
    abstractProvider: abstract && !journalAbstractIssue(abstract, { identified: true }) ? 'crossref' : null,
    publishedAt: date && Number.isFinite(date.getTime()) && date.getUTCFullYear()===parts![0] && date.getUTCMonth()+1===parts![1] && date.getUTCDate()===parts![2] ? date : null,
    abstract: abstract && !journalAbstractIssue(abstract, { identified: true }) ? abstract : null,
    author: w.author.map((a) => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean).join(", ").slice(0, 1000) || null };
}

function exactDay(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date=new Date(value+'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value) ? date : null;
}

async function supplement(work: PaperMetadata): Promise<PaperMetadata> {
  // Crossref often has only an Elsevier issue month. Do not invent a day: ask DOI-matched metadata
  // for the online date and abstract, leaving the date unknown if neither index identifies one.
  const json=async(url:string)=>{
    const res=await guardedFetch(url,{timeoutMs:20_000,maxBytes:1_000_000});
    if(res.status!==200)return null;
    return JSON.parse(res.text()) as unknown;
  };
  const acceptAbstract=(text:string|undefined,provider:string)=>{
    const clean=collapseWhitespace(stripTags(text??''));
    if(!work.abstract && !journalAbstractIssue(clean,{identified:true})){work.abstract=clean;work.abstractProvider=provider;}
  };
  if(!work.publishedAt || !work.abstract)try{
    const base=process.env.EUROPEPMC_API_URL??'https://www.ebi.ac.uk/europepmc/webservices/rest';
    const data=z.object({resultList:z.object({result:z.array(z.object({doi:z.string().optional(),firstPublicationDate:z.string().optional(),abstractText:z.string().optional()}))})})
      .safeParse(await json(`${base}/search?query=${encodeURIComponent(`DOI:"${work.doi}"`)}&resultType=core&format=json`));
    const hit=data.success?data.data.resultList.result.find((r)=>r.doi?.toLowerCase()===work.doi):null;
    if(hit){work.publishedAt??=exactDay(hit.firstPublicationDate);acceptAbstract(hit.abstractText,'europepmc');}
  }catch{ /* index absence/outage does not discard confirmed Crossref metadata */ }
  if(!work.publishedAt || !work.abstract)try{
    const base=process.env.OPENALEX_API_URL??'https://api.openalex.org';
    const data=z.object({doi:z.string(),publication_date:z.string().optional(),abstract_inverted_index:z.record(z.string(),z.array(z.number())).nullable().optional()})
      .safeParse(await json(`${base}/works/doi:${encodeURI(work.doi)}?select=doi,publication_date,abstract_inverted_index`));
    if(data.success && normalizeDoi(data.data.doi)===work.doi){
      work.publishedAt??=exactDay(data.data.publication_date);
      acceptAbstract(invertedToText(data.data.abstract_inverted_index??null),'openalex');
    }
  }catch{ /* the ordinary abstract-recovery job can retry after import */ }
  return work;
}

/** A DOI is authoritative; title-only discovery needs one unique, exact normalized title. */
export async function resolvePaperReference(ref: PaperReference): Promise<PaperMetadata | null> {
  if (ref.doi) {
    const data = z.object({ message: z.unknown() }).safeParse(await get(`/works/${encodeURIComponent(ref.doi)}`));
    const work = data.success ? metadata(data.data.message) : null;
    return work?.doi === ref.doi ? supplement(work) : null;
  }
  const query = ref.pii ? `filter=alternative-id:${encodeURIComponent(ref.pii)}` : `query.bibliographic=${encodeURIComponent(ref.title ?? "")}`;
  const data = z.object({ message: z.object({ items: z.array(z.unknown()) }) }).safeParse(await get(`/works?${query}&rows=5`));
  if (!data.success) return null;
  const hits = data.data.message.items.map(metadata).filter((w): w is PaperMetadata => !!w)
    .filter((w) => ref.pii ? w.alternativeIds.some((id)=>id.toUpperCase()===ref.pii) : normalizePaperTitle(w.title) === normalizePaperTitle(ref.title ?? ""));
  return new Set(hits.map((w) => w.doi)).size === 1 ? supplement(hits[0]!) : null;
}
