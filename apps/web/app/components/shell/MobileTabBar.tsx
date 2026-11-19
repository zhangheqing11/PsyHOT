import { Link, useLocation } from "react-router";
import { TABBAR, tabIsActive } from "./nav";
import { useChangelogDot } from "./Sidebar";

/** Bottom tab bar of the mobile shell (up to 960px), as on the original site. */
export function MobileTabBar({ changelogVersion }: { changelogVersion: string | null }) {
  const { pathname } = useLocation();
  const dot = useChangelogDot(changelogVersion);
  return (
    <nav aria-label="底部导航" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
      <div className="mx-auto grid h-[54px] max-w-[640px] grid-cols-5">
        {TABBAR.map((t) => {
          const active = tabIsActive(t, pathname);
          const Icon = t.icon;
          return (
            <Link
              key={t.to}
              to={t.to}
              prefetch="intent"
              aria-current={active ? "page" : undefined}
              className={`relative flex flex-col items-center justify-center gap-[3px] text-[11px] transition-colors ${active ? "font-semibold text-accent" : "text-ink-3 active:text-ink"}`}
            >
              <Icon size={21} />
              <span>{t.label}</span>
              {dot && t.changelog && <span className="absolute right-[calc(50%-17px)] top-2 size-1.5 rounded-full bg-hot" aria-label="有新的更新" />}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
