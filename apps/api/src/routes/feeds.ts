// RSS routes. Unknown query parameters are accepted and never change content.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { RSS_CACHE_CONTROL } from "@aihot/contracts/http-policy";
import { dailyFeed, isFeedCategory, itemFeed, type ItemFeedKind } from "@aihot/backend/publication/feeds";
import { isRegionKey, isTrackKey } from "@aihot/contracts/taxonomy";
import { applyPublicHeaders, sendTextWithEtag } from "../http/respond.ts";

async function sendFeed(req: FastifyRequest, reply: FastifyReply, xml: string) {
  applyPublicHeaders(reply, { cors: false });
  return sendTextWithEtag(req, reply, xml, { etagPrefix: "rss", cacheControl: RSS_CACHE_CONTROL, contentType: "application/rss+xml; charset=utf-8" });
}

function feedError(reply: FastifyReply) {
  return reply.code(503).header("Retry-After", "60").header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send("Feed temporarily unavailable");
}

export function registerFeeds(app: FastifyInstance) {
  // A preflight gets 204 and the allowed methods; feeds send no CORS headers.
  for (const url of ["/feed.xml", "/feed/full.xml", "/feed/all.xml", "/feed/daily.xml", "/feed/category/:file", "/feed/full/category/:file", "/feed/track/:file", "/feed/full/track/:file"]) {
    app.options(url, async (_req, reply) => reply.code(204).header("Allow", "GET, HEAD, OPTIONS").send());
  }
  const item = (kind: ItemFeedKind) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await sendFeed(req, reply, await itemFeed(kind, null));
    } catch (error) {
      req.log.error({ err: error }, "feed error");
      return feedError(reply);
    }
  };
  app.get("/feed.xml", item("selected"));
  app.get("/feed/full.xml", item("selected-full"));
  app.get("/feed/all.xml", item("all"));
  app.get("/feed/daily.xml", async (req, reply) => {
    try {
      return await sendFeed(req, reply, await dailyFeed());
    } catch (error) {
      req.log.error({ err: error }, "feed error");
      return feedError(reply);
    }
  });
  for (const full of [false, true]) {
    app.get(full ? "/feed/full/category/:file" : "/feed/category/:file", async (req, reply) => {
      const file = (req.params as { file: string }).file;
      const slug = file.replace(/\.xml$/, "");
      if (!file.endsWith(".xml") || !isFeedCategory(slug)) return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
      try {
        return await sendFeed(req, reply, await itemFeed(full ? "selected-full" : "selected", slug));
      } catch (error) {
        req.log.error({ err: error }, "feed error");
        return feedError(reply);
      }
    });
  }
  for (const full of [false, true]) {
    app.get(full ? "/feed/full/track/:file" : "/feed/track/:file", async (req, reply) => {
      const file = (req.params as { file: string }).file;
      const slug = file.replace(/\.xml$/, "");
      const rawRegion = (req.query as { region?: string }).region;
      const region = rawRegion ? rawRegion.trim() : null;
      if (!file.endsWith(".xml") || !isTrackKey(slug) || (region !== null && !isRegionKey(region))) return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
      try {
        return await sendFeed(req, reply, await itemFeed(full ? "selected-full" : "selected", null, slug, region));
      } catch (error) {
        req.log.error({ err: error }, "feed error");
        return feedError(reply);
      }
    });
  }
}
