import { PRACTITIONER_ROLES, IMPACT_TYPES } from "@aihot/industry/taxonomy";

export function PractitionerRoles({ roles, impact }: { roles?: unknown; impact?: unknown }) {
  if (!Array.isArray(roles)) return null;
  const roleLabels = PRACTITIONER_ROLES.filter((r) => roles.includes(r.key)).map((r) => r.label);
  const impactLabel = IMPACT_TYPES.find((i) => i.key === impact)?.label;
  return <div className="mt-1 text-[12px] text-ink-3">角色：{roleLabels.join("、") || "无"} · 影响：{impactLabel ?? "无"}</div>;
}
