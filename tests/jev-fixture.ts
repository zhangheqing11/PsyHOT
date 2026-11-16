import { ROLE_KEYS } from "@aihot/contracts/taxonomy";
import type { TypeSafeAnswer } from "@aihot/backend/providers/typesafe";

export function jevAnswers(): Record<string, TypeSafeAnswer> {
  return Object.fromEntries([
    ...ROLE_KEYS.flatMap((key) => [
      [`${key}_verdict`, { choice: "must", confidence: 0.6, probabilities: { must: 0.6, maybe: 0.3, skip: 0.1 } }],
      [`${key}_rel`, { probabilities: { 0: 0, 1: 0.25, 2: 0.75, 3: 0 } }],
    ]),
    ["nov", { probabilities: { 0: 0, 1: 0.5, 2: 0.5, 3: 0 } }],
  ]);
}
