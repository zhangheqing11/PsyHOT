// Question wording copied verbatim from the 2026-11-16 offline jev_roles.py qs().
import { ROLE_KEYS, type RoleKey } from "@aihot/contracts/taxonomy";
import { SELECTION } from "@aihot/industry/selection";
import type { TypeSafeAnswer, TypeSafeQuestion } from "../providers/typesafe.ts";
import { promptText } from "./prompts.ts";

const core = promptText("selection-roles").split("## 两层分数")[0]!.trim();
export const JEV_ROLE_QUESTIONS: Record<string, TypeSafeQuestion> = {};
for (const role of ROLE_KEYS) {
  const ins = core + "\n\n## 当前角色\n" + promptText(`role-${role}`).trim() + "\n\n只按当前角色判断。";
  JEV_ROLE_QUESTIONS[`${role}_verdict`] = { type: "choice", instructions: ins + "\n这条消息对当前角色的结论。", criteria: {
    must: "必看：应该进这个角色的每周精选（每周只有 1–2 条，要严）",
    maybe: "可看：不进精选，但放进“更多值得看”也合适", skip: "不必看",
  } };
  JEV_ROLE_QUESTIONS[`${role}_rel`] = { type: "score", instructions: ins + "\n这条消息与当前角色的相关度。", criteria: [
    "1 基本无关", "2 沾边，同行里少数人会关心，或只是间接相关", "3 直接相关，说的就是这个岗位涉及的事", "4 这个岗位的人基本都该知道",
  ] };
}
JEV_ROLE_QUESTIONS.nov = { type: "score", instructions: core + "\n\n这条消息带来的新增信息（与角色无关）。", criteria: [
  "1 旧闻、例行活动、会议通知、宣传稿", "2 已知事情的小进展，或换个说法再讲一遍",
  "3 有实质新内容：新规定、新数据、新案例、新产品、新做法", "4 首次出现的重大变化",
] };

const expected = (answer: TypeSafeAnswer) => Object.entries(answer.probabilities!).reduce((sum, [i, p]) => sum + (Number(i) + 1) * p, 0);
const integer = (ev: number) => Math.max(1, Math.min(4, Math.round(ev)));
const verdicts = ["must", "maybe", "skip"] as const;
export function jevRoleValues(answers: Record<string, TypeSafeAnswer>) {
  const roles = Object.fromEntries(ROLE_KEYS.map((key) => {
    const p = answers[`${key}_verdict`]!.probabilities!;
    const relEv = expected(answers[`${key}_rel`]!);
    const verdict = [...verdicts].sort((a, b) => p[b]! - p[a]!)[0]!;
    return [key, { rel: integer(relEv), act: 0, verdict, why: "", pMust: p.must!, pMaybe: p.maybe!, pSkip: p.skip!, relEv }];
  })) as Record<RoleKey, { rel: number; act: number; verdict: typeof verdicts[number]; why: string; pMust: number; pMaybe: number; pSkip: number; relEv: number }>;
  const values = { engine: "jev" as const, event: "", nov: { score: integer(expected(answers.nov!)), why: "" }, cred: { score: 0, why: "" }, roles, primary: [] as RoleKey[] };
  const { roleScores } = calculateJevRoleScores(values);
  values.primary = ROLE_KEYS.filter((key) => roles[key].rel >= 3).sort((a, b) => roleScores[b] - roleScores[a]).slice(0, 2);
  return values;
}
export type JevRoleScoringValues = ReturnType<typeof jevRoleValues>;
export function calculateJevRoleScores(values: JevRoleScoringValues) {
  const roleScores = Object.fromEntries(ROLE_KEYS.map((key) => [key, Math.round((2 * values.roles[key].pMust + values.roles[key].pMaybe) * 1000) / 1000])) as Record<RoleKey, number>;
  const selectedRoles = ROLE_KEYS.filter((key) => roleScores[key] >= SELECTION.industryRoles.jevThresholds[key]);
  const browseRoles = ROLE_KEYS.filter((key) => values.roles[key].relEv >= SELECTION.industryRoles.browseMinRel)
    .sort((a, b) => roleScores[b] - roleScores[a] || ROLE_KEYS.indexOf(a) - ROLE_KEYS.indexOf(b)).slice(0, SELECTION.industryRoles.maxBrowseRoles);
  return { roleScores, selectedRoles, browseRoles };
}
