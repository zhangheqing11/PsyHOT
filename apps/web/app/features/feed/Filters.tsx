// Feed filters: the channel and category row, and search.
import { useEffect, useRef, useState } from "react";
import { Form, Link, useNavigation, useSearchParams } from "react-router";
import { useNavigate } from "react-router";
import { FEATURES } from "@aihot/industry/features";
import { CATEGORY_LABELS, CATEGORY_TRACK, CHANNEL_LABELS, PUBLIC_API_CATEGORY_KEYS, TRACK_LABELS, type CategoryKey, type ChannelKey, type RegionKey, type TrackKey } from "@aihot/contracts/taxonomy";
import { IconClose, IconSearch } from "../../components/icons";
import { PillTabs } from "../../components/ui/Tabs";
import { setTrackPreference } from "../../lib/local-state";

/** Same page with some query parameters changed (paging state dropped). */
export function hrefWith(base: string, params: URLSearchParams, patch: Record<string, string | null>) {
  const sp = new URLSearchParams(params);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === "") sp.delete(k);
    else sp.set(k, v);
  }
  sp.delete("page");
  sp.delete("cursor");
  const s = sp.toString();
  return s ? `${base}?${s}` : base;
}

/**
 * The feed's one filter row (精选 and 全部动态 alike): 全部, 一手, then the categories. One choice at a
 * time: picking 一手 clears the category and picking a category clears 一手. Older 资讯 / X links
 * still filter; the row then shows 全部.
 */
export function TrackTabs({ base, track, layoutId, size = "md", className = "" }: { base: string; track?: TrackKey | null; layoutId: string; size?: "md" | "sm"; className?: string }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  if (!FEATURES.tracks) return null;
  const active = track ?? "all";
  const go = (key: string) => {
    const next = key === "all" ? null : key as TrackKey;
    setTrackPreference(next);
    navigate(hrefWith(base, params, { track: next, region: null, category: null }));
  };
  return <PillTabs items={[{ key: "all", label: "综合" }, ...(["academic", "industry"] as const).map((key) => ({ key, label: TRACK_LABELS[key] }))]} active={active} onSelect={go} layoutId={layoutId} label="视角" size={size} className={className} />;
}

export function RegionTabs({ base, track, region, layoutId, size = "sm", className = "" }: { base: string; track?: TrackKey | null; region?: RegionKey | null; layoutId: string; size?: "md" | "sm"; className?: string }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  if (!FEATURES.tracks || track !== "industry") return null;
  const active = region ?? "all";
  const go = (key: string) => navigate(hrefWith(base, params, { region: key === "all" ? null : key, track: "industry" }));
  return <PillTabs items={[{ key: "all", label: "全部地区" }, { key: "domestic", label: "国内" }, { key: "international", label: "国际" }]} active={active} onSelect={go} layoutId={layoutId} label="地区" size={size} className={className} />;
}

export function CategoryTabs({ base, category, channel = "all", track, layoutId, size = "md", className = "", categoryKeys, includeChannels = true }: { base: string; category: CategoryKey | null; channel?: ChannelKey; track?: TrackKey | null; layoutId: string; size?: "md" | "sm"; className?: string; categoryKeys?: readonly CategoryKey[]; includeChannels?: boolean }) {
  const [params] = useSearchParams();
  const candidates = categoryKeys ?? PUBLIC_API_CATEGORY_KEYS;
  const visibleCategories = FEATURES.tracks
    ? (track ? candidates.filter((key) => CATEGORY_TRACK[key] === track) : (categoryKeys ? [...candidates] : []))
    : [...candidates];
  const items = [
    { key: "all", label: "全部", to: hrefWith(base, params, { category: null, channel: null }) },
    ...(includeChannels ? [{ key: "firstParty", label: CHANNEL_LABELS.firstParty, to: hrefWith(base, params, { category: null, channel: "firstParty" }) }] : []),
    ...visibleCategories.map((k) => ({ key: k, label: CATEGORY_LABELS[k], to: hrefWith(base, params, { category: k, channel: null }) })),
  ];
  const active = includeChannels && channel === "firstParty" ? "firstParty" : (category ?? "all");
  return <PillTabs items={items} active={active} layoutId={layoutId} label="筛选" size={size} className={className} />;
}

/** Topic tags used by a page-specific view without making every site tag a global filter. */
export function TagTabs({ base, tag, tags, layoutId, size = "sm", label = "领域", allLabel = "全部领域", className = "" }: { base: string; tag: string | null; tags: readonly string[]; layoutId: string; size?: "md" | "sm"; label?: string; allLabel?: string; className?: string }) {
  const [params] = useSearchParams();
  const items = [
    { key: "all", label: allLabel, to: hrefWith(base, params, { tag: null }) },
    ...tags.map((value) => ({ key: value, label: value, to: hrefWith(base, params, { tag: value }) })),
  ];
  return <PillTabs items={items} active={tag ?? "all"} layoutId={layoutId} label={label} size={size} className={className} />;
}

function useSlashFocus(ref: React.RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable)) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ref]);
}

/**
 * Search field (GET /all?q=…). Desktop ("track"): at the end of the filter row as the same grey track,
 * at the height of md tabs, with a "/" hint. Phones ("bar"): full width with a separate 搜索 button.
 */
export function SearchField({ action = "/all", defaultValue = "", keep = {}, variant = "track", autoFocus = false }: { action?: string; defaultValue?: string; keep?: Record<string, string | null>; variant?: "track" | "bar"; autoFocus?: boolean }) {
  const [value, setValue] = useState(defaultValue);
  const navigation = useNavigation();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(defaultValue), [defaultValue]);
  useSlashFocus(inputRef);
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);
  const searching = navigation.state === "loading" && navigation.location?.pathname === action && !!new URLSearchParams(navigation.location.search).get("q");
  const hidden = Object.entries(keep).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null));

  if (variant === "bar") {
    return (
      <Form method="get" action={action} role="search" className="flex gap-2">
        {hidden}
        <label className="relative flex-1">
          <span className="sr-only">搜索标题、摘要与正文</span>
          <IconSearch size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-4" />
          <input
            ref={inputRef}
            name="q"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="搜索标题、摘要…"
            maxLength={200}
            autoComplete="off"
            enterKeyHint="search"
            className="h-11 w-full rounded-full border border-line-strong bg-surface pl-10 pr-9 text-[15px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-ink-4 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
          />
          {value && (
            <button type="button" aria-label="清空" onClick={() => { setValue(""); inputRef.current?.focus(); }} className="absolute right-2.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full text-ink-4">
              <IconClose size={15} />
            </button>
          )}
        </label>
        <button type="submit" className={`h-11 shrink-0 rounded-full bg-accent px-5 text-[14.5px] font-semibold text-accent-contrast transition-[background-color,transform] active:scale-[0.98] ${searching ? "opacity-60" : ""}`}>
          搜索
        </button>
      </Form>
    );
  }

  return (
    <Form method="get" action={action} role="search" className="group relative w-full shrink-0 lg:w-60">
      {hidden}
      <label htmlFor="site-search" className="sr-only">
        搜索标题、摘要与正文
      </label>
      <IconSearch size={16} className={`pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 transition-colors ${searching ? "text-accent" : "text-ink-4 group-focus-within:text-ink-3"}`} />
      <input
        ref={inputRef}
        id="site-search"
        name="q"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="搜索标题、摘要…"
        maxLength={200}
        autoComplete="off"
        className="h-[42px] w-full rounded-full bg-bg-sunk pl-10 pr-10 text-[14px] text-ink outline-none ring-1 ring-inset ring-line-soft transition-[background-color,box-shadow] placeholder:text-ink-4 hover:ring-line-strong focus:bg-surface focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:ring-accent dark:bg-bg-muted/60 dark:focus:bg-surface"
      />
      {value ? (
        <button
          type="button"
          aria-label="清空"
          onClick={() => {
            setValue("");
            inputRef.current?.focus();
          }}
          className="absolute right-3 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-full text-ink-4 transition-colors hover:bg-bg-sunk hover:text-ink"
        >
          <IconClose size={13} />
        </button>
      ) : (
        <kbd className="mono pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 rounded-mark border border-line-strong bg-surface px-1.5 text-[10.5px] leading-4 text-ink-4 lg:block">/</kbd>
      )}
    </Form>
  );
}

/** Mobile home: the search icon at the end of the category row opens search on 全部动态. */
export function SearchIconLink() {
  return (
    <Link to="/all?search=1" aria-label="搜索" className="flex size-9 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-bg-sunk hover:text-ink">
      <IconSearch size={19} />
    </Link>
  );
}
