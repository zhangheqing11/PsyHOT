// The site's Agent Skill: its name, version and where the package is served. The API builds the files
// (packages/backend/src/publication/skill.ts); the agent page shows how to install them.
import { SITE } from "@aihot/industry/site";

export const SKILL_NAME = SITE.mcpPrefix;
export const SKILL_VERSION = "1.0.0";
export const SKILL_PATH = `/${SKILL_NAME}-skill`;
/** The files installed into the agent's skills folder, in manifest order. */
export const SKILL_FILES = ["SKILL.md", "LICENSE", "agents/openai.yaml"] as const;
