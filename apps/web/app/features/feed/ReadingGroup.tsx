// Reading-group expansions on a feed item: the other sources of the card's fact ("另有 N 家信源报道")
// and the event's developments ("展开 N 条进展"). Each loads on first open and pages on demand.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { Collapse } from "../../components/ui/Presence";
import type { Development, GroupInfo, GroupReport, TimelineFilters } from "@aihot/contracts/site";
import { IconArrowUpRight, IconChevronDown } from "../../components/icons";
import { monthDayTime, shortSourceName } from "../../lib/format";
import { isReload } from "./restore";
import { sessionCache } from "./session-cache";

function filterParams(filters: TimelineFilters | undefined, cursor: string | null) {
  const sp = new URLSearchParams();
  if (filters?.channel && filters.channel !== "all") sp.set("channel", filters.channel);
  if (filters?.category) sp.set("category", filters.category);
  if (filters?.track) sp.set("track", filters.track);
  if (filters?.region) sp.set("region", filters.region);
  if (filters?.tag) sp.set("tag", filters.tag);
  if (cursor) sp.set("cursor", cursor);
  return sp;
}

type Paged<T> = { loading: boolean; items: T[]; error: boolean; next: string | null; loaded: boolean };
const EMPTY = { loading: false, items: [], error: false, next: null, loaded: false };

// What each group had open and loaded, per history entry: back from an item finds the list as it was
// left (the list snapshot keeps the cards, this keeps their expansions). In memory for back within the
// app; in session storage for a page the browser reloaded on back/forward.
interface Saved {
  open: boolean;
  paged: Paged<unknown> & { scope: string };
}
const groupsCache = sessionCache<{ savedAt: number; groups: Record<string, Saved> }>("aihot:groups:", 30 * 60 * 1000);

function stored(entry: string): Record<string, Saved> {
  return groupsCache.read(entry)?.groups ?? {};
}

function remember(entry: string, key: string, saved: Saved) {
  const keep = saved.open || saved.paged.loaded;
  const groups = groupsCache.peek(entry)?.groups;
  // Most groups are never opened: nothing to read or write for them.
  if (!keep && !groups?.[key]) return;
  const next = { ...(groups ?? stored(entry)) };
  if (keep) next[key] = { ...saved, paged: { ...saved.paged, loading: false } };
  else delete next[key];
  groupsCache.set(entry, { savedAt: Date.now(), groups: next });
}

/** Open state and pages of one group, restored for the history entry it was left in. */
function useGroupState<T>(key: string, url: (cursor: string | null) => string, pick: (body: Record<string, unknown>) => T[]) {
  const entry = useLocation().key;
  const initial = groupsCache.peek(entry)?.groups[key] as (Saved & { paged: Paged<T> & { scope: string } }) | undefined;
  const [open, setOpen] = useState(initial?.open ?? false);
  const paged = usePaged<T>(url, pick, initial?.paged);
  // A document the browser reloaded on back/forward (never a reader's reload, which asks for a fresh
  // list) gets its groups back after hydration, as the list itself does.
  useEffect(() => {
    const inMemory = groupsCache.peek(entry)?.groups[key];
    const saved = (inMemory ?? (isReload() ? undefined : stored(entry)[key])) as (Saved & { paged: Paged<T> & { scope: string } }) | undefined;
    if (!saved) return;
    if (!inMemory) {
      setOpen(saved.open);
      paged.restore(saved.paged);
    }
    // Left open while its first page was still loading: load it again.
    if (saved.open && !saved.paged.loaded) void paged.load(null);
  }, [entry, key]);
  useEffect(() => {
    remember(entry, key, { open, paged: paged.raw as Saved["paged"] });
  }, [entry, key, open, paged.raw]);
  return { open, setOpen, ...paged };
}

/** One list at a time: when the filters change, earlier pages and late responses of the old list are dropped. */
function usePaged<T>(url: (cursor: string | null) => string, pick: (body: Record<string, unknown>) => T[], from?: Paged<T> & { scope: string }) {
  const scope = url(null);
  const latest = useRef(scope);
  latest.current = scope;
  const [state, setState] = useState<Paged<T> & { scope: string }>(() => (from && from.scope === scope ? { ...from, loading: false } : { ...EMPTY, scope }));
  const current: Paged<T> = state.scope === scope ? state : EMPTY;
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, [scope]);
  const load = async (cursor: string | null): Promise<void> => {
    if (request.current) return;
    const at = scope;
    const controller = new AbortController();
    request.current = controller;
    const active = () => latest.current === at && !controller.signal.aborted;
    setState((s) => ({ ...(s.scope === at ? s : EMPTY), scope: at, loading: true, error: false }));
    try {
      let res = await fetch(url(cursor), { signal: controller.signal });
      // An expired cursor gets one fresh first page, never an unbounded retry loop.
      if (res.status === 409 && cursor) {
        cursor = null;
        res = await fetch(url(null), { signal: controller.signal });
      }
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as Record<string, unknown> & { nextCursor: string | null };
      if (!active()) return;
      setState((s) => ({ scope: at, loading: false, error: false, loaded: true, next: body.nextCursor, items: cursor && s.scope === at ? [...s.items, ...pick(body)] : pick(body) }));
    } catch {
      if (active()) setState((s) => ({ ...s, loading: false, error: true }));
    } finally {
      if (request.current === controller) request.current = null;
    }
  };
  const restore = (saved: Paged<T> & { scope: string }) => {
    if (saved.scope === latest.current) setState({ ...saved, loading: false });
  };
  return { state: current, load, restore, raw: state };
}

function Toggle({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      className="relative z-10 inline-flex items-center gap-0.5 text-[12.5px] text-ink-4 transition-colors hover:text-accent"
    >
      {children}
      <IconChevronDown size={13} className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
    </button>
  );
}

function Panel({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <Collapse open={open} className="relative z-10">
      <div className="mt-2 rounded-control bg-bg-sunk px-3 py-2 dark:bg-bg-muted/60">{children}</div>
    </Collapse>
  );
}

function LoadState({ loading, error, next, onMore, onRetry, empty }: { loading: boolean; error: boolean; next: string | null; onMore: () => void; onRetry: () => void; empty: boolean }) {
  if (loading && empty) return <div className="space-y-2 py-1">{[0, 1].map((i) => <div key={i} className="skeleton h-4" />)}</div>;
  if (error) return <button type="button" onClick={onRetry} className="py-1 text-[12.5px] text-hot">暂时无法加载，点此重试</button>;
  if (next && !loading) return <button type="button" onClick={onMore} className="py-1 text-[12.5px] text-accent hover:underline">加载更多</button>;
  return null;
}

/** "另有 N 家信源报道": other reports of the fact the card stands for. */
export function GroupSources({ group, filters, parentId }: { group: GroupInfo; filters?: TimelineFilters; parentId: string }) {
  const { open, setOpen, state, load } = useGroupState<GroupReport>(
    `sources|${group.factId}|${parentId}`,
    (cursor) => `/api/site/groups/${encodeURIComponent(group.factId)}/reports?${filterParams(filters, cursor)}`,
    (b) => b.reports as GroupReport[],
  );
  const others = state.items.filter((r) => r.id !== parentId);
  const label = group.additionalSourceCount > 0 ? `另有 ${group.additionalSourceCount} 家信源报道` : `${group.reportCount} 篇报道`;
  return (
    <div>
      <Toggle
        open={open}
        onToggle={() => {
          setOpen(!open);
          if (!open && !state.loaded && !state.loading) void load(null);
        }}
      >
        {label}
      </Toggle>
      <Panel open={open}>
        <ul className="divide-y divide-line-soft">
          {others.map((r) => (
            <li key={r.id} className="flex items-baseline gap-2 py-1.5 text-[13px]">
              <span className="w-[108px] shrink-0 truncate text-ink-4">{shortSourceName(r.source.name)}</span>
              <Link to={`/items/${r.id}`} className="min-w-0 flex-1 truncate text-ink-2 hover:text-accent">
                {r.title}
              </Link>
              <a href={r.originalUrl} target="_blank" rel="noopener noreferrer" aria-label="打开原文" className="shrink-0 text-ink-4 hover:text-accent">
                <IconArrowUpRight size={13} />
              </a>
            </li>
          ))}
        </ul>
        <LoadState loading={state.loading} error={state.error} next={state.next} empty={others.length === 0} onMore={() => load(state.next)} onRetry={() => load(null)} />
      </Panel>
    </div>
  );
}

/** "展开 N 条进展": the other facts of the card's event, newest first. */
export function GroupDevelopments({ group, filters, parentId }: { group: GroupInfo & { story: NonNullable<GroupInfo["story"]> }; filters?: TimelineFilters; parentId: string }) {
  const { open, setOpen, state, load } = useGroupState<Development>(
    `developments|${group.story.publicId}|${parentId}`,
    (cursor) => `/api/site/stories/${encodeURIComponent(group.story.publicId)}/developments?${filterParams(filters, cursor)}`,
    (b) => b.developments as Development[],
  );
  return (
    <div>
      <Toggle
        open={open}
        onToggle={() => {
          setOpen(!open);
          if (!open && !state.loaded && !state.loading) void load(null);
        }}
      >
        展开 {group.developmentCount} 条进展
      </Toggle>
      <Panel open={open}>
        <ol className="relative space-y-2 py-1 pl-3.5 before:absolute before:bottom-2 before:left-[3px] before:top-2 before:w-px before:bg-line">
          {state.items.map((d) => (
            <li key={d.factId} className="relative">
              <span className={`absolute -left-[13.5px] top-[7px] size-[7px] rounded-full ring-2 ring-bg-sunk dark:ring-bg-muted ${d.representative.id === parentId ? "bg-accent" : "bg-line-strong"}`} />
              <Link to={`/items/${d.representative.id}`} className="block text-[13px] leading-snug text-ink-2 hover:text-accent">
                {d.title}
              </Link>
              <div className="mt-0.5 text-[11.5px] text-ink-4">
                {shortSourceName(d.representative.source.name)} · <span className="num">{monthDayTime(d.representative.timelineAt)}</span>
                {d.reportCount > 1 ? ` · ${d.reportCount} 篇报道` : ""}
              </div>
            </li>
          ))}
        </ol>
        <LoadState loading={state.loading} error={state.error} next={state.next} empty={state.items.length === 0} onMore={() => load(state.next)} onRetry={() => load(null)} />
        <Link to={`/story/${group.story.publicId}`} className="mt-1 inline-flex items-center gap-0.5 py-1 text-[12.5px] font-medium text-accent hover:text-accent-ink">
          查看完整事件 <IconArrowUpRight size={12} />
        </Link>
      </Panel>
    </div>
  );
}

/** "最新进展 · 9月27日 01:21 · …": why a folded event card sits where it does. */
export function LatestDevelopment({ group }: { group: GroupInfo }) {
  if (!group.latestDevelopment || group.developmentCount <= 1) return null;
  return (
    <p className="relative z-10 mt-2.5 flex items-baseline gap-1.5 text-[13px] leading-relaxed">
      <span className="shrink-0 font-medium text-accent">最新进展</span>
      <span className="num shrink-0 text-ink-4">{monthDayTime(group.latestDevelopment.at)}</span>
      <span className="line-clamp-1 text-ink-3">{group.latestDevelopment.title}</span>
    </p>
  );
}
