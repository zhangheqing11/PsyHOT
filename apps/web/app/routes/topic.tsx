import { SITE } from "@aihot/industry/site";
import { Link, redirect, useLoaderData, useSearchParams } from "react-router";
import type { Route } from "./+types/topic";
import type { FeedItemSummary } from "@aihot/contracts/site";
import { industryRolesOn, isRegionKey, isRoleKey, isTrackKey } from "@aihot/contracts/taxonomy";
import { loadOr404, queryString } from "../lib/api.server";
import { breadcrumbLd, pageMeta, titled } from "../lib/seo";
import { DayList, Pagination } from "../features/feed/DayList";
import { EmptyState, MoreLink } from "../components/ui/Page";
import { PillTabs, PlainTabs } from "../components/ui/Tabs";
import { hrefWith, MobileFilters, TrackTabs } from "../features/feed/Filters";
import { topicAliasRedirect } from "../lib/topic-alias";

/** Topic selections: shared caches keep the page as long as its api answer (one minute). */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=60" };
}

interface TopicPageData {
  topic: { slug: string; name: string; group: string; definition: string; total: number; allTotal: number; indexable: boolean; hasPicks: boolean;
    subtags: Array<{ tag: string; total: number }>; related: Array<{ slug: string; name: string }> };
  items: FeedItemSummary[];
  fieldPickIds: string[];
  page: number;
  pageCount: number;
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const page = params.page ? Number(params.page) : 1;
  const url = new URL(request.url);
  const alias = topicAliasRedirect(params.slug, page, url.searchParams);
  if (alias) throw redirect(alias, 308);
  if (params.page !== undefined && (!/^\d+$/.test(params.page) || page < 1)) throw new Response("Not found", { status: 404 });
  // Page 1 lives at the topic's own address (308).
  if (params.page === "1") throw redirect(`/topics/${params.slug}${url.search}`, 308);
  const trackParam = url.searchParams.get("track");
  const regionParam = url.searchParams.get("region");
  const region = regionParam && isRegionKey(regionParam) ? regionParam : null;
  // Roles exist only while FEATURES.industryRoles is on, and only for industry items: a role implies the industry view.
  const roleParam = industryRolesOn() ? url.searchParams.get("role") : null;
  const role = roleParam && isRoleKey(roleParam) ? roleParam : null;
  const track = trackParam && isTrackKey(trackParam) ? trackParam : role ? "industry" : null;
  const tag = url.searchParams.get("tag")?.trim() || null;
  const data = await loadOr404<TopicPageData>(`/api/site/topics/${encodeURIComponent(params.slug)}${queryString({ page, track, region, role, tag })}`, { signal: request.signal });
  return { data, track, region, tag };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: titled("主题不存在") }, { name: "robots", content: "noindex" }];
  const { topic, page } = loaderData.data;
  const path = page > 1 ? `/topics/${topic.slug}/page/${page}` : `/topics/${topic.slug}`;
  return pageMeta({
    title: page > 1 ? `${topic.name} · 第 ${page} 页` : topic.name,
    description: topic.definition,
    path,
    image: `/og/topics/${topic.slug}.png`,
    noindex: !topic.indexable || !!loaderData.tag,
    jsonLd: breadcrumbLd([{ name: SITE.name, path: "/" }, { name: "主题", path: "/topics" }, { name: topic.name, path: `/topics/${topic.slug}` }]),
  });
}

export default function TopicPage() {
  const { data, track, region, tag } = useLoaderData<typeof loader>();
  const { topic, items, fieldPickIds, page, pageCount } = data;
  const [params] = useSearchParams();
  const base = `/topics/${topic.slug}`;
  const href = (p: number) => {
    const base = p <= 1 ? `/topics/${topic.slug}` : `/topics/${topic.slug}/page/${p}`;
    const query = params.toString();
    return query ? `${base}?${query}` : base;
  };
  const first = (page - 1) * 20 + 1;
  const last = first + items.length - 1;
  const subtags = [
    { key: "all", label: "全部", count: topic.allTotal, to: hrefWith(base, params, { tag: null }) },
    ...topic.subtags.map((s) => ({ key: s.tag, label: s.tag, count: s.total, to: hrefWith(base, params, { tag: s.tag }) })),
  ];
  return (
    <div className="pb-6">
      <header className="pb-4 pt-5 lg:pt-1">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-[22px] font-bold leading-[1.35] text-ink">{topic.name}</h1>
          <span className="hidden pt-2 lg:block">
            <MoreLink to={track ? `/topics?track=${track}` : "/topics"}>全部主题</MoreLink>
          </span>
        </div>
        <p className="mt-1 max-w-[640px] text-[13px] leading-relaxed text-ink-3">{topic.definition}</p>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <span className="text-[12.5px] text-ink-4">
            <span className="num mr-1 text-[20px] font-bold text-ink">{topic.total.toLocaleString("zh-CN")}</span>条{topic.hasPicks ? "领域精选" : "精选"}
          </span>
          {topic.related.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
              <span className="text-ink-4">相关主题</span>
              {topic.related.map((r) => (
                <Link key={r.slug} to={hrefWith(`/topics/${r.slug}`, params, { tag: null })} className="chip">
                  {r.name}
                </Link>
              ))}
            </span>
          )}
        </div>
        <div className="mt-4 hidden lg:block">
          <TrackTabs base={base} track={track} layoutId="topic-track-desk" />
        </div>
        <MobileFilters base={base} track={track} region={region} layoutId="topic-track-mobile" className="mt-3">
          {topic.subtags.length > 0 && <PlainTabs items={subtags} active={tag ?? "all"} label="子议题" />}
        </MobileFilters>
        {topic.subtags.length > 0 && (
          <PillTabs
            className="mt-3 hidden lg:block"
            size="sm"
            layoutId="topic-subtags"
            label="子议题"
            active={tag ?? "all"}
            items={subtags}
          />
        )}
      </header>

      <div className="mb-1 mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-[18px] font-bold text-ink">{topic.hasPicks ? "领域精选" : "最新精选"}</h2>
          {topic.hasPicks && <p className="text-[12px] text-ink-4">全站精选，加上本领域评分靠前的内容</p>}
        </div>
        {items.length > 0 && (
          <span className="num text-[12px] text-ink-4">
            第 {first}–{last} 条 · 共 {topic.total.toLocaleString("zh-CN")} 条
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <div className="lg:card">
          <EmptyState title="这个主题暂时还没有精选内容" />
        </div>
      ) : (
        <DayList items={items} fieldPickIds={new Set(fieldPickIds)} />
      )}
      <Pagination page={page} pageCount={pageCount} href={href} />
    </div>
  );
}
