// One report in a feed. Desktop (≥ 961px): a white card beside the time rail. Mobile: a compact row
// with a divider, the reason in a grey box. One markup, two presentations, as on the original site.
import { memo, useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { IntentLink } from "../../components/ui/IntentLink";
import type { GroupInfo, FeedItemSummary, TimelineFilters } from "@aihot/contracts/site";
import { CATEGORY_LABELS, CATEGORY_TRACK, IMPACT_LABELS, industryRolesOn, industryRoleScoringOn } from "@aihot/contracts/taxonomy";
import { SelectedBadge } from "../../components/ui/Badge";
import { ScoreLabel } from "../../components/ui/Score";
import { MediaThumbs, SourceLine, StarButton } from "./parts";
import { GroupDevelopments, GroupSources, LatestDevelopment } from "./ReadingGroup";
import { QuotedLine } from "../item/QuotedPost";
import { IconChevronDown } from "../../components/icons";
import { countExpand, getExpandedIds, setExpanded } from "../../lib/expanded-state";
import { MOBILE_COPY } from "../../lib/mobile-copy";

export interface FeedItemProps {
  item: FeedItemSummary;
  group?: GroupInfo | null;
  filters?: TimelineFilters;
  read?: boolean;
  onOpen?: (id: string) => void;
  /** Show category and tags under the text (全部动态, topics, search). */
  showTags?: boolean;
  /** Supplementary pick on a topic page; other feeds keep their existing selected marks. */
  fieldPick?: boolean;
}

export const FeedItem = memo(function FeedItem({ item, group, filters, read = false, onOpen, showTags = false, fieldPick = false }: FeedItemProps) {
  const isX = item.channel === "x" && !!item.x;
  const [expanded, setExpandedState] = useState(false);
  const foldId = useId();
  const summaryId = `${foldId}-summary`;
  const reasonId = `${foldId}-reason`;
  useEffect(() => {
    if (!isX) setExpandedState(getExpandedIds().includes(item.id));
  }, [item.id, isX]);
  const foldLabel = item.summary && item.reason ? MOBILE_COPY.FOLD_SUMMARY_REASON : item.summary ? MOBILE_COPY.FOLD_SUMMARY : MOBILE_COPY.FOLD_REASON;
  const open = () => onOpen?.(item.id);
  const showSources = !!group && (group.additionalSourceCount > 0 || (group.developmentCount <= 1 && group.reportCount > 1));
  const showDevelopments = !!group?.story && group.developmentCount > 1;
  const tags = showTags ? item.tags.slice(0, 3) : [];
  // With FEATURES.industryRoles on, an industry item's badge is its impact type (not its industry category);
  // without one it has no badge. Academic items keep their category.
  const byImpact = industryRolesOn() && !!item.category && CATEGORY_TRACK[item.category] === "industry";
  const hideScore = industryRoleScoringOn() && !!item.category && CATEGORY_TRACK[item.category] === "industry";
  const hotPick = industryRoleScoringOn() && item.hotPick;
  const showBadge = showTags && !!item.category && (!byImpact || !!item.impact);

  return (
    <article className="relative min-w-0 lg:card lg:card-hover lg:px-[18px] lg:pb-[14px] lg:pt-[15px]" data-item-id={item.id}>
      <header className="flex min-h-[18px] items-center gap-2 text-[12.5px] leading-[18px] text-ink-4">
        <SourceLine item={item} className="text-ink-4" />
        {fieldPick ? (
          <span className="shrink-0 rounded border border-line px-1 text-[11px] leading-[16px] text-ink-4">领域精选</span>
        ) : item.selected && (
          <span className="hidden lg:inline-flex">
            <SelectedBadge />
          </span>
        )}
        {item.promotion && <span className="shrink-0 rounded border border-line px-1 text-[11px] leading-[16px] text-ink-4">推广</span>}
        {hotPick && <span className="shrink-0 rounded border border-line px-1 text-[11px] leading-[16px] text-ink-4">热点</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          {!hideScore && <>
            <span className="hidden lg:inline-flex">
              <ScoreLabel score={item.score} />
            </span>
            <span className="lg:hidden">
              <ScoreLabel score={item.score} compact />
            </span>
          </>}
          <span className="-my-1 hidden lg:inline-flex">
            <StarButton item={item} />
          </span>
        </span>
      </header>

      {isX ? (
        <p className={`mt-2 whitespace-pre-line text-[15px] leading-[1.75] line-clamp-5 lg:line-clamp-4 ${read ? "text-ink-4" : "text-ink"}`}>
          <IntentLink to={`/items/${item.id}`} onClick={open} className="after:absolute after:inset-0 after:content-['']">
            {item.summary ?? item.title}
          </IntentLink>
        </p>
      ) : (
        <>
          <h3 className={`mt-2 line-clamp-2 text-[17px] font-bold leading-[1.55] lg:line-clamp-none lg:font-[650] ${read ? "text-ink-4" : "text-ink"}`}>
            <IntentLink to={`/items/${item.id}`} onClick={open} className="after:absolute after:inset-0 after:content-['']">
              {item.title}
            </IntentLink>
          </h3>
          {(item.summary || item.reason) && (
            <button type="button" aria-expanded={expanded} aria-controls={[item.summary ? summaryId : null, item.reason ? reasonId : null].filter(Boolean).join(" ")}
              aria-label={expanded ? MOBILE_COPY.FOLD_COLLAPSE_ARIA : MOBILE_COPY.FOLD_EXPAND_ARIA}
              className="relative z-10 mt-1 inline-flex min-h-9 items-center gap-1 text-[12px] text-ink-3 lg:hidden"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const next = !expanded;
                setExpandedState(next);
                setExpanded(item.id, next);
                if (next) countExpand();
              }}>
              <span>{foldLabel}</span>
              <IconChevronDown size={13} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
            </button>
          )}
          {item.summary && <p id={summaryId} className={`mt-1.5 text-[14.5px] leading-[1.75] text-ink-3 ${expanded ? "block" : "hidden"} lg:mt-2 lg:line-clamp-3 lg:text-[15px]`}>{item.summary}</p>}
        </>
      )}

      {isX && item.x!.media.length > 0 && <MediaThumbs media={item.x!.media} className="mt-2.5" />}
      {isX && item.x!.quoted?.text && <QuotedLine quoted={item.x!.quoted} />}

      {(tags.length > 0 || showBadge) && (
        <div className="relative z-10 mt-2 hidden flex-wrap gap-x-2.5 gap-y-1 text-[12px] text-ink-4 lg:flex">
          {showBadge && item.category && (byImpact && item.impact ? (
            <span>{IMPACT_LABELS[item.impact]}</span>
          ) : (
            <Link to={`/all?category=${item.category}`} className="hover:text-accent">
              {CATEGORY_LABELS[item.category]}
            </Link>
          ))}
          {tags.map((t) => (
            <Link key={t} to={`/all?tag=${encodeURIComponent(t)}`} className="hover:text-accent">
              #{t}
            </Link>
          ))}
        </div>
      )}

      {group && <LatestDevelopment group={group} />}
      {(showSources || showDevelopments) && (
        <div className="mt-2 flex flex-wrap items-start gap-x-4 gap-y-1">
          {showSources && <GroupSources group={group!} filters={filters} parentId={item.id} />}
          {showDevelopments && <GroupDevelopments group={{ ...group!, story: group!.story! }} filters={filters} parentId={item.id} />}
        </div>
      )}

      {item.reason && (
        <div id={isX ? undefined : reasonId} className={`mt-2.5 rounded-control bg-bg-sunk px-3 py-2 dark:bg-bg-muted/60 lg:mt-3 lg:rounded-none lg:border-t lg:border-line-soft lg:bg-transparent lg:px-0 lg:pb-0 lg:pt-3 lg:dark:bg-transparent ${isX || expanded ? "block" : "hidden lg:block"}`}>
          <p className={`${isX ? "line-clamp-2" : ""} text-[13px] leading-[1.65] text-ink-3 lg:line-clamp-none lg:leading-[1.75] lg:text-note`}>推荐理由：{item.reason}</p>
        </div>
      )}
    </article>
  );
});
