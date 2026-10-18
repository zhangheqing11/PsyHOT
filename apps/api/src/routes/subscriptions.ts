import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isSubscriptionTrack } from "@aihot/contracts/taxonomy";
import { SubscriptionRejected, confirmSubscription, setSubscriptionTrack, subscribe, subscriptionPreference, unsubscribe } from "@aihot/backend/notify/subscriptions";
import { sendProblem } from "../http/respond.ts";

const tokenOf = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(v) ? v : null);

function failed(req: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof SubscriptionRejected) return sendProblem(req, reply, { status: error.status, code: error.code, detail: error.message, retryAfter: error.retryAfter });
  req.log.error({ err: error }, "subscription failed");
  return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "暂时无法处理，请稍后再试。", retryAfter: 30 });
}

/** Daily report by email: subscribe, confirm from the email, unsubscribe from any issue. */
export function registerSubscriptions(app: FastifyInstance) {
  app.post("/api/site/subscriptions", async (req, reply) => {
    try {
      const body = req.body as { email?: unknown; track?: unknown } | null;
      // No track is the whole report, as before tracks.
      await subscribe(String(body?.email ?? ""), String(req.headers["x-real-ip"] ?? req.ip ?? ""), body?.track ?? "combined");
      // The same answer for a new, an unconfirmed and an already confirmed address.
      return reply.header("Cache-Control", "no-store").code(202).send({ ok: true });
    } catch (error) {
      return failed(req, reply, error);
    }
  });

  app.post("/api/site/subscriptions/confirm", async (req, reply) => {
    const token = tokenOf((req.body as { token?: unknown } | null)?.token);
    try {
      const confirmed = token ? await confirmSubscription(token) : null;
      if (!confirmed) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "这个确认链接已失效，请重新订阅。" });
      return reply.header("Cache-Control", "no-store").send(confirmed);
    } catch (error) {
      return failed(req, reply, error);
    }
  });

  // What the address behind a link reads, and a change of it (from the page the unsubscribe link opens).
  app.post("/api/site/subscriptions/preferences", async (req, reply) => {
    const token = tokenOf((req.body as { token?: unknown } | null)?.token);
    try {
      const preference = token ? await subscriptionPreference(token) : null;
      if (!preference) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "这个链接已失效。" });
      return reply.header("Cache-Control", "no-store").send(preference);
    } catch (error) {
      return failed(req, reply, error);
    }
  });

  app.post("/api/site/subscriptions/track", async (req, reply) => {
    const body = req.body as { token?: unknown; track?: unknown } | null;
    const token = tokenOf(body?.token);
    try {
      if (!isSubscriptionTrack(body?.track)) return sendProblem(req, reply, { status: 400, code: "invalid_track", detail: "订阅内容的选择不对，请重新选择。" });
      if (!token || !(await setSubscriptionTrack(token, body.track))) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "这个链接已失效。" });
      return reply.header("Cache-Control", "no-store").send({ track: body.track });
    } catch (error) {
      return failed(req, reply, error);
    }
  });

  app.post("/api/site/subscriptions/unsubscribe", async (req, reply) => {
    const token = tokenOf((req.body as { token?: unknown } | null)?.token);
    try {
      // Unsubscribing twice, or with a link of an address already gone, ends the same way.
      if (token) await unsubscribe(token);
      return reply.header("Cache-Control", "no-store").send({ ok: true });
    } catch (error) {
      return failed(req, reply, error);
    }
  });

  // One-click unsubscribe from the mail client (RFC 8058): a form-encoded POST to the List-Unsubscribe
  // address (forms are parsed for the whole api, see admin-auth.ts).
  app.post("/api/site/subscriptions/one-click", async (req, reply) => {
    const token = tokenOf((req.query as { t?: unknown }).t);
    try {
      if (token) await unsubscribe(token);
      return reply.header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send("已退订");
    } catch (error) {
      return failed(req, reply, error);
    }
  });
}
