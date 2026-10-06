import { useEffect, useState, type ReactNode } from "react";
import { Link, useLoaderData, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/agent";
import { SITE, withSubject } from "@aihot/industry/site";
import { FEATURES } from "@aihot/industry/features";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { MCP_TOOL_NAMES as T } from "@aihot/contracts/mcp";
import { SKILL_NAME, SKILL_PATH, SKILL_VERSION } from "@aihot/contracts/skill";
import { listPath, pageMeta, siteUrl } from "../lib/seo";
import { CodeBlock, CopyButton } from "../components/CodeBlock";
import { IconArrowUpRight, IconChevronRight } from "../components/icons";
import { AsideCard, ReadingLayout } from "../components/ui/Page";
import { PillTabs } from "../components/ui/Tabs";

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

const MCP_VERSION = "2.0.0";
/** The machine-readable entry points, with what each one is for. */
const RESOURCES: Array<[label: string, href: string, note: string]> = [
  ["llms.txt", "/llms.txt", "给大模型读的站点说明"],
  ["Agent 使用说明", "/api/v1/agent", "Agent 读了就能查，Skill 用的也是它"],
  ["Skill 完整包", `${SKILL_PATH}/README.md`, `安装说明与全部文件 · ${SKILL_VERSION}`],
  ["MCP Server", "/api/mcp", "MCP 客户端的连接地址"],
  ["OpenAPI 3.1", "/openapi-v1.json", "REST API v1 的完整定义"],
];

const TABS = [
  { key: "skill", label: "Agent Skill" },
  { key: "mcp", label: "MCP" },
  { key: "rss", label: "RSS" },
  { key: "api", label: "REST API" },
] as const;
type TabKey = (typeof TABS)[number]["key"];
/** The first tab is the default and is not written in the address. */
const DEFAULT_TAB: TabKey = "skill";

export async function loader({ request }: Route.LoaderArgs) {
  const tab = new URL(request.url).searchParams.get("tab");
  let healthy = true;
  try {
    const res = await fetch(`${process.env.API_BASE_URL || "http://127.0.0.1:3001"}/api/health`, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(3000)]) });
    healthy = res.ok;
  } catch {
    healthy = false;
  }
  // The public address the examples show is the configured one, the same on the server and in the browser.
  return { tab: (TABS.some((t) => t.key === tab) ? tab : DEFAULT_TAB) as TabKey, healthy, base: siteUrl() };
}

export function meta({ loaderData }: Route.MetaArgs) {
  // Only the tab is part of the address (the default is not written).
  const path = listPath("/agent", { tab: loaderData && loaderData.tab !== DEFAULT_TAB ? loaderData.tab : null });
  return pageMeta({ title: "Agent 接入", description: `把 ${SITE.name} 接进你的 Agent：Agent Skill、MCP、RSS、REST API 四种方式，匿名只读，无需 API Key。`, path, image: "/og/pages/agent.png" });
}

function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="mt-10 scroll-mt-24">
      <h3 className="mb-3 text-[16px] font-bold text-ink">{title}</h3>
      <div className="text-[13.5px] leading-[1.85] text-ink-2">{children}</div>
    </section>
  );
}

function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2"><span className="mt-[11px] size-1 shrink-0 rounded-full bg-ink-4" /><span>{it}</span></li>
      ))}
    </ul>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="mono rounded-mark bg-bg-sunk px-1.5 py-0.5 text-[0.88em] text-ink">{children}</code>;
}

/** Questions the Skill should answer well; each can be copied as is. */
const ASK = [
  "最近一周最值得关注的 5 项心理学研究是什么？",
  "现在心理学界最受关注的研究是哪些？",
  "给我今天的心理学日报。",
  "这周心理学有哪些重要进展？",
  "抑郁症最近有什么新研究？",
  "AI 心理咨询最近有什么进展？",
  "热点榜第一的那项研究，来龙去脉是什么？",
];

function Step({ no, title, children }: { no: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3.5">
      <span className="num mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent">{no}</span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
        <div className="mt-1.5 text-[13.5px] leading-[1.8] text-ink-3">{children}</div>
      </div>
    </li>
  );
}

function SkillTab({ base }: { base: string }) {
  const pkg = `${base}${SKILL_PATH}`;
  const install = `请安装 ${SITE.name} Skill：${pkg}/README.md\n装完告诉我是否需要开启新会话。`;
  const update = `请把我已安装的 ${SITE.name} Skill 更新到最新版：${pkg}/README.md\n先告诉我它现在装在哪个目录、是否存在重复副本，再替换同一目录。`;
  return (
    <>
      <h2 className="text-[20px] font-bold text-ink">装一次，以后不用再更新</h2>
      <p className="mt-2 text-[14.5px] text-ink-3">
        不用记接口，也不用写代码。适合 Claude Code、Codex、Gemini CLI、OpenCode 这类支持 Agent Skills 的工具。查什么、怎么整理都在 {SITE.name} 这边完成，Skill 只负责提问和转述；{SITE.name} 以后新增的能力，装好的 Skill 会自动用上。
      </p>

      <ol className="mt-7 space-y-6">
        <Step no={1} title="把这段话发给你的 Agent">
          <p>它会先审阅安装说明，再逐个文件核对校验值；目录里是别的 Skill 时不会覆盖。</p>
          <CodeBlock title="安装提示词" lang="text" code={install} />
        </Step>
        <Step no={2} title="开一个新会话">
          多数 Agent 只在会话开始时读取 Skill，当前对话里不一定看得到。
        </Step>
        <Step no={3} title="问一句试试">
          <div className="mt-2 flex items-center gap-2 rounded-card border border-line bg-surface p-3">
            <span className="min-w-0 flex-1 text-[14px] text-ink">过去 24 小时心理学领域最重要的 5 件事是什么？</span>
            <CopyButton text="过去 24 小时心理学领域最重要的 5 件事是什么？" className="!text-ink-3" />
          </div>
          <p className="mt-2">回答注明了时间范围、给出中文摘要、标题链到 {SITE.name}，就是装好了。</p>
        </Step>
      </ol>

      <Section title="装好后可以这样问">
        <div className="space-y-2">
          {ASK.map((q) => (
            <div key={q} className="flex items-center gap-2 rounded-card border border-line bg-surface px-3 py-2">
              <span className="min-w-0 flex-1 text-[13.5px] text-ink-2">{q}</span>
              <CopyButton text={q} className="!text-ink-3" />
            </div>
          ))}
        </div>
      </Section>

      <Section title="用命令行安装" id="agent-skill-cli">
        <p>适用于 macOS、Linux 与 WSL。安装器先下载完整包、逐个文件核对 SHA-256，全部通过才替换目标目录；再运行一次就是更新。</p>
        <CodeBlock lang="bash" code={`# Claude Code（装到通用目录，再建一个 ~/.claude/skills/${SKILL_NAME} 软链）\nbash <(curl -fsSL ${pkg}/install.sh) --target claude\n# Codex、Gemini CLI、OpenCode 等（~/.agents/skills/${SKILL_NAME}）\nbash <(curl -fsSL ${pkg}/install.sh) --target agents`} />
        <p>Windows 原生环境不要粘贴 Bash 命令：按 <a href={`${SKILL_PATH}/manifest.sha256`} className="text-accent hover:underline">安装包清单</a> 下载 3 个文件，核对校验值后放进 skills 目录下的 <Mono>{SKILL_NAME}</Mono> 文件夹。安装前可以先看 <a href={`${SKILL_PATH}/SKILL.md`} className="text-accent hover:underline">SKILL.md</a> 和 <a href={`${SKILL_PATH}/install.sh`} className="text-accent hover:underline">install.sh</a>。</p>
      </Section>

      <Section title="没触发？按这个顺序查">
        <Bullets items={[
          "开一个新会话再问；问题里带上“心理学”“研究”“日报”这类词更容易触发。",
          <>让 Agent 列出它发现的 skills，确认有、且只有一份 <Mono>{SKILL_NAME}</Mono>。</>,
          "Agent 说不能联网时，打开它的联网或命令行权限；查询只会访问本站。",
          <>想重装或更新，把这段话发给它：</>,
        ]} />
        <CodeBlock title="更新提示词" lang="text" code={update} />
      </Section>

      <Section title="不装 Skill 也能用">
        <Bullets items={[
          <>让 Agent 读 <a href="/api/v1/agent" className="text-accent hover:underline">{base}/api/v1/agent</a>，按里面的说明查询，结果和 Skill 一样。</>,
          <>支持远程 MCP 的客户端，接 <Mono>{`${base}/api/mcp`}</Mono>（见 MCP 页签）。</>,
        ]} />
      </Section>

      <Section title="目前做不到的">
        <Bullets items={[
          "超过 7 天的历史搜索。",
          "单篇文章全文：回答给出站内阅读页和原文链接，重要数字和结论请回原文核对。",
          "心理评估、诊断或用药建议：这里只有研究与行业资讯。遇到危机，请拨打 120／110 或全国心理援助热线 12356。",
        ]} />
      </Section>
    </>
  );
}

function McpTab({ base }: { base: string }) {
  const url = `${base}/api/mcp`;
  const name = SITE.mcpPrefix;
  return (
    <>
      <h2 className="text-[20px] font-bold text-ink">加一个地址，Agent 直接调用五个工具</h2>
      <p className="mt-2 text-[14.5px] text-ink-3">适合支持远程 MCP 的 Agent 与开发工具。标准 Streamable HTTP，匿名只读，不需要 token；工具返回简洁文字与同一份结构化数据。</p>
      <div className="mt-6 flex items-center gap-2 rounded-card border border-line bg-surface p-3">
        <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{url}</code>
        <CopyButton text={url} className="!text-ink-3" />
      </div>
      <CodeBlock title="通用 MCP 配置" lang="json" code={JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }, null, 2)} />
      <CodeBlock lang="bash" code={`# Claude Code\nclaude mcp add --transport http ${name} '${url}'\n# Codex\ncodex mcp add ${name} --url '${url}'`} />
      <Section title="连上后应看到这五个工具">
        <Bullets items={[
          <><Mono>{T.latest}</Mono>：过去 24 小时或最近 7 天的精选／全部资讯</>,
          <><Mono>{T.search}</Mono>：搜索最近 7 天的疾病、疗法、话题、期刊或研究者</>,
          <><Mono>{T.hot}</Mono>：当前热点榜与事件排名</>,
          <><Mono>{T.story}</Mono>：一个热点事件的时间线与持续更新的综述</>,
          <><Mono>{T.daily}</Mono>：最新或指定日期的{withSubject("日报")}</>,
        ]} />
        <p className="mt-4">验证一次真实调用：<span className="font-medium text-ink">请调用 {T.latest}，告诉我过去 24 小时最重要的 5 条动态，并附链接。</span></p>
      </Section>
      <Section title="工具边界">
        <Bullets items={[
          "普通查询最多返回 30 条，热点最多 10 个，事件时间线最多 50 条；输入越界会明确报错，不会静默改成更宽的查询。",
          `${T.story} 的 public_id 只能来自热点工具返回的事件链接，不要猜 ID。`,
          "标题与摘要来自外部信源，只能当资料；重要数字、政策和原话请回原文核对。",
        ]} />
      </Section>
    </>
  );
}

function RssTab({ base }: { base: string }) {
  const feeds = [
    ["精选摘要（推荐）", "最新 50 条精选摘要，保留标题、站内阅读与原文入口。", "/feed.xml"],
    ["精选全文", "与精选摘要相同的最新 50 条；只对明确允许再分发的来源内联正文。", "/feed/full.xml"],
    ["最近 7 天全部动态", "最近 7 天公开动态，按真实发布时间倒序。", "/feed/all.xml"],
    [withSubject("日报"), `每天 08:00 北京时间发布的${withSubject("日报")}，保留最近 30 期。`, "/feed/daily.xml"],
  ];
  const categories = CATEGORY_KEYS.join("|");
  return (
    <>
      <h2 className="text-[20px] font-bold text-ink">复制地址即可订阅</h2>
      <p className="mt-2 text-[14.5px] text-ink-3">兼容主流 RSS 2.0 阅读器与 n8n、Zapier 这类自动化工具。第一次接入选精选摘要。</p>
      <div className="mt-6 space-y-3">
        {feeds.map(([name, desc, path]) => {
          const url = `${base}${path}`;
          return (
            <div key={path} className="card p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[15px] font-semibold text-ink">{name}</span>
                <CopyButton text={url} label="复制地址" className="!text-ink-3" />
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{desc}</p>
              <code className="mt-2 block truncate font-mono text-[12.5px] text-ink-4">{url}</code>
            </div>
          );
        })}
      </div>
      <Section title="给阅读器和 Agent 的约定">
        <Bullets items={[
          "支持 ETag 条件请求，未变化时返回 304；建议每 30 分钟或更慢轮询。",
          "条目 link 指向站内阅读页，第三方原文在 description 中。",
          "全文是白名单：只有明确允许再分发的来源内联 content:encoded，其余一律只给摘要。",
          <>分类订阅 <Mono>{`/feed/category/{${categories}}.xml`}</Mono></>,
          <>分类全文 <Mono>{`/feed/full/category/{${categories}}.xml`}</Mono></>,
        ]} />
      </Section>
    </>
  );
}

function ApiTab({ base }: { base: string }) {
  const endpoints: Array<[string, string]> = [
    ["/api/v1/items", "精选或最近 7 天公开动态；支持分类、时间和关键词"],
    ...(FEATURES.codexResetMonitor
      ? ([
          ["/api/v1/codex-resets/recent", "Codex 重置监控（轮询用）：最近 7 天与尚未落地的预告"],
          ["/api/v1/codex-resets", "Codex 重置与发卡的完整历史"],
        ] as Array<[string, string]>)
      : []),
    ["/api/v1/hot-topics", "当前热点榜与事件排名"],
    ["/api/v1/stories/{publicId}", "事件详情：报道时间线、综述与关联事件"],
    ["/api/v1/dailies", `${withSubject("日报")}日期索引`],
    ["/api/v1/dailies/latest", `最新${withSubject("日报")}`],
    ["/api/v1/dailies/{date}", `指定日期的${withSubject("日报")}`],
    ["/api/v1/selected/snapshot", "当前全部精选；首次完整同步（分页）"],
    ["/api/v1/selected/changes", "精选的新增、修改和撤选；之后只取变化"],
  ];
  return (
    <>
      <h2 className="text-[20px] font-bold text-ink">匿名 GET，不需要 token</h2>
      <p className="mt-2 text-[14.5px] text-ink-3">浏览器跨域、curl 和默认 HTTP SDK 都可以直接用。临时查最近内容用 items；长期维护全部精选用一次快照加增量游标。字段与错误码以 <a href="/openapi-v1.json" className="text-accent hover:underline">OpenAPI 3.1</a> 为准。</p>
      <CodeBlock title="第一个请求" lang="bash" code={`curl '${base}/api/v1/items?mode=selected&window=24h&limit=20'`} />
      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full min-w-[560px] text-left text-[13.5px]">
          <thead className="bg-bg-sunk text-ink-3"><tr><th className="px-3 py-2 font-medium">方法</th><th className="px-3 py-2 font-medium">路径</th><th className="px-3 py-2 font-medium">说明</th></tr></thead>
          <tbody className="divide-y divide-line">
            {endpoints.map(([p, d]) => (
              <tr key={p}><td className="px-3 py-2 font-mono text-[12px] text-ok">GET</td><td className="px-3 py-2 font-mono text-[12.5px] text-ink">{p}</td><td className="px-3 py-2 text-ink-2">{d}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <Section title="先知道这几件事">
        <Bullets items={[
          "不传 mode 等同 selected（精选）；只有明确需要全部公开动态才用 all。",
          "完整精选不限 7 天：snapshot 首次拿全，changes 只取变化；items 只看最近 7 天。",
          "items 不带正文：返回摘要、推荐理由、站内阅读页与原文链接。",
          "没有推送通道：按响应的 s-maxage 带 If-None-Match 轮询，没变化时是 304。",
          "错误是 Problem JSON；反馈时附上 requestId 即可定位。",
        ]} />
      </Section>
      <Section title="维护全部精选：一次快照，之后只拉变化">
        <CodeBlock lang="bash" code={`# 首次：分页拿当前全部精选，保存第一页响应里的 cursor（逐页相同）\ncurl '${base}/api/v1/selected/snapshot?fields=minimal&limit=500'\n# hasMore 为 true 就带 nextPage 继续翻\ncurl '${base}/api/v1/selected/snapshot?fields=minimal&limit=500&page=<上一页的 nextPage>'\n# 翻完之后：原样回传 cursor，只拿新增、修改和撤选\ncurl '${base}/api/v1/selected/changes?cursor=<第一页响应的 cursor>&limit=100'`} />
        <p>每页成功应用后再保存新 cursor。返回 409 snapshot_required 时重新取一次快照即可，接口不会静默漏数。</p>
      </Section>
      <Section title="错误与恢复" id="agent-api-recovery">
        <Bullets items={[
          "400：参数不合法；按 OpenAPI 修正，不要自动改成更宽的查询。",
          "409 snapshot_required：增量游标无法安全续传，重新取一次完整快照。",
          "429：遵守 Retry-After，不要增加并发重试。",
          "5xx：指数退避，并使用上次成功的缓存。",
        ]} />
      </Section>
    </>
  );
}

export default function AgentPage() {
  const { tab: initialTab, healthy, base } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>(initialTab);

  useEffect(() => setTab((params.get("tab") as TabKey) || DEFAULT_TAB), [params]);

  const select = (key: TabKey) => {
    setTab(key);
    navigate(key === DEFAULT_TAB ? "/agent" : `/agent?tab=${key}`, { replace: true, preventScrollReset: true });
  };

  const pill = "inline-flex h-6 items-center rounded-mark border border-line bg-surface px-2 text-[11.5px] text-ink-3";
  const aside = (
    <>
      <AsideCard title="接入资源" className="hidden lg:block">
        <nav aria-label="接入资源" className="-mx-2 -mb-1">
          {RESOURCES.map(([l, h, note]) => (
            <a key={h} href={h} className="group flex items-start gap-2 rounded-control px-2 py-2 transition-colors hover:bg-bg-sunk">
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] text-ink-2 group-hover:text-ink">{l}</span>
                <span className="mt-0.5 block text-[12px] text-ink-4">{note}</span>
              </span>
              <IconArrowUpRight size={13} className="mt-1 shrink-0 text-ink-4" />
            </a>
          ))}
        </nav>
      </AsideCard>
      <AsideCard title="没接上？">
        <p className="text-[13px] leading-[1.75] text-ink-3">把客户端、版本和报错写在反馈页，别发 token 或本地文件。</p>
        <Link to="/feedback" prefetch="intent" className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
          去反馈 <IconChevronRight size={14} />
        </Link>
      </AsideCard>
    </>
  );
  return (
    <ReadingLayout aside={aside}>
      <header>
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">让 Agent 直接使用 {SITE.name}</h1>
        <p className="mt-1.5 text-[13px] text-ink-3">Agent Skill、MCP、RSS、REST API 四种方式读的是同一份数据：精选、热点、日报、周报和月报，按你用的工具选一种就行。全部匿名只读，不用注册，也不用 API Key。</p>
        <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
          <span className={pill}>匿名只读</span>
          <span className={`${pill} mono`}>API v1</span>
          <span className={`${pill} mono`}>Skill {SKILL_VERSION}</span>
          <span className={`${pill} mono`}>MCP {MCP_VERSION}</span>
          <span className={`${pill} gap-1.5 ${healthy ? "text-ok" : "text-hot"}`}>
            <span className={`size-1.5 rounded-full ${healthy ? "bg-ok" : "bg-hot"}`} />
            {healthy ? "服务正常" : "服务异常"}
          </span>
        </div>
      </header>

      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px] lg:hidden">
        {RESOURCES.map(([l, h]) => (
          <a key={h} href={h} className="inline-flex items-center gap-1 text-ink-2 transition-colors hover:text-accent">
            {l} <IconArrowUpRight size={12} className="text-ink-4" />
          </a>
        ))}
      </div>

      <div className="sticky top-0 z-20 -mx-4 mt-7 bg-bg/90 px-4 py-2 backdrop-blur-md lg:mx-0 lg:px-0">
        <PillTabs layoutId="agent-tab" label="接入方式" active={tab} onSelect={(k: string) => select(k as TabKey)} items={TABS.map((t) => ({ key: t.key, label: t.label }))} />
      </div>

      <div className="mt-7" role="tabpanel">
        {tab === "skill" && <SkillTab base={base} />}
        {tab === "mcp" && <McpTab base={base} />}
        {tab === "rss" && <RssTab base={base} />}
        {tab === "api" && <ApiTab base={base} />}
      </div>
    </ReadingLayout>
  );
}
