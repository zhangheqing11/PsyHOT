// 该选 / 不该选 / 两可 for one item (docs/selection.md). Clicking the current label takes it back.
import { useAdminAction } from "./action";

export const LABEL_DECISIONS = [
  ["select", "该选"],
  ["reject", "不该选"],
  ["either", "两可"],
] as const;

export function LabelButtons({ id, decision, size = "md" }: { id: string; decision: string | null; size?: "md" | "sm" }) {
  const { run, pending } = useAdminAction();
  const busy = pending === `label:${id}`;
  return (
    <div className="inline-flex gap-1" role="group" aria-label="标注">
      {LABEL_DECISIONS.map(([value, label]) => {
        const on = decision === value;
        return (
          <button
            key={value}
            type="button"
            disabled={busy}
            aria-pressed={on}
            onClick={(e) => {
              e.stopPropagation();
              void run("POST", `/api/admin/labels/${encodeURIComponent(id)}`, { decision: on ? null : value }, { label: `label:${id}` });
            }}
            className={`rounded-control ring-1 transition-colors disabled:opacity-50 ${size === "sm" ? "px-2 py-0.5 text-[12px]" : "px-3 py-1 text-[13px]"} ${
              on ? (value === "select" ? "bg-accent text-white ring-accent" : value === "reject" ? "bg-hot text-white ring-hot" : "bg-ink-3 text-white ring-ink-3") : "text-ink-2 ring-line-strong hover:bg-bg-sunk"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
