// Source candidates from DeepSeek Search, paid per call (the discovery share of its budget): each
// query is searched once a day, and the sites and WeChat accounts that answered are listed by how many
// queries found them and how recent their pages are. Sites and accounts already among the sources are
// left out. It only prints a list for the owner to review; nothing is written.
// node --env-file=.env scripts/discover-web-sources.ts ["查询" ...] [--days 30] [--out report.md]
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { deepseekSearch, type WebSearchResult } from "@aihot/backend/providers/deepseek-tools";
import { siteOf, webParticipant } from "@aihot/backend/events/web-lookup";

const DEFAULT_QUERIES = [
  "心理学 最新研究", "精神医学 研究 进展", "心理健康 政策 2026", "心理咨询 行业", "数字心理健康 AI 心理",
  "认知神经科学 新发现", "发展心理学 研究", "临床心理 指南", "精神科 新药 获批", "心理学 学术会议 2026",
  "psychology new study", "psychiatry research news", "mental health policy", "neuroscience discovery psychology",
];

const { values, positionals } = parseArgs({ allowPositionals: true, options: { days: { type: "string", default: "30" }, out: { type: "string" } } });
const queries = positionals.length ? positionals : DEFAULT_QUERIES;
const since = Date.now() - Number(values.days) * 24 * 3600 * 1000;
const day = new Date().toISOString().slice(0, 10);

interface Seen { participant: string; queries: Set<string>; pages: WebSearchResult[] }
const seen = new Map<string, Seen>();
try {
  const known = await sql<{ url: string | null; biz: string | null }[]>`SELECT config->>'url' AS url, config->>'wechatBiz' AS biz FROM sources`;
  const knownSites = new Set(known.flatMap((k) => (k.url ? [siteOf(k.url.replace(/^https:\/\/r\.jina\.ai\//, ""))] : [])).filter(Boolean));
  const knownBiz = new Set(known.flatMap((k) => (k.biz ? [`wechat:${k.biz}`] : [])));
  for (const query of queries) {
    const { results } = await deepseekSearch(query, { purpose: "source_discovery", subject: "ops:web-discovery", count: 50, window: day, pool: "deepseek-tools:discovery" });
    for (const r of results) {
      const participant = webParticipant(r.url);
      if (!participant || knownBiz.has(participant) || knownSites.has(siteOf(r.url))) continue;
      if (r.date && r.date.getTime() < since) continue;
      const s = seen.get(participant) ?? { participant, queries: new Set(), pages: [] };
      s.queries.add(query);
      s.pages.push(r);
      seen.set(participant, s);
    }
  }
} finally {
  await closeDb();
}

const ranked = [...seen.values()].sort((a, b) => b.queries.size - a.queries.size || b.pages.length - a.pages.length);
const lines = [`# 信源候选（DeepSeek 搜索，${day}，近 ${values.days} 天）`, "", `查询 ${queries.length} 条；已排除现有信源。`, "",
  "| 站点或公众号 | 命中查询 | 网页 | 最新 | 权威度 | 例子 |", "|---|---|---|---|---|---|"];
for (const s of ranked) {
  const newest = s.pages.map((p) => p.date?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
  const authority = Math.max(...s.pages.map((p) => p.authority ?? -1));
  const name = (s.pages.find((p) => p.siteName)?.siteName ?? "").replace(/\|/g, "/");
  const example = s.pages[0]!;
  lines.push(`| ${s.participant} ${name} | ${s.queries.size} | ${s.pages.length} | ${newest ? new Date(newest).toISOString().slice(0, 10) : "?"} | ${authority} | [${example.title.replace(/\|/g, "/").slice(0, 40)}](${example.url}) |`);
}
const report = lines.join("\n") + "\n";
if (values.out) writeFileSync(values.out, report);
console.log(report);
