import { SITE } from "@aihot/industry/site";
import { Link, useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/wechat";
import type { PoolResponse } from "@aihot/contracts/site";
import { isCategoryKey, isTrackKey, type CategoryKey } from "@aihot/contracts/taxonomy";
import { loadOr404, queryString } from "../lib/api.server";
import { listPath, pageMeta } from "../lib/seo";
import { PillTabs } from "../components/ui/Tabs";
import { DayList, Pagination } from "../features/feed/DayList";
import { CategoryTabs, SearchField, TagTabs, TrackTabs } from "../features/feed/Filters";
import { EmptyState } from "../components/ui/Page";

// These categories have enough real public WeChat coverage to be useful as a first filter.
// Low-signal categories stay out of this page until the corpus grows and is reviewed again.
const WECHAT_CATEGORY_KEYS: readonly CategoryKey[] = ["research", "review", "clinical", "method", "opinion", "industry", "profession"];
const WECHAT_TOPIC_TAGS = [
  "临床", "生理/神经", "儿童青少年", "抑郁", "焦虑", "睡眠", "心理治疗", "精神药物", "认知", "社会",
] as const;

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim().slice(0, 200) || null;
  const tab = url.searchParams.get("tab") === "relevance" ? "relevance" : null;
  const categoryParam = url.searchParams.get("category");
  const category = categoryParam && isCategoryKey(categoryParam) ? categoryParam : null;
  const trackParam = url.searchParams.get("track");
  const track = trackParam && isTrackKey(trackParam) ? trackParam : null;
  const tag = url.searchParams.get("tag")?.trim() || null;
  const page = Math.min(Math.max(Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1), 50);
  const data = await loadOr404<PoolResponse>(
    `/api/site/pool${queryString({ source: "wechat", category, track, tag, q, tab, page: page > 1 ? page : null })}`,
    { signal: request.signal, busyRedirect: "/all/search-busy" },
  );
  return { data };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const f = loaderData?.data.filters;
  const q = f?.q;
  const page = loaderData?.data.page ?? 1;
  return pageMeta({
    title: q ? `公众号搜索：${q}` : f?.tag ? `公众号：${f.tag}` : "公众号",
    description: `${SITE.name} 已核验固定公众号的公开文章。`,
    path: listPath("/wechat", { category: f?.category, track: f?.track, tag: f?.tag, q, tab: f?.tab === "relevance" ? "relevance" : null, page: page > 1 ? page : null }),
    noindex: !!q,
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=30" };
}

function pageHref(params: URLSearchParams, page: number) {
  const sp = new URLSearchParams(params);
  sp.delete("source");
  sp.delete("deep");
  sp.delete("anchorAt");
  sp.delete("search");
  if (page <= 1) sp.delete("page");
  else sp.set("page", String(page));
  const s = sp.toString();
  return s ? `/wechat?${s}` : "/wechat";
}

export default function WechatPage() {
  const { data } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigation = useNavigation();
  const f = data.filters;
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/wechat";
  const keep = { category: f.category, track: f.track ?? null, tag: f.tag };
  const hasFilter = !!(f.q || f.tag || f.category || f.track);
  const searchTabHref = (tab: "time" | "relevance") => {
    const sp = new URLSearchParams(params);
    sp.delete("source");
    sp.delete("page");
    if (tab === "relevance") sp.set("tab", "relevance");
    else sp.delete("tab");
    const s = sp.toString();
    return s ? `/wechat?${s}` : "/wechat";
  };
  const updated = new Date(data.freshness).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" });

  return (
    <div className="pb-6">
      <div className="hidden lg:block">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">{f.q ? `搜索“${f.q}”` : f.tag ? `#${f.tag}` : "公众号"}</h1>
        <p className="mb-4 mt-2 text-[13.5px] text-ink-4">已核验固定公众号的公开文章</p>
        <div className="mb-4 flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <TrackTabs base="/wechat" track={f.track} layoutId="wechat-track-desk" />
            <CategoryTabs base="/wechat" category={f.category} track={f.track} categoryKeys={WECHAT_CATEGORY_KEYS} includeChannels={false} layoutId="wechat-cat-desk" className="min-w-0" />
          </div>
          <SearchField action="/wechat" variant="track" defaultValue={f.q ?? ""} keep={keep} />
        </div>
        <TagTabs base="/wechat" tag={f.tag} tags={WECHAT_TOPIC_TAGS} layoutId="wechat-tag-desk" />
      </div>

      <div className="lg:hidden">
        <div className="flex items-baseline justify-between pb-3 pt-5">
          <h1 className="text-[22px] font-bold text-ink">{f.q ? `搜索“${f.q}”` : f.tag ? `#${f.tag}` : "公众号"}</h1>
          {!f.q && !f.tag && !f.category && !f.track && (
            <span className="text-[12.5px] text-ink-4">
              今日 <span className="num">{data.todayCount}</span> 条
            </span>
          )}
        </div>
        <SearchField action="/wechat" variant="bar" defaultValue={f.q ?? ""} keep={keep} autoFocus={params.get("search") === "1"} />
        <div className="-mx-4 mt-3 border-b border-line-soft px-4 pb-3">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <TrackTabs base="/wechat" track={f.track} layoutId="wechat-track-mobile" size="sm" />
            <CategoryTabs base="/wechat" category={f.category} track={f.track} categoryKeys={WECHAT_CATEGORY_KEYS} includeChannels={false} layoutId="wechat-cat-mobile" size="sm" className="min-w-0" />
          </div>
          <TagTabs base="/wechat" tag={f.tag} tags={WECHAT_TOPIC_TAGS} layoutId="wechat-tag-mobile" size="sm" className="mt-2" />
        </div>
      </div>

      {hasFilter && (
        <div className="mb-3 mt-5 flex flex-wrap items-center justify-between gap-2 lg:mt-0">
          {f.q ? <PillTabs
            size="xs"
            layoutId="wechat-search-sort"
            label="搜索排序"
            active={f.tab}
            items={(["time", "relevance"] as const).map((t) => ({ key: t, label: t === "time" ? "最新（标题与摘要）" : "全文相关", to: searchTabHref(t) }))}
          /> : <span className="text-[12px] text-ink-4">当前筛选</span>}
          <span className="text-[12px] text-ink-4">
            {f.q ? "找到" : "共"} <span className="num">{data.total >= 2000 ? "2000+" : data.total}</span> 条 · 更新于 <span className="num">{updated}</span>
          </span>
        </div>
      )}

      <div className={`transition-opacity duration-200 ${busy ? "opacity-50" : ""}`}>
        {data.items.length === 0 ? (
          <div className="mt-2 lg:card">
            <EmptyState
              title={f.q || hasFilter ? "没有找到符合筛选条件的公众号文章" : "当前没有已公开的公众号内容"}
              action={
                f.q && f.tab === "time" ? (
                  <Link to={searchTabHref("relevance")} className="text-[13px] font-medium text-accent hover:underline">
                    试试“全文相关”，连正文一起搜
                  </Link>
                ) : undefined
              }
            >
              {f.q || hasFilter ? "换个说法，或者去掉筛选再试。" : "已核验固定公众号的新文章会在这里出现。"}
            </EmptyState>
          </div>
        ) : (
          <DayList items={data.items} todayCount={f.q || f.tag || f.category || f.track ? null : data.todayCount} showTags filterBase="/wechat" />
        )}
      </div>
      <Pagination page={data.page} pageCount={data.pageCount} href={(p) => pageHref(params, p)} />
      {data.page >= 50 && <p className="mt-4 text-center text-[12px] text-ink-4">最多提供 50 页，更早的内容请使用搜索。</p>}
    </div>
  );
}
