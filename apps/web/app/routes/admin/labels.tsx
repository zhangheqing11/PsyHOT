import { SITE } from "@aihot/industry/site";
import { Link, useSearchParams } from "react-router";
import { CATEGORY_NAMES } from "@aihot/contracts/taxonomy";
import type { Route } from "./+types/labels";
import { adminGet } from "../../lib/admin.server";
import { num } from "../../features/admin/format";
import { TRACK_LABEL } from "../../features/admin/labels";
import { LABEL_DECISIONS, LabelButtons } from "../../features/admin/LabelButtons";
import { AdminPage, Badge, Card, Empty, FilterChips, Pager, Stat, Time } from "../../features/admin/ui";

interface Row {
  id: string;
  queue: string;
  split: string;
  decision: string | null;
  note: string | null;
  queued_at: string;
  labeled_at: string | null;
  title: string;
  original_title: string;
  summary: string | null;
  url: string;
  published_at: string | null;
  source: string;
  tier: string;
  track: string | null;
  category: string | null;
  score: string | null;
  threshold: string | null;
  selected: boolean | null;
  promotion: boolean;
  relevance: string | null;
  prefilter_reason: string | null;
}

interface LabelsData {
  page: number;
  rows: Row[];
  totals: Array<{ queue: string; track: string | null; decision: string | null; n: number }>;
}

const QUEUE_LABEL: Record<string, string> = { sample: "抽样", promotion: "推广复核", blocked: "预筛拦截", near_threshold: "门槛附近", manual: "手动" };
const DECISION_LABEL: Record<string, string> = Object.fromEntries(LABEL_DECISIONS);

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return adminGet<LabelsData>(request, `/api/admin/labels${url.search}`);
}

export const meta: Route.MetaFunction = () => [{ title: `标注 · ${SITE.name} 后台` }];

export default function Labels({ loaderData }: Route.ComponentProps) {
  const { rows, totals, page } = loaderData;
  const [sp] = useSearchParams();
  const labeled = sp.get("status") === "labeled";
  const sum = (test: (t: LabelsData["totals"][number]) => boolean) => totals.filter(test).reduce((n, t) => n + t.n, 0);
  return (
    <AdminPage
      title="标注"
      subtitle="逐条判断该不该进精选。标注攒够以后导出成 gold.jsonl，用 scripts/eval-selection.ts 校准学界、业界各自的门槛（docs/selection.md）。"
      actions={<a className="text-[13px] text-accent hover:underline" href="/api/admin/labels/export">导出 gold.jsonl</a>}
    >
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="待标注" value={num(sum((t) => !t.decision))} />
        <Stat label="已标注" value={num(sum((t) => !!t.decision))} />
        <Stat label="学界已标" value={num(sum((t) => !!t.decision && t.track === "academic"))} />
        <Stat label="业界已标" value={num(sum((t) => !!t.decision && t.track === "industry"))} />
        <Stat label="该选 / 不该选 / 两可" value={`${sum((t) => t.decision === "select")} / ${sum((t) => t.decision === "reject")} / ${sum((t) => t.decision === "either")}`} />
      </div>
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
          <FilterChips param="status" options={[{ value: "", label: "待标注" }, { value: "labeled", label: "已标注" }]} />
          <FilterChips param="track" options={[{ value: "", label: "全部视角" }, { value: "academic", label: "学界" }, { value: "industry", label: "业界" }]} />
          <FilterChips param="queue" options={[{ value: "", label: "全部来源" }, ...Object.entries(QUEUE_LABEL).map(([value, label]) => ({ value, label }))]} />
        </div>
        {rows.length === 0 ? (
          <div className="p-6"><Empty>{labeled ? "还没有标注。" : "队列是空的。用 scripts/sample-labels.ts 抽一批，或在内容详情页直接标。"}</Empty></div>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 p-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-4">
                    <span>{r.source}</span>
                    <Badge tone="info">{r.tier.replace("_", ".")}</Badge>
                    {r.track && <Badge>{TRACK_LABEL[r.track]}</Badge>}
                    {r.category && <Badge>{CATEGORY_NAMES[r.category as keyof typeof CATEGORY_NAMES] ?? r.category}</Badge>}
                    {r.selected && <Badge tone="accent">已入选</Badge>}
                    {r.promotion && <Badge tone="warn">推广</Badge>}
                    {r.relevance === "block" && <Badge tone="bad" title={r.prefilter_reason ?? undefined}>预筛拦截{r.prefilter_reason ? `：${r.prefilter_reason}` : ""}</Badge>}
                    {r.score !== null && <span className="num">分数 {Math.round(Number(r.score))}{r.threshold !== null ? ` / 门槛 ${Number(r.threshold)}` : ""}</span>}
                    <span>· {QUEUE_LABEL[r.queue] ?? r.queue}</span>
                    {r.split === "holdout" && <span>· 留出集</span>}
                  </div>
                  <Link to={`/admin/content/${r.id}`} className="mt-1 block font-medium text-ink hover:text-accent">{r.title}</Link>
                  {r.title !== r.original_title && <div className="text-[12.5px] text-ink-4">{r.original_title}</div>}
                  {r.summary && <p className="mt-1 line-clamp-3 text-[13px] text-ink-3">{r.summary}</p>}
                  <div className="mt-1 flex gap-3 text-[12px] text-ink-4">
                    <a href={r.url} target="_blank" rel="noreferrer" className="hover:text-accent">原文</a>
                    <Time at={r.published_at} />
                    {r.labeled_at && <span>标注于 <Time at={r.labeled_at} /> · {DECISION_LABEL[r.decision!]}</span>}
                  </div>
                </div>
                <div className="shrink-0 pt-1"><LabelButtons id={r.id} decision={r.decision} size="sm" /></div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Pager page={page} hasMore={rows.length === 50} />
    </AdminPage>
  );
}
