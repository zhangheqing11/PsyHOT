// Daily report subscriptions by email, with double opt-in: an address gets nothing but one
// confirmation email until its owner confirms, and unsubscribing deletes it. The same answer is given
// whether or not an address was already subscribed, so the form does not reveal who reads the site.
// The daily send runs after the morning report: each issue goes once to each confirmed address.
import { randomBytes } from "node:crypto";
import { beijingDate } from "@aihot/contracts/time";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { loadReport } from "../publication/reports.ts";
import { confirmationEmail, dailyEmail, dailyNotice } from "./email-render.ts";
import { emailReady, sendMail } from "./email.ts";

export class SubscriptionRejected extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** A confirmation is sent again only after this long (a second click on the form sends nothing). */
const RESEND_AFTER_MINUTES = 10;
/** Confirmation emails per day across the site: a cap on what a scripted form could make us send. */
const CONFIRMATIONS_PER_DAY = 200;
/** Unconfirmed addresses are deleted after this many days. */
const PENDING_DAYS = 7;
/** A failed send to one address is tried again on later runs, at most this many times in all. */
const MAX_ATTEMPTS = 3;

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** The address as stored (trimmed, domain in lower case), or null when it is not one. */
export function normalizeEmail(raw: string): string | null {
  const s = raw.trim();
  if (s.length > 254 || !EMAIL.test(s)) return null;
  const at = s.lastIndexOf("@");
  if (at > 64) return null;
  return `${s.slice(0, at)}@${s.slice(at + 1).toLowerCase()}`;
}

/** zh***@163.com: enough for its owner to recognise, not the whole address. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

const perIp = new Map<string, number[]>();
function rateLimit(ip: string, perHour = 5): void {
  const now = Date.now();
  const list = (perIp.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (list.length >= perHour) throw new SubscriptionRejected(429, "rate_limited", "提交太频繁，请稍后再试。", 600);
  list.push(now);
  perIp.set(ip, list);
  if (perIp.size > 5000) for (const [k, v] of perIp) if (v.every((t) => now - t > 3600_000)) perIp.delete(k);
}

/**
 * Starts a subscription: a new address is stored unconfirmed and sent the confirmation; an unconfirmed
 * one is sent it again (not more than once in ten minutes); a confirmed one is left as it is.
 */
export async function subscribe(rawEmail: string, ip: string): Promise<void> {
  if (!emailReady()) throw new SubscriptionRejected(503, "unavailable", "邮件订阅暂未开放。");
  const email = normalizeEmail(rawEmail);
  if (!email) throw new SubscriptionRejected(400, "invalid_email", "邮箱地址格式不对，请检查一下。");
  rateLimit(ip || "unknown");

  const [existing] = await sql<{ id: number; token: string; status: string; resend: boolean }[]>`
    SELECT id, token, status, coalesce(confirm_sent_at < now() - make_interval(mins => ${RESEND_AFTER_MINUTES}), true) AS resend
    FROM email_subscribers WHERE lower(email) = lower(${email})`;
  if (existing && (existing.status === "active" || !existing.resend)) return;

  const [today] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM email_subscribers WHERE confirm_sent_at > now() - interval '1 day'`;
  if (today!.n >= CONFIRMATIONS_PER_DAY) throw new SubscriptionRejected(503, "busy", "今天的订阅人数较多，请明天再试。", 3600);

  const token = existing?.token ?? randomBytes(24).toString("base64url");
  const [row] = existing
    ? await sql<{ id: number }[]>`UPDATE email_subscribers SET confirm_sent_at = now(), updated_at = now() WHERE id = ${existing.id} RETURNING id`
    : await sql<{ id: number }[]>`
        INSERT INTO email_subscribers (email, token, status, confirm_sent_at) VALUES (${email}, ${token}, 'pending', now())
        ON CONFLICT (lower(email)) DO NOTHING RETURNING id`;
  if (!row) return; // the same address submitted twice at once: the other request sends
  try {
    await sendMail({ to: email, ...confirmationEmail(token) });
  } catch (error) {
    // Nothing reached the reader: forget a new address, and let an old one be sent again at once.
    if (existing) await sql`UPDATE email_subscribers SET confirm_sent_at = NULL WHERE id = ${row.id}`;
    else await sql`DELETE FROM email_subscribers WHERE id = ${row.id}`;
    console.error("[email] confirmation failed", (error as Error).message);
    throw new SubscriptionRejected(503, "send_failed", "确认邮件没有发出去，请稍后再试。", 60);
  }
}

/** Confirms the address the token was sent to; returns it masked, or null for an unknown token. */
export async function confirmSubscription(token: string): Promise<string | null> {
  const [row] = await sql<{ email: string }[]>`
    UPDATE email_subscribers SET status = 'active', confirmed_at = coalesce(confirmed_at, now()), updated_at = now()
    WHERE token = ${token} RETURNING email`;
  return row ? maskEmail(row.email) : null;
}

/** Deletes the address the token belongs to (and its delivery records); true when there was one. */
export async function unsubscribe(token: string): Promise<boolean> {
  const rows = await sql`DELETE FROM email_subscribers WHERE token = ${token} RETURNING id`;
  return rows.length > 0;
}

const unsubscribeUrl = (token: string) => `${config.siteUrl}/unsubscribe?t=${encodeURIComponent(token)}`;
const oneClickUrl = (token: string) => `${config.siteUrl}/api/site/subscriptions/one-click?t=${encodeURIComponent(token)}`;

/** The mail service refused the message for its content (Alibaba Cloud: "554 Reject by content spam"). */
const contentRefused = (error: unknown) => /content spam/i.test(String((error as Error)?.message ?? ""));

/**
 * Sends today's daily report to every confirmed address that has not had it. Runs every few minutes:
 * nothing happens before the report exists, an issue with nothing in it is not sent, and an address
 * confirmed later in the day still gets that day's issue. When the mail service's content screening
 * refuses the full issue, the short notice (dailyNotice) goes instead, for the rest of the run too.
 */
export async function sendDailyEmails(now = new Date()): Promise<{ key: string; sent: number; failed: number; notices: number } | null> {
  await sql`DELETE FROM email_subscribers WHERE status = 'pending' AND created_at < now() - make_interval(days => ${PENDING_DAYS})`;
  if (!emailReady()) return null;
  const key = beijingDate(now);
  const report = await loadReport("daily", key);
  if (!report) return null;
  const due = await sql<{ id: number; email: string; token: string }[]>`
    SELECT s.id, s.email, s.token FROM email_subscribers s
    LEFT JOIN email_deliveries d ON d.subscriber_id = s.id AND d.report_key = ${key}
    WHERE s.status = 'active' AND (d.subscriber_id IS NULL OR (d.status = 'failed' AND d.attempts < ${MAX_ATTEMPTS}))
    ORDER BY s.id`;
  let sent = 0;
  let failed = 0;
  let noticeOnly = false;
  let notices = 0;
  for (const s of due) {
    if (shutdownSignal.signal.aborted) break; // the next run continues
    const mail = dailyEmail(report, unsubscribeUrl(s.token));
    if (!mail) return { key, sent, failed, notices };
    // Claim the (address, issue) pair; a pair left "sending" by a crash is in doubt and is not sent again.
    const [claim] = await sql`
      INSERT INTO email_deliveries (subscriber_id, report_key, status) VALUES (${s.id}, ${key}, 'sending')
      ON CONFLICT (subscriber_id, report_key) DO UPDATE SET status = 'sending', attempts = email_deliveries.attempts + 1, updated_at = now()
        WHERE email_deliveries.status = 'failed' AND email_deliveries.attempts < ${MAX_ATTEMPTS}
      RETURNING subscriber_id`;
    if (!claim) continue;
    const headers = { "List-Unsubscribe": `<${oneClickUrl(s.token)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
    try {
      let note: string | null = null;
      if (!noticeOnly) {
        try {
          await sendMail({ to: s.email, ...mail, headers });
        } catch (error) {
          if (!contentRefused(error)) throw error;
          noticeOnly = true;
        }
      }
      if (noticeOnly) {
        await sendMail({ to: s.email, ...dailyNotice(report, unsubscribeUrl(s.token)), headers });
        note = "full issue refused for its content; the short notice was sent";
        notices += 1;
      }
      await sql`UPDATE email_deliveries SET status = 'sent', sent_at = now(), error = ${note}, updated_at = now() WHERE subscriber_id = ${s.id} AND report_key = ${key}`;
      sent += 1;
    } catch (error) {
      await sql`UPDATE email_deliveries SET status = 'failed', error = ${String((error as Error).message).slice(0, 500)}, updated_at = now()
                WHERE subscriber_id = ${s.id} AND report_key = ${key}`;
      failed += 1;
    }
  }
  return { key, sent, failed, notices };
}
