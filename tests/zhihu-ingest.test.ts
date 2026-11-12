import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { zhihuSignal, mergeZhihuSignals } from "@aihot/backend/ingest/zhihu";

const answer = {
  content_id: "456", content_type: "answer", question_id: "123",
  content_url: "https://www.zhihu.com/question/123/answer/456?utm_source=share",
  title: "讨论研究", content_text: "正文中分享了研究。", created_time: 1_792_000_000,
  creator_hash: "0123456789abcdef", user_nickname: "已***敏",
};

test("Zhihu signals retain cited links, clean HTML and identify participants by creator", () => {
  const signal = zhihuSignal({ ...answer, content_text: '<p>论文讨论<a href="https://link.zhihu.com/?target=https%3A%2F%2Fdoi.org%2F10.1038%2Fexample">原文</a></p><script>bad()</script>', content_links: ["https://doi.org/10.1038/example"], cookies: "do-not-copy", voteup_count: 99 });
  assert.ok(signal);
  assert.equal(signal.sourceId, "mc-zhihu-0123456789abcdef");
  assert.equal(signal.item.url, "https://www.zhihu.com/question/123/answer/456");
  assert.ok(signal.item.bodyText.includes("https://doi.org/10.1038/example"));
  assert.ok(!signal.item.bodyText.includes("bad()"));
  assert.ok(!JSON.stringify(signal).includes("do-not-copy"));
  assert.ok(!JSON.stringify(signal).includes("已***敏"));
  assert.equal(signal.item.publishedAt, new Date(answer.created_time * 1000).toISOString());
  assert.equal(zhihuSignal({ ...answer, content_id: "789", content_url: "https://www.zhihu.com/question/123/answer/789" })?.sourceId, signal.sourceId);
});

test("articles and older exports without content_links remain usable; video and malformed records are skipped", () => {
  const article = zhihuSignal({ ...answer, content_type: "article", content_url: "https://zhuanlan.zhihu.com/p/456", content_text: "分享论文 https://doi.org/10.9999/example" });
  assert.ok(article?.item.bodyText.includes("https://doi.org/10.9999/example"));
  for (const patch of [{ content_type: "zvideo" }, { content_text: "", desc: "" }, { creator_hash: "" }, { created_time: 0 }, { content_url: "https://example.com/456" }, { content_url: "https://zhuanlan.zhihu.com/p/999" }, { content_url: "https://www.zhihu.com/question/999/answer/456" }, { content_url: "https://user:secret@www.zhihu.com/question/123/answer/456" }, { content_url: "https://www.zhihu.com:8443/question/123/answer/456" }]) {
    assert.equal(zhihuSignal({ ...answer, ...patch }), null);
  }
});

test("repeated search rows preserve the full text and paper links independent of file order", () => {
  const full = zhihuSignal({ ...answer, updated_time: 10, content_text: "完整研究讨论。".repeat(20), content_links: ["https://doi.org/10.9999/example"] })!;
  const snippet = zhihuSignal({ ...answer, updated_time: 10, content_text: "研究讨论" })!;
  assert.deepEqual(mergeZhihuSignals(full, snippet), mergeZhihuSignals(snippet, full));
  assert.ok(mergeZhihuSignals(full, snippet).item.bodyText.includes("https://doi.org/10.9999/example"));
  const revised = zhihuSignal({ ...answer, updated_time: 20, content_text: "新版明确删除旧引用" })!;
  assert.deepEqual(mergeZhihuSignals(full, revised), revised, "a newer actual revision wins over old length and references");
  const linkHeavy = zhihuSignal({ ...answer, updated_time: 10, content_text: "短讨论", content_links: Array.from({ length: 5 }, (_, i) => `https://example.org/${i}/${'x'.repeat(100)}`) })!;
  assert.ok(mergeZhihuSignals(full, linkHeavy).item.bodyText.startsWith(full.contentText), "appended URLs do not make a snippet more complete");
  assert.throws(() => mergeZhihuSignals(full, zhihuSignal({ ...answer, question_id: "999", content_url: "https://www.zhihu.com/question/999/answer/456" })!), /identity/);
});

test("Zhihu tracking parameters and rejected protocols never enter link evidence", () => {
  const signal = zhihuSignal({ ...answer, content_links: ["javascript:bad()", "https://doi.org/10.9999/example?utm_source=zhihu", "https://doi.org/10.9999/example", "https://link.zhihu.com/?target=javascript%3Abad()"] });
  assert.ok(signal);
  assert.deepEqual(signal.item.raw.links, ["https://doi.org/10.9999/example"]);
});
