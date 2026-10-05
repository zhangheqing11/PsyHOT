// The daily report by email: one address, a confirmation email, then every morning's issue.
import { withSubject } from "@aihot/industry/site";
import { useState } from "react";
import { Link } from "react-router";
import { Kicker } from "../../components/ui/Kicker";

type State = { kind: "idle" } | { kind: "sending" } | { kind: "done"; email: string } | { kind: "error"; message: string };

export function SubscribeBox() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setState({ kind: "sending" });
    try {
      const res = await fetch("/api/site/subscriptions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim() }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setState({ kind: "error", message: body.detail ?? "订阅失败，请稍后再试。" });
      setState({ kind: "done", email: email.trim() });
    } catch {
      setState({ kind: "error", message: "网络不太顺，请稍后再试。" });
    }
  };

  return (
    <section id="subscribe" aria-labelledby="subscribe-t" className="mt-16 rounded-card border border-line bg-bg-sunk px-5 py-6 @[880px]:px-8 @[880px]:py-7">
      <Kicker>邮件订阅</Kicker>
      <h2 id="subscribe-t" className="mt-2 text-[19px] font-bold leading-[1.4] text-ink">每天早上，把{withSubject("日报")}发到你的邮箱</h2>
      {state.kind === "done" ? (
        <p role="status" className="mt-3 text-[14px] leading-[1.8] text-ink-2">
          确认邮件已发到 <b className="font-semibold text-ink">{state.email}</b>，点邮件里的“确认订阅”就完成了。几分钟内没收到的话，看看垃圾邮件箱。
        </p>
      ) : (
        <>
          <p className="mt-2 text-[13.5px] leading-[1.8] text-ink-3">日报 08:00 出炉后发送，每期一封，随时一键退订。</p>
          <form onSubmit={submit} className="mt-4 flex flex-col gap-2.5 sm:flex-row">
            <label htmlFor="subscribe-email" className="sr-only">邮箱地址</label>
            <input
              id="subscribe-email"
              type="email"
              required
              autoComplete="email"
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="你的邮箱"
              className="h-11 w-full min-w-0 rounded-card bg-surface px-4 text-[14.5px] text-ink outline-none ring-1 ring-inset ring-line-soft transition-[box-shadow] placeholder:text-ink-4 hover:ring-line-strong focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:ring-accent sm:max-w-[340px]"
            />
            <button
              type="submit"
              disabled={state.kind === "sending"}
              className="inline-flex h-11 shrink-0 items-center justify-center rounded-full bg-accent px-6 text-[14px] font-medium text-accent-contrast transition-[background-color,opacity] hover:bg-accent-ink disabled:opacity-60"
            >
              {state.kind === "sending" ? "发送中…" : "订阅"}
            </button>
          </form>
          {state.kind === "error" && <p role="alert" className="mt-3 rounded-tile bg-hot-soft px-3.5 py-2.5 text-[13px] text-hot">{state.message}</p>}
          <p className="mt-3 text-[12px] text-ink-4">
            邮箱只用来发日报，退订即删除，详见<Link to="/privacy" className="text-ink-3 underline-offset-2 hover:text-accent hover:underline">隐私说明</Link>。
          </p>
        </>
      )}
    </section>
  );
}
