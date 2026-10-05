// Outgoing email over SMTP (Alibaba Cloud DirectMail in production; any SMTP service works). EMAIL_ENABLED is
// the safety valve: off, or without a server and a sender address, nothing is sent.
import { SITE } from "@aihot/industry/site";
import nodemailer, { type Transporter } from "nodemailer";
import { config, credential } from "../config.ts";

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

const setting = (name: string) => credential("integrations", name);

/** Whether subscriptions are open and mail can leave: the valve is on and a server and sender are set. */
export function emailReady(): boolean {
  return config.emailEnabled && !!setting("EMAIL_SMTP_HOST") && !!setting("EMAIL_FROM");
}

let transport: Transporter | null = null;

function mailer(): Transporter {
  if (transport) return transport;
  const port = Number(setting("EMAIL_SMTP_PORT") ?? 465);
  const user = setting("EMAIL_SMTP_USER");
  transport = nodemailer.createTransport({
    host: setting("EMAIL_SMTP_HOST")!,
    port,
    secure: port === 465,
    auth: user ? { user, pass: setting("EMAIL_SMTP_PASS") ?? "" } : undefined,
    // One connection reused, at most 10 messages a second (well under the providers' limits).
    pool: true,
    maxConnections: 1,
    rateDelta: 1000,
    rateLimit: 10,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return transport;
}

export async function sendMail(mail: OutgoingMail): Promise<void> {
  if (!emailReady()) throw new Error("email is off (EMAIL_ENABLED, EMAIL_SMTP_HOST, EMAIL_FROM)");
  // Replies reach the site's contact address unless another is set.
  const replyTo = setting("EMAIL_REPLY_TO") ?? SITE.contactEmail;
  await mailer().sendMail({ from: setting("EMAIL_FROM")!, ...(replyTo ? { replyTo } : {}), ...mail });
}

/** Closes the pooled connection (worker shutdown, tests). */
export function closeMailer(): void {
  transport?.close();
  transport = null;
}
