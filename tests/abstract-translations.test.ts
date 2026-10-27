import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { abstractSourceHash, isAbstractCandidate, translateAbstracts } from "@aihot/backend/editorial/abstract-translate";
import { loadItemDetail, siteItemDetail } from "@aihot/backend/publication/detail";
import type { ItemDetail } from "@aihot/contracts/site";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const SOURCE = `test-abstract-translation-${T}`;
const ABSTRACT = `This randomized study examined whether a brief intervention changed sleep and mood in 240 adolescents. Participants were assigned to the intervention or an information control condition. The intervention group reported a modest improvement in sleep quality, while the difference in depressive symptoms was uncertain and the study did not establish a causal effect beyond the follow-up period. (${T})`;
const TRANSLATION = `这项随机研究考察了一项简短干预是否改变了 240 名青少年的睡眠和情绪。参与者被分配到干预组或信息对照组。干预组报告的睡眠质量有小幅改善，但抑郁症状的差异并不确定，研究也没有证明随访期以外的因果效应。`;

process.env.MODEL_CALLS_ENABLED = "true";
config.modelCallsEnabled = true;
let provider: Awaited<ReturnType<typeof stub>>;

before(async () => {
  // This throwaway database is shared by the repository tests; remove rows from an interrupted local
  // run so the worker's newest-first limit cannot select an older fixture on the idempotence check.
  await sql`DELETE FROM articles WHERE source_id LIKE 'test-abstract%'`;
  await sql`DELETE FROM sources WHERE id LIKE 'test-abstract%'`;
  provider = await stub((_hit, req) => {
    assert.equal(req.url, "/v1/chat/completions");
    return { id: `abstract-${T}`, choices: [{ message: { content: JSON.stringify({ translation: TRANSLATION }) } }], usage: { total_tokens: 20 } };
  });
  process.env.TRANSLATE_MODEL = "deepseek-flash";
  process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
  process.env.DEEPSEEK_API_KEY = "test-key";
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, tags, next_fetch_at)
    VALUES (${SOURCE}, 'Test journal', 'rss', 'T1', 'editorial', ${["期刊"]}, '2100-01-01')`;
});

after(async () => {
  config.abstractTranslationEnabled = false;
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("abstract candidates are limited to non-Chinese journal/preprint abstracts", () => {
  assert.equal(isAbstractCandidate({ excerpt: ABSTRACT, language: "en", tags: ["期刊"] }), true);
  assert.equal(isAbstractCandidate({ excerpt: ABSTRACT, language: "en", tags: ["机构"] }), false);
  assert.equal(isAbstractCandidate({ excerpt: ABSTRACT, tags: ["新闻"], lookedUp: true }), false, "a lookup does not turn news into a journal source");
  assert.equal(isAbstractCandidate({ excerpt: ABSTRACT, tags: ["期刊"], sourceKind: "mp_account" }), false, "WeChat remains outside paper abstracts");
  assert.equal(isAbstractCandidate({ excerpt: "这是一段中文摘要，已经可以直接阅读。".repeat(20), language: "zh", tags: ["期刊"] }), false);
  assert.equal(isAbstractCandidate({ excerpt: "Publication date: 1 January 2026 Source: Journal Author(s): A.", tags: ["期刊"] }), false);
});

test("site projection switches an abstract and falls back to the source after a failed translation", () => {
  const detail = {
    abstract: {
      original: "Original abstract",
      translation: null,
      language: "en",
      doi: "10.1234/example",
      source: "openalex",
      translationStatus: "failed",
    },
    body: null,
  } as ItemDetail;
  const fallback = siteItemDetail(detail);
  assert.equal(fallback.bodyLanguage, "original");
  assert.equal(fallback.hasTranslation, false);
  assert.equal(fallback.abstract?.original, "Original abstract");
  assert.equal(fallback.abstract?.translation, null);

  // A full-text translation must not hide an untranslated/failed abstract. The two workers have
  // independent receipts and the source abstract is still the safe reading fallback.
  const bodyTranslated = siteItemDetail({
    ...detail,
    body: { zh: "<p>中文正文</p>", original: "<p>Original body</p>", zhKind: "translation", complete: true },
  });
  assert.equal(bodyTranslated.bodyLanguage, "zh");
  assert.equal(bodyTranslated.abstract?.original, "Original abstract");
  assert.equal(bodyTranslated.abstract?.translation, null);

  const translated = siteItemDetail({
    ...detail,
    abstract: { ...detail.abstract!, translation: "中文摘要", translationStatus: "translated" },
  });
  assert.equal(translated.bodyLanguage, "zh");
  assert.equal(translated.hasTranslation, true);
  assert.equal(translated.abstract?.original, "Original abstract");
  assert.equal(translated.abstract?.translation, "中文摘要");
  const original = siteItemDetail({ ...detail, abstract: { ...detail.abstract!, translation: "中文摘要", translationStatus: "translated" } }, true);
  assert.equal(original.bodyLanguage, "original");
  assert.equal(original.abstract?.original, "Original abstract");
  assert.equal(original.abstract?.translation, "中文摘要");
});

test("worker translates only the current abstract revision and reuses its receipt", async () => {
  config.abstractTranslationEnabled = true;
  config.abstractTranslationDays = 3;
  const old = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://doi.org/10.1234/abstract-old.${T}`,
    title: `Old abstract ${T}`,
    language: "en",
    excerpt: ABSTRACT,
    bodyStatus: "none",
    via: "fetch",
    publishedAt: new Date(Date.now() - 31 * 86_400_000),
    discoveredAt: new Date(Date.now() - 31 * 86_400_000),
  });
  await sql`INSERT INTO abstract_lookups (article_id, found_at, provider, doi)
    VALUES (${old.articleId}, now(), 'openalex', ${`10.1234/abstract-old.${T}`})`;
  const beforeOld = provider.hits();
  assert.deepEqual(await translateAbstracts({ limit: 1 }), []);
  assert.equal(provider.hits(), beforeOld, "abstracts older than the configured window are not sent");
  assert.equal((await sql`SELECT count(*)::int AS n FROM abstract_translations WHERE article_id=${old.articleId}`).at(0)?.n, 0);
  await sql`DELETE FROM articles WHERE id=${old.articleId}`;

  const { articleId } = await upsertMaterial({
    sourceId: SOURCE,
    url: `https://doi.org/10.1234/abstract.${T}`,
    title: `Abstract translation ${T}`,
    language: "en",
    excerpt: ABSTRACT,
    bodyText: `Full text must never be sent to the abstract translator ${T}.`,
    bodyStatus: "ok",
    via: "fetch",
    publishedAt: new Date(),
    discoveredAt: new Date(Date.now() + 86_400_000),
  });
  const [article] = await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE id=${articleId}`;
  await sql`INSERT INTO abstract_lookups (article_id, found_at, provider, doi)
    VALUES (${articleId}, now(), 'openalex', ${`10.1234/abstract.${T}`})`;

  config.abstractTranslationEnabled = false;
  const disabled = await translateAbstracts({ limit: 1 });
  assert.deepEqual(disabled, []);
  const [waiting] = await sql<{ status: string; attempts: number }[]>`
    SELECT status, attempts FROM abstract_translations WHERE article_id=${articleId}`;
  assert.equal(waiting, undefined, "disabled abstract translation does not even reserve a row");
  config.abstractTranslationEnabled = true;

  const first = await translateAbstracts({ limit: 1 });
  assert.deepEqual(first.map((r) => r.status), ["translated"]);
  assert.equal(provider.hits(), 1);
  const [saved] = await sql<{ revision: number; status: string; attempts: number; source_hash: string; text_zh: string; receipt_id: number }[]>`
    SELECT revision, status, attempts, source_hash, text_zh, receipt_id FROM abstract_translations WHERE article_id=${articleId}`;
  assert.deepEqual({ revision: saved!.revision, status: saved!.status, attempts: saved!.attempts, text: saved!.text_zh }, {
    revision: article!.revision,
    status: "translated",
    attempts: 1,
    text: TRANSLATION,
  });
  assert.equal(saved!.source_hash, abstractSourceHash(ABSTRACT));
  assert.ok(saved!.receipt_id);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${saved!.receipt_id}`).at(0)?.status, "completed");

  const second = await translateAbstracts({ limit: 1 });
  assert.deepEqual(second, []);
  assert.equal(provider.hits(), 1, "a completed abstract reuses the stored result without a second model call");
});


test("a metadata lookup does not expose news or WeChat as a paper abstract", async () => {
  for (const [suffix, kind, tags] of [["news", "rss", ["新闻"]], ["wechat", "mp_account", ["期刊"]], ["journal", "rss", ["期刊"]]] as const) {
    const sourceId = `${SOURCE}-${suffix}`;
    await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, tags, next_fetch_at, interval_minutes)
      VALUES (${sourceId}, ${suffix}, ${kind}, 'T1', 'editorial', ${[...tags]}, '2100-01-01', 1440)`;
    const { articleId } = await upsertMaterial({ sourceId, url: `https://example.com/${T}/${suffix}`, title: suffix, excerpt: ABSTRACT, via: "fetch" });
    const [a] = await sql`SELECT revision FROM articles WHERE id=${articleId}`;
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
      VALUES (${articleId}, ${a!.revision}, 'rule', 'pass', 'research', '标题', '导读', '理由', 90, true)`;
    await sql`INSERT INTO abstract_lookups (article_id, found_at, provider) VALUES (${articleId}, now(), 'crossref')`;
    await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
    const result = await loadItemDetail(articleId);
    assert.equal(result.kind, "found");
    if (result.kind === "found") assert.equal(!!result.detail.abstract, suffix === "journal");
  }
});
