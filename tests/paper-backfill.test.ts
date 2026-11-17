import { stub, Reply, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { discoverPaperReferences, resolveStoredPaperReference, backfillReferencedPapers } from "@aihot/backend/content/paper-backfill";
import { resolvePaperReference } from "@aihot/backend/content/paper-metadata";
import { loadPaperLinks } from "@aihot/backend/publication/paper-links";

const T = tag(), MP = `test-paper-mp-${T}`, JOURNAL = `test-paper-journal-${T}`;
const TITLE = `Psychological treatment outcomes in a randomized clinical trial ${T}`;
const ABSTRACT = "Background A randomized clinical trial evaluated a psychological intervention in adults with depression. Methods Participants were randomized to treatment or a control condition and assessed at baseline and follow-up. Results The treatment group showed greater symptom improvements, with uncertainty around secondary outcomes. Conclusions Additional trials are needed to evaluate longer-term outcomes and generalizability.";
const works: Record<string, unknown> = {};
const supplements: Record<string,unknown> = {};
const api = await stub((_n, req) => {
  const u = new URL(req.url, "http://localhost");
  if(u.pathname==='/epmc/search')return {resultList:{result:[{doi:'10.1234/wrong',firstPublicationDate:'2026-01-01',abstractText:'wrong abstract'},supplements[u.searchParams.get('query')??'']].filter(Boolean)}};
  if(u.pathname.startsWith('/openalex/'))return new Reply(404,{});
  if (u.pathname.startsWith("/works/")) {
    const doi = decodeURIComponent(u.pathname.slice(7));
    if (doi.includes("temporary-error")) return new Reply(503, {});
    return works[doi] ? { message: works[doi] } : new Reply(404, {});
  }
  if (u.pathname === "/works") return { message: { items: [works[`10.1234/${T}-one`], works[`10.1234/${T}-two`]].filter(Boolean) } };
  throw Error("unexpected metadata request");
});
process.env.CROSSREF_API_URL = api.url;
process.env.EUROPEPMC_API_URL = api.url+'/epmc';
process.env.OPENALEX_API_URL = api.url+'/openalex';
config.allowPrivateNetworkFetch = true;
config.modelCallsEnabled = false;
function work(doi: string, title = TITLE) {
  return { DOI: doi, type: "journal-article", title: [title], "container-title": [`Backfill Test Journal ${T}`], ISSN: ["1234-5678"],
    abstract: `<jats:p>${ABSTRACT}</jats:p>`, "published-online": { "date-parts": [[2024, 2, 1]] }, URL: `https://doi.org/${doi}` };
}
before(async () => {
  await sql`INSERT INTO sources (id,name,kind,tier,tags,first_party,track,interval_minutes) VALUES
    (${MP}, ${MP}, 'mp_account','T2', ${["研究"]},false,'academic',1440),
    (${JOURNAL}, ${`Backfill Test Journal ${T}`}, 'rss','T1', ${["期刊"]},true,'academic',30)`;
});
after(async () => {
  await sql`DELETE FROM articles WHERE source_id IN (SELECT id FROM sources WHERE id IN (${MP},${JOURNAL}) OR name=${`New Journal ${T}`})`;
  await sql`DELETE FROM sources WHERE id IN (${MP},${JOURNAL}) OR name=${`New Journal ${T}`}`;
  await api.close(); await stopBoss(); await closeDb();
});
async function report(body: string) {
  const r = await upsertMaterial({ sourceId: MP, title: "报道一项心理研究", url: `https://mp.weixin.qq.com/s/${tag()}`, via: "fetch", bodyText: body, bodyStatus: "ok" });
  await sql`INSERT INTO publications (article_id,title,source_id,channel,url,discovered_at,timeline_at,sort_at,eligible,visibility,summary)
    VALUES (${r.articleId},'报道一项心理研究',${MP},'news','https://mp.weixin.qq.com/',now(),now(),now(),true,'public','研究摘要')`;
  return r.articleId;
}
async function reference(id: string) {
  await discoverPaperReferences(100);
  return (await sql`SELECT * FROM paper_references WHERE report_id = ${id} ORDER BY id`)[0]!;
}

test("DOI metadata must agree; title-only matches reject ambiguity and related protocols", async () => {
  const doi = `10.1234/${T}-one`;
  works[doi] = work(doi);
  const ref = { key: "title:test", title: TITLE, doi: null, pii: null };
  assert.equal((await resolvePaperReference(ref))?.doi, doi);
  works[`10.1234/${T}-two`] = work(`10.1234/${T}-two`);
  assert.equal(await resolvePaperReference(ref), null);
  works[`10.1234/${T}-two`] = work(`10.1234/${T}-two`, `${TITLE}: protocol`);
  assert.equal((await resolvePaperReference(ref))?.doi, doi);
  works[doi] = work("10.1234/a-different-doi");
  assert.equal(await resolvePaperReference({ ...ref, doi }), null);
});

test("two reports and concurrent attempts create one historical paper and explicit citation links", async () => {
  const doi = `10.1234/${T}-shared`; works[doi] = {...work(doi),'alternative-id':['S0165032726999991']};
  const a = await report(`原题 ${TITLE} 期刊 Test DOI https://doi.org/${doi}`);
  const b = await report(`文献来源 doi: ${doi}.`);
  const ra = await reference(a), rb = await reference(b);
  await Promise.all([resolveStoredPaperReference(ra.id), resolveStoredPaperReference(rb.id)]);
  const links = await sql`SELECT paper_id,status FROM paper_references WHERE report_id IN (${a},${b})`;
  assert.equal(links.length, 2); assert.ok(links.every((r) => r.status === "resolved"));
  assert.equal(new Set(links.map((r) => r.paper_id)).size, 1);
  const [paper] = await sql`SELECT * FROM articles WHERE id = ${links[0]!.paper_id}`;
  assert.equal(paper!.source_id, JOURNAL);
  assert.equal(paper!.excerpt, ABSTRACT);
  assert.equal(paper!.backfill, true);
  assert.equal(paper!.timeline_at.toISOString(), "2024-02-01T00:00:00.000Z");
  assert.equal((await sql`SELECT * FROM paper_doi_registry WHERE doi = ${doi}`).length, 1);
  const hits = api.hits(); await resolveStoredPaperReference(ra.id); assert.equal(api.hits(), hits);
  // A later ordinary journal feed using another DOI URL reuses the same identity.
  const again = await upsertMaterial({ sourceId: JOURNAL, title: TITLE, url: `https://onlinelibrary.wiley.com/doi/${doi}`, via: "fetch" });
  assert.equal(again.articleId, paper!.id); assert.equal(again.created, false);
  const pii = await upsertMaterial({ sourceId:JOURNAL,title:TITLE,url:'https://www.sciencedirect.com/science/article/pii/S0165032726999991',via:'fetch' });
  assert.equal(pii.articleId,paper!.id);assert.equal(pii.created,false);
});

test("existing publisher rows are reused even without stored DOI metadata", async () => {
  const doi = `10.1234/${T}-existing`; works[doi] = work(doi);
  const existing = await upsertMaterial({ sourceId: JOURNAL, title: '[Articles] '+TITLE+" existing", url: `https://publisher.example/paper-${T}`, via: "fetch", bodyStatus:'unconfirmed' });
  works[doi] = work(doi,TITLE+" existing");
  const id = await report(`DOI: ${doi}`), ref = await reference(id);
  await resolveStoredPaperReference(ref.id);
  assert.equal((await sql`SELECT paper_id FROM paper_references WHERE id = ${ref.id}`)[0]!.paper_id, existing.articleId);
  assert.equal((await sql`SELECT excerpt FROM articles WHERE id=${existing.articleId}`)[0]!.excerpt,ABSTRACT,'a previously captured paper with no abstract becomes processable');
});

test("misses retry with backoff; revisions remove obsolete links; collection switch and withdrawal are respected", async () => {
  const id = await report(`DOI: 10.1234/${T}-missing`), ref = await reference(id);
  await resolveStoredPaperReference(ref.id);
  const [miss] = await sql`SELECT * FROM paper_references WHERE id = ${ref.id}`;
  assert.equal(miss!.status, "not_found"); assert.equal(miss!.attempts, 1);
  assert.ok(miss!.next_try_at.getTime() > Date.now());
  const hits = api.hits(); await resolveStoredPaperReference(ref.id); assert.equal(api.hits(),hits);
  await sql`UPDATE articles SET revision=revision+1,body_text='更正：本文没有引用研究论文。' WHERE id=${id}`;
  await discoverPaperReferences(100);
  assert.equal((await sql`SELECT * FROM paper_references WHERE report_id=${id}`).length,0);
  process.env.COLLECT_ENABLED="false";
  assert.deepEqual(await backfillReferencedPapers(),{scanned:0,tried:0,resolved:0});
  delete process.env.COLLECT_ENABLED;
  const withdrawn = await report(`DOI: 10.1234/${T}-withdrawn`), wr = await reference(withdrawn);
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${withdrawn}`;
  await resolveStoredPaperReference(wr.id); assert.equal(api.hits(),hits);
});

test("public citation links are bidirectional and respect withdrawal, source mode and release gates", async () => {
  const doi=`10.1234/${T}-public`;works[doi]=work(doi,TITLE+" public");
  const id=await report(`doi: ${doi}`),ref=await reference(id);
  await resolveStoredPaperReference(ref.id);
  const [{paper_id:paper}]=await sql`SELECT paper_id FROM paper_references WHERE id=${ref.id}`;
  assert.deepEqual(await loadPaperLinks(id),[],"unprocessed paper is not leaked");
  await sql`INSERT INTO publications (article_id,title,source_id,channel,url,discovered_at,timeline_at,sort_at,eligible,visibility,summary)
    VALUES (${paper},'原论文标题',${JOURNAL},'news','https://doi.org/',now(),now(),now(),true,'public','论文摘要')`;
  assert.deepEqual(await loadPaperLinks(id),[{id:paper,title:'原论文标题',source:`Backfill Test Journal ${T}`,relation:'paper'}]);
  assert.equal((await loadPaperLinks(paper))[0]!.id,id);
  await sql`UPDATE publications SET selected=true,visible_after=now()+interval '1 day' WHERE article_id=${paper}`;
  assert.deepEqual(await loadPaperLinks(id),[]);
  await sql`UPDATE publications SET selected=false,visibility='withdrawn' WHERE article_id=${paper}`;
  assert.deepEqual(await loadPaperLinks(id),[]);
  await sql`UPDATE publications SET visibility='public' WHERE article_id=${paper}`;
  await sql`UPDATE sources SET participation_mode='isolated' WHERE id=${JOURNAL}`;
  assert.deepEqual(await loadPaperLinks(id),[]);
  await sql`UPDATE sources SET participation_mode='editorial' WHERE id=${JOURNAL}`;
  await sql`UPDATE articles SET revision=revision+1 WHERE id=${id}`;
  assert.deepEqual(await loadPaperLinks(paper),[],"a revised report's stale citation is hidden immediately");
  await discoverPaperReferences(100);
  assert.equal((await loadPaperLinks(paper))[0]?.id,id,"rescanning confirms an unchanged reference for the new revision");
});

test("temporary metadata errors back off; an unknown journal gets an on-demand source rather than a scheduled subscription",async()=>{
  const id=await report(`doi: 10.1234/${T}-temporary-error`),ref=await reference(id);
  await resolveStoredPaperReference(ref.id);
  assert.equal((await sql`SELECT status FROM paper_references WHERE id=${ref.id}`)[0]!.status,'failed');
  const doi=`10.1234/${T}-new-journal`;
  works[doi]={...work(doi,TITLE+' new journal'),'container-title':[`New Journal ${T}`],ISSN:[`ISSN-${T}`]};
  const second=await report(`doi: ${doi}`),r=await reference(second);
  await resolveStoredPaperReference(r.id);
  const [source]=await sql`SELECT s.* FROM paper_references r JOIN articles a ON a.id=r.paper_id JOIN sources s ON s.id=a.source_id WHERE r.id=${r.id}`;
  assert.equal(source!.kind,'external');assert.equal(source!.site_fulltext,false);assert.equal(source!.track,'academic');
});

test("partial issue dates use DOI-verified online metadata and never the provider's unrelated first hit",async()=>{
  const doi=`10.1234/${T}-partial-date`;
  const partial={...work(doi),abstract:undefined,'published-online':{'date-parts':[[2026,11]]}};
  works[doi]=partial;
  supplements[`DOI:"${doi}"`]={doi,firstPublicationDate:'2026-11-03',abstractText:ABSTRACT};
  const r={key:'doi:'+doi,doi,title:null,pii:null};
  const hit=await resolvePaperReference(r);
  assert.equal(hit?.publishedAt?.toISOString(),'2026-11-03T00:00:00.000Z');
  assert.equal(hit?.abstractProvider,'europepmc');
  delete supplements[`DOI:"${doi}"`];
  const missing=await resolvePaperReference(r);
  assert.equal(missing?.publishedAt,null);assert.equal(missing?.abstract,null);
});
