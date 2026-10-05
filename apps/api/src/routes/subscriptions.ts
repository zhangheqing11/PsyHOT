import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SubscriptionRejected, confirmSubscription, subscribe, unsubscribe } from "@aihot/backend/notify/subscriptions";
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
      const email = String((req.body as { email?: unknown } | null)?.email ?? "");
      await subscribe(email, String(req.headers["x-real-ip"] ?? req.ip ?? ""));
      // The same answer for a new, an unconfirmed and an already confirmed address.
      return reply.header("Cache-Control", "no-store").code(202).send({ ok: true });
    } catch (error) {
      return failed(req, reply, error);
    }
  });

  app.post("/api/site/subscriptions/confirm", async (req, reply) => {
    const token = tokenOf((req.body as { token?: unknown } | null)?.token);
    try {
      const email = token ? await confirmSubscription(token) : null;
      if (!email) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "这个确认链接已失效，请重新订阅。" });
      return reply.header("Cache-Control", "no-store").send({ email });
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
