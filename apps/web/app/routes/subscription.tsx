// The two pages an email links to: confirming a subscription and unsubscribing. Neither acts on
// opening: mail scanners open links, so the reader presses the button.
import { SITE, withSubject } from "@aihot/industry/site";
import { useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { ReadingLayout } from "../components/ui/Page";
import { pageMeta } from "../lib/seo";

export function headers() {
  return { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
}

const COPY = {
  confirm: {
    title: "确认订阅",
    lead: `确认后，每天早上${withSubject("日报")}出炉就会发到你的邮箱。`,
    button: "确认订阅",
    url: "/api/site/subscriptions/confirm",
  },
  unsubscribe: {
    title: "退订邮件日报",
    lead: "退订后不会再收到日报邮件，你的邮箱地址会从名单中删除。",
    button: "确认退订",
    url: "/api/site/subscriptions/unsubscribe",
  },
} as const;

const modeOf = (path: string) => (path.startsWith("/unsubscribe") ? "unsubscribe" : "confirm");

export function meta({ location }: { location: { pathname: string } }) {
  const mode = modeOf(location.pathname);
  return pageMeta({ title: COPY[mode].title, description: COPY[mode].lead, path: location.pathname, noindex: true });
}

type State = { kind: "idle" } | { kind: "sending" } | { kind: "done"; email?: string } | { kind: "error"; message: string };

export default function SubscriptionPage() {
  const mode = modeOf(useLocation().pathname);
  const token = useSearchParams()[0].get("t") ?? "";
  const [state, setState] = useState<State>({ kind: "idle" });
  const copy = COPY[mode];

  const act = async () => {
    setState({ kind: "sending" });
    try {
      const res = await fetch(copy.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setState({ kind: "error", message: body.detail ?? "没有成功，请稍后再试。" });
      setState({ kind: "done", email: body.email });
    } catch {
      setState({ kind: "error", message: "网络不太顺，请稍后再试。" });
    }
  };

  return (
    <ReadingLayout>
      <div className="mx-auto max-w-[520px] py-16 text-center">
        <h1 className="text-[26px] font-black leading-[1.3] text-ink">{state.kind === "done" ? (mode === "confirm" ? "订阅成功" : "已退订") : copy.title}</h1>
        {!token ? (
          <p className="mt-4 text-[14.5px] leading-[1.8] text-ink-3">链接不完整，请从邮件里重新打开。</p>
        ) : state.kind === "done" ? (
          <p role="status" className="mt-4 text-[14.5px] leading-[1.8] text-ink-2">
            {mode === "confirm"
              ? <>{state.email && <b className="font-semibold text-ink">{state.email} </b>}每天早上会收到 {SITE.name} {withSubject("日报")}。每封邮件底部都可以一键退订。</>
              : "这个邮箱已从名单中删除，不会再收到日报邮件。以后想看，随时可以回来重新订阅。"}
          </p>
        ) : (
          <>
            <p className="mt-4 text-[14.5px] leading-[1.8] text-ink-3">{copy.lead}</p>
            <button
              type="button"
              onClick={act}
              disabled={state.kind === "sending"}
              className="mt-7 inline-flex h-11 items-center justify-center rounded-full bg-accent px-8 text-[14.5px] font-medium text-accent-contrast transition-[background-color,opacity] hover:bg-accent-ink disabled:opacity-60"
            >
              {state.kind === "sending" ? "处理中…" : copy.button}
            </button>
            {state.kind === "error" && <p role="alert" className="mx-auto mt-4 max-w-[400px] rounded-tile bg-hot-soft px-3.5 py-2.5 text-[13px] text-hot">{state.message}</p>}
          </>
        )}
        <p className="mt-10">
          <Link to="/daily" className="text-[13.5px] font-medium text-ink-3 transition-colors hover:text-accent">
            看今天的{withSubject("日报")} →
          </Link>
        </p>
      </div>
    </ReadingLayout>
  );
}
