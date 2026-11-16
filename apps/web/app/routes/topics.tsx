import { SITE } from "@aihot/industry/site";
import { groups } from "@aihot/industry/topics.json";
import { isTrackKey } from "@aihot/contracts/taxonomy";
import { Link, useLoaderData } from "react-router";
import { apiGet, queryString } from "../lib/api.server";
import { relativeTime } from "../lib/format";
import { pageMeta } from "../lib/seo";
import { TrackTabs } from "../features/feed/Filters";

interface TopicSummary {
  slug: string;
  name: string;
  group: "company" | "field" | "genre";
  definition: string;
  total: number;
  recent: number;
  indexable: boolean;
  hasPicks: boolean;
  latestAt: string | null;
  latestItems: Array<{ id: string; title: string }>;
}

export async function loader({ request }: { request: Request }) {
  const trackParam = new URL(request.url).searchParams.get("track");
  const track = isTrackKey(trackParam) ? trackParam : null;
  const data = await apiGet<{ topics: TopicSummary[] }>(`/api/site/topics${queryString({ track })}`, { signal: request.signal });
  return { ...data, track };
}

export function meta() {
  return pageMeta({ title: "主题", description: `按${GROUP_NAMES}聚合的${SITE.subject}主题页，持续汇集近期焦点与精选。`, path: "/topics", image: "/og/pages/topics.png" });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

// Group names and blurbs belong to the industry pack (industry/topics.json).
const GROUPS = groups;
const GROUP_NAMES = GROUPS.map((g) => g.name).join("、");

export default function TopicsPage() {
  const { topics, track } = useLoaderData<typeof loader>();
  const topicHref = (slug: string) => `/topics/${slug}${track ? `?track=${track}` : ""}`;
  return (
    <div className="pb-10">
      <header className="pb-2 pt-5 lg:pt-1">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">按主题看{/^[A-Za-z0-9]/.test(SITE.subject) ? " " : ""}{SITE.subject}</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          按{GROUP_NAMES}浏览 <span className="num">{topics.length}</span> 个主题，持续汇集近期焦点与精选。
        </p>
        <nav aria-label="主题分组" className="mt-3 flex flex-wrap gap-x-2 text-[12.5px] text-ink-3">
          {GROUPS.map((g, i) => (
            <span key={g.key}>
              {i > 0 && <span aria-hidden="true" className="mr-2 text-ink-4">·</span>}
              <a href={`#topics-${g.key}`} className="hover:text-accent">{g.name}</a>
            </span>
          ))}
        </nav>
        <div className="mt-4 hidden lg:block">
          <TrackTabs base="/topics" track={track} layoutId="topics-track-desk" />
        </div>
        <div className="mt-3 lg:hidden">
          <TrackTabs base="/topics" track={track} layoutId="topics-track-mobile" size="sm" />
        </div>
      </header>
      {GROUPS.map((g) => {
        const visible = topics.filter((t) => t.group === g.key && t.total > 0);
        const cards = visible.filter((t) => t.indexable);
        const accumulating = visible.filter((t) => !t.indexable);
        return (
          <section key={g.key} id={`topics-${g.key}`} aria-labelledby={`topics-${g.key}-title`} className="scroll-mt-20 pt-8">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <h2 id={`topics-${g.key}-title`} className="text-[15px] font-bold text-ink">
                {g.name}
              </h2>
              <p className="text-[12px] text-ink-4">{g.blurb}</p>
            </div>
            {cards.length > 0 && (
              <ul className="mt-3.5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {cards.map((t) => (
                  <li key={t.slug} className="min-w-0">
                    <div className="card card-hover flex h-full min-w-0 flex-col px-5 py-[18px]">
                      <h3 className="text-[15px] font-bold text-ink">
                        <Link to={topicHref(t.slug)} prefetch="intent" className="transition-colors hover:text-accent">{t.name}</Link>
                      </h3>
                      <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-[1.7] text-ink-3">{t.definition}</p>
                      <ul className="mt-3 flex-1 space-y-1.5 text-[11.5px] leading-[1.6] text-ink-3">
                        {t.latestItems.map((item) => (
                          <li key={item.id}>
                            <Link to={`/items/${item.id}`} prefetch="intent" title={item.title} className="block truncate hover:text-accent">{item.title}</Link>
                          </li>
                        ))}
                      </ul>
                      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[11px]">
                        <span className="text-ink-4">
                          {[t.recent > 0 ? `近 30 天 ${t.recent} 条` : null, t.latestAt ? `${relativeTime(t.latestAt)}更新` : null].filter(Boolean).join(" · ")}
                        </span>
                        <Link to={topicHref(t.slug)} prefetch="intent" className="mono text-accent hover:underline">查看 {t.total} 条{t.hasPicks ? "领域精选" : "精选"} →</Link>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {accumulating.length > 0 && (
              <div className="mt-3.5 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-4">
                <span>内容还在积累：</span>
                {accumulating.map((t) => (
                  <Link key={t.slug} to={topicHref(t.slug)} prefetch="intent" className="chip">
                    {t.name} <span className="num">{t.total}</span>
                  </Link>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
