// /api/v1/agent: Markdown answers for AI agents (and the site's Skill), and the Skill package under
// /<prefix>-skill/. Errors are the usual v1 Problem JSON. New abilities become new addresses listed in
// the guide, which agents read without updating.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { V1_CACHE_CONTROL } from "@aihot/contracts/http-policy";
import { PUBLIC_API_CATEGORY_KEYS, type PublicApiCategoryKey } from "@aihot/contracts/taxonomy";
import { isValidDate } from "@aihot/contracts/time";
import { agentGuide, dailyAnswer, hotAnswer, latestAnswer, periodAnswer, searchAnswer, searchItems, storyAnswer, type DailyReport } from "@aihot/backend/publication/agent";
import { v1Items } from "@aihot/backend/publication/v1";
import { resolveStory, v1HotTopics, v1Story } from "@aihot/backend/publication/stories";
import { listReports, loadReport, v1Daily } from "@aihot/backend/publication/reports";
import { SKILL_PATH, skillFile } from "@aihot/backend/publication/skill";
import { QueryError, sendProblem, sendTextWithEtag, strictQuery } from "../http/respond.ts";
import { enumParam, intParam, publicHandler } from "./v1.ts";

const PERIOD_KEY = { weekly: /^\d{4}-W\d{2}$/, monthly: /^\d{4}-\d{2}$/ } as const;

function markdown(req: FastifyRequest, reply: FastifyReply, text: string, etagPrefix: string, cacheControl: string) {
  return sendTextWithEtag(req, reply, text, { etagPrefix, cacheControl, contentType: "text/markdown; charset=utf-8" });
}

function listParams(q: Record<string, string>) {
  return {
    window: enumParam(q.window, "window", ["24h", "7d"] as const, "24h"),
    category: q.category === undefined ? null : enumParam<PublicApiCategoryKey>(q.category, "category", PUBLIC_API_CATEGORY_KEYS, PUBLIC_API_CATEGORY_KEYS[0]),
    limit: intParam(q.limit, "limit", 1, 30, 10),
  };
}

export function registerAgent(app: FastifyInstance) {
  app.get("/api/v1/agent", publicHandler(async (req, reply) => {
    strictQuery(req, []);
    // Short-lived: agents learn a new ability within minutes of its release.
    return markdown(req, reply, agentGuide(), "agent-guide", "public, max-age=300, must-revalidate");
  }));

  app.get("/api/v1/agent/latest", publicHandler(async (req, reply) => {
    const q = strictQuery(req, ["window", "mode", "category", "limit"]);
    const p = { ...listParams(q), mode: enumParam(q.mode, "mode", ["selected", "all"] as const, "selected") };
    const res = await v1Items({ ...p, by: "timeline", q: null, cursor: null });
    return markdown(req, reply, latestAnswer(res, p), "agent-latest", V1_CACHE_CONTROL.items);
  }));

  app.get("/api/v1/agent/search", publicHandler(async (req, reply) => {
    const q = strictQuery(req, ["q", "window", "category", "limit"]);
    const text = (q.q ?? "").trim();
    if ([...text].length < 2 || [...text].length > 200) throw new QueryError("q must contain 2 to 200 characters.");
    const p = { ...listParams(q), window: enumParam(q.window, "window", ["24h", "7d"] as const, "7d") };
    const found = await searchItems(text, p.window, p.category, p.limit);
    return markdown(req, reply, searchAnswer(found, { q: text, window: p.window, category: p.category }), "agent-search", V1_CACHE_CONTROL.items);
  }));

  app.get("/api/v1/agent/hot", publicHandler(async (req, reply) => {
    const q = strictQuery(req, ["limit"]);
    return markdown(req, reply, hotAnswer(await v1HotTopics(), intParam(q.limit, "limit", 1, 10, 10)), "agent-hot", V1_CACHE_CONTROL.hotTopics);
  }));

  app.get("/api/v1/agent/stories/:publicId", publicHandler(async (req, reply) => {
    const q = strictQuery(req, ["limit"]);
    const limit = intParam(q.limit, "limit", 1, 50, 20);
    const publicId = (req.params as { publicId: string }).publicId;
    if (publicId.length > 128) throw new QueryError("publicId must be a short opaque id.");
    let found = await resolveStory(publicId);
    if (found.kind === "merged") found = await resolveStory(found.target);
    const body = found.kind === "found" ? await v1Story(found.storyId) : null;
    if (!body) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "没有这个公开事件。只使用热点结果里给出的「来龙去脉」地址，不要猜。", cacheControl: "public, max-age=60" });
    return markdown(req, reply, storyAnswer(body.story, limit), "agent-story", V1_CACHE_CONTROL.storyByPublicId);
  }));

  const daily = async (req: FastifyRequest, reply: FastifyReply, date: string | "latest") => {
    const res = await v1Daily(date);
    if (!res) return sendProblem(req, reply, { status: 404, code: "not_found", detail: date === "latest" ? "还没有发布过日报。" : `没有 ${date} 的日报。`, cacheControl: "public, max-age=60" });
    return markdown(req, reply, dailyAnswer(res.report as DailyReport), "agent-daily", date === "latest" ? V1_CACHE_CONTROL.latestDaily : V1_CACHE_CONTROL.dailyByDate);
  };
  app.get("/api/v1/agent/daily", publicHandler(async (req, reply) => {
    strictQuery(req, []);
    return daily(req, reply, "latest");
  }));
  app.get("/api/v1/agent/daily/:date", publicHandler(async (req, reply) => {
    strictQuery(req, []);
    const date = (req.params as { date: string }).date;
    if (!isValidDate(date)) throw new QueryError("date must be a real YYYY-MM-DD calendar date.");
    return daily(req, reply, date);
  }));

  for (const kind of ["weekly", "monthly"] as const) {
    const name = kind === "weekly" ? "周报" : "月报";
    const period = async (req: FastifyRequest, reply: FastifyReply, key: string | null) => {
      const latest = key ?? (await listReports(kind, 1))[0]?.key ?? null;
      const report = latest ? await loadReport(kind, latest) : null;
      if (!report) return sendProblem(req, reply, { status: 404, code: "not_found", detail: key ? `没有 ${key} 这一期${name}。` : `还没有发布过${name}。`, cacheControl: "public, max-age=60" });
      return markdown(req, reply, periodAnswer(report, kind), `agent-${kind}`, V1_CACHE_CONTROL.latestDaily);
    };
    app.get(`/api/v1/agent/${kind}`, publicHandler(async (req, reply) => {
      strictQuery(req, []);
      return period(req, reply, null);
    }));
    app.get(`/api/v1/agent/${kind}/:key`, publicHandler(async (req, reply) => {
      strictQuery(req, []);
      const key = (req.params as { key: string }).key;
      if (!PERIOD_KEY[kind].test(key)) throw new QueryError(kind === "weekly" ? "week must look like 2026-W40." : "month must look like 2026-09.");
      return period(req, reply, key);
    }));
  }

  // The Skill package: install notes, the three Skill files, their checksums and the installer.
  app.get(SKILL_PATH, async (_req, reply) => reply.redirect(`${SKILL_PATH}/README.md`, 302));
  app.get(`${SKILL_PATH}/`, async (_req, reply) => reply.redirect(`${SKILL_PATH}/README.md`, 302));
  app.get(`${SKILL_PATH}/*`, async (req, reply) => {
    const file = skillFile((req.params as { "*": string })["*"]);
    if (!file) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "Skill 包里没有这个文件。", cacheControl: "public, max-age=60" });
    reply.header("Access-Control-Allow-Origin", "*");
    return sendTextWithEtag(req, reply, file.body, { etagPrefix: "skill", cacheControl: "public, max-age=300, must-revalidate", contentType: file.type });
  });
}
