import assert from "node:assert/strict";
import { test } from "node:test";
import { extractPaperReferences, paperDoiFromUrl, paperPiiFromUrl, normalizePaperTitle } from "@aihot/backend/content/paper-references";

test("DOIs in prose and publisher links retain balanced parentheses and deduplicate", () => {
  const refs = extractPaperReferences("doi: 10.1016/S2215-0366(26)00326-3. https://doi.org/10.1016/S2215-0366(26)00326-3；");
  assert.deepEqual(refs, [{ key: "doi:10.1016/s2215-0366(26)00326-3", doi: "10.1016/s2215-0366(26)00326-3", title: null, pii: null }]);
  assert.equal(paperDoiFromUrl("https://www.nature.com/articles/s44184-026-00249-8?utm_source=wechat"), "10.1038/s44184-026-00249-8");
  assert.equal(paperDoiFromUrl("https://www.nature.com.evil.test/articles/s44184-026-00249-8"), null);
  assert.equal(paperDoiFromUrl("https://www.thelancet.com/journals/lanpsy/article/PIIS2215-0366(26)00274-9/fulltext?rss=yes"),"10.1016/s2215-0366(26)00274-9");
  assert.equal(paperPiiFromUrl("https://www.thelancet.com/journals/lanpsy/article/PIIS2215-0366(26)00274-9/fulltext"),"S2215036626002749");
  assert.equal(normalizePaperTitle('[Articles] A clinical trial'),normalizePaperTitle('A clinical trial'));
  assert.notEqual(normalizePaperTitle('[18F] Binding in the brain'),normalizePaperTitle('[11C] Binding in the brain'));
});

test("explicit titles, bibliographies and ScienceDirect links yield bounded references", () => {
  const refs = extractPaperReferences("论文信息 原题 Benchmarking Language Models for Clinical Safety: A Primer for Mental Health Professionals 期刊 Psychotherapy and Psychosomatics 作者 A. B. DOI https://doi.org/10.1159/000553576");
  assert.equal(refs.length, 1, "a title alongside one DOI is the same reference");
  assert.equal(refs[0]!.title, "Benchmarking Language Models for Clinical Safety: A Primer for Mental Health Professionals");
  assert.equal(extractPaperReferences("文献来源 Hald, A. N. (2026). Divorce conflict and health across the divorce process: A 10-year observational study. British Journal of Health Psychology, 31.")[0]!.title, "Divorce conflict and health across the divorce process: A 10-year observational study");
  assert.equal(extractPaperReferences("https://www.sciencedirect.com/science/article/pii/S0165032726001234")[0]!.pii, "S0165032726001234");
  assert.equal(extractPaperReferences(Array.from({ length: 30 }, (_, i) => `10.1234/paper-${i}`).join(" ")).length, 8);
});

test("ordinary Chinese headlines and arbitrary or private URLs never become fetch targets", () => {
  assert.deepEqual(extractPaperReferences("论文让我们认识自己 https://127.0.0.1/private https://example.org/a https://sciencedirect.com.evil.test/science/article/pii/S0165032726001234"), []);
  assert.equal(normalizePaperTitle("Anxiety–depression: A trial"), normalizePaperTitle("Anxiety-depression: A trial"));
  assert.equal(extractPaperReferences("论文标题：青少年情绪调节与心理健康的纵向关系 期刊 心理学报")[0]?.title,"青少年情绪调节与心理健康的纵向关系");
  assert.equal(extractPaperReferences("",'<a href="https://karger.com/pps/article/95/4/1">Benchmarking Language Models for Clinical Safety</a>')[0]?.title,"Benchmarking Language Models for Clinical Safety");
});

test("the reported paper's metadata section precedes incidental background citations at the scan limit",()=>{
  const background=Array.from({length:12},(_,i)=>`10.1234/background-${i}`).join(' ');
  const refs=extractPaperReferences(background+' 论文信息 DOI 10.1159/main-study');
  assert.equal(refs[0]?.doi,'10.1159/main-study');assert.equal(refs.length,8);
});
