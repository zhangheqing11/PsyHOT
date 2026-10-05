// The site's emails: the subscription confirmation and the daily report. Mail clients ignore style
// sheets, so the layout is one table with inline styles in the site's colours; every email also has a
// plain-text part.
import type { ReportCitation, ReportDetail } from "@aihot/contracts/site";
import { SITE, withSubject } from "@aihot/industry/site";
import { config } from "../config.ts";
import { escapeHtml } from "../lib/text.ts";

const C = { bg: "#f4f3f7", paper: "#ffffff", ink: "#241f35", ink2: "#4a4560", muted: "#7a7590", line: "#e4e1ec", accent: "#5e4a8e" };
const FONT = `-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif`;

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

const e = escapeHtml;

function layout(o: { preheader: string; body: string; footer: string }): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${e(SITE.name)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${e(o.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:${C.paper};border:1px solid ${C.line};border-radius:10px;font-family:${FONT};color:${C.ink};">
<tr><td style="padding:22px 28px 14px;border-bottom:2px solid ${C.ink};">
<a href="${e(config.siteUrl)}" style="color:${C.ink};text-decoration:none;font-size:20px;font-weight:800;letter-spacing:-0.01em;">${e(SITE.name)}</a>
<span style="color:${C.muted};font-size:13px;margin-left:8px;">${e(SITE.tagline)}</span>
</td></tr>
<tr><td style="padding:8px 28px 24px;">${o.body}</td></tr>
<tr><td style="padding:18px 28px 24px;border-top:1px solid ${C.line};color:${C.muted};font-size:12px;line-height:1.8;">${o.footer}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

const button = (href: string, label: string) =>
  `<a href="${e(href)}" style="display:inline-block;background:${C.accent};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:11px 26px;border-radius:8px;">${e(label)}</a>`;

const link = (href: string, label: string, color = C.ink) => `<a href="${e(href)}" style="color:${color};text-decoration:none;">${e(label)}</a>`;

/** The email that asks the address's owner to confirm; nothing else is sent until they do. */
export function confirmationEmail(token: string): RenderedMail {
  const url = `${config.siteUrl}/subscribe/confirm?t=${encodeURIComponent(token)}`;
  const daily = withSubject("日报");
  const body = `
<h1 style="font-size:20px;line-height:1.5;margin:18px 0 10px;">确认订阅 ${e(SITE.name)} ${e(daily)}</h1>
<p style="font-size:15px;line-height:1.8;color:${C.ink2};margin:0 0 20px;">有人（希望是你）用这个邮箱订阅了 ${e(SITE.name)} ${e(daily)}。确认后，每天早上日报出炉就会发到这里。</p>
<p style="margin:0 0 22px;">${button(url, "确认订阅")}</p>
<p style="font-size:13px;line-height:1.8;color:${C.muted};margin:0;">按钮打不开的话，把这个地址复制到浏览器：<br><span style="word-break:break-all;">${e(url)}</span></p>`;
  const footer = `如果不是你本人订阅的，忽略这封邮件即可：不确认，就不会再收到我们的邮件，这个地址会在 7 天后删除。`;
  return {
    subject: `确认订阅 ${SITE.name} ${daily}`,
    html: layout({ preheader: `点一下确认，每天早上收到${daily}。`, body, footer }),
    text: `确认订阅 ${SITE.name} ${daily}\n\n有人（希望是你）用这个邮箱订阅了 ${SITE.name} ${daily}。确认后，每天早上日报出炉就会发到这里。\n\n确认订阅：${url}\n\n如果不是你本人订阅的，忽略这封邮件即可：不确认，就不会再收到我们的邮件，这个地址会在 7 天后删除。\n`,
  };
}

/** Where a citation is read: its page on the site, else the original; null once withdrawn. */
function hrefOf(c: ReportCitation): string | null {
  if (!c.available) return null;
  return c.itemId ? `${config.siteUrl}/items/${c.itemId}` : c.sourceUrl || null;
}

const dayLabel = (key: string) => {
  const [, m, d] = key.split("-").map(Number);
  return `${m}月${d}日`;
};

/** One daily report as an email; null when the issue has nothing to send. */
export function dailyEmail(report: ReportDetail, unsubscribeUrl: string): RenderedMail | null {
  const sections = report.sections
    .map((s) => ({ label: s.label, items: s.items.filter((c) => hrefOf(c)) }))
    .filter((s) => s.items.length > 0);
  const flashes = report.flashes.filter((c) => hrefOf(c));
  if (sections.length === 0 && flashes.length === 0) return null;

  const daily = withSubject("日报");
  const issueUrl = `${config.siteUrl}/daily/${report.key}`;
  const subject = report.lead ? `${daily} ${dayLabel(report.key)}｜${report.lead.title}` : `${SITE.name} ${daily} · ${dayLabel(report.key)}`;
  const count = sections.reduce((n, s) => n + s.items.length, 0) + flashes.length;

  const html: string[] = [];
  const text: string[] = [`${SITE.name} ${daily} · ${report.key}`, ""];
  html.push(`<p style="font-size:13px;color:${C.muted};margin:14px 0 4px;">${e(daily)} · ${e(report.key)} · 共 ${count} 条</p>`);
  if (report.lead) {
    html.push(`<h1 style="font-size:22px;line-height:1.45;margin:4px 0 10px;">${e(report.lead.title)}</h1>`);
    html.push(`<p style="font-size:15px;line-height:1.85;color:${C.ink2};margin:0 0 6px;">${e(report.lead.leadParagraph)}</p>`);
    text.push(report.lead.title, "", report.lead.leadParagraph, "");
  }
  for (const s of sections) {
    html.push(`<h2 style="font-size:16px;margin:26px 0 4px;padding-bottom:6px;border-bottom:1px solid ${C.ink};color:${C.accent};">${e(s.label)}</h2>`);
    text.push(`【${s.label}】`, "");
    for (const c of s.items) {
      const href = hrefOf(c)!;
      html.push(`<div style="padding:12px 0;border-bottom:1px solid ${C.line};">
<div style="font-size:16px;font-weight:700;line-height:1.55;">${link(href, c.title)}</div>
${c.summary ? `<div style="font-size:14px;line-height:1.8;color:${C.ink2};margin-top:4px;">${e(c.summary)}</div>` : ""}
<div style="font-size:12px;color:${C.muted};margin-top:4px;">${e(c.sourceName)}</div>
</div>`);
      text.push(`· ${c.title}`, ...(c.summary ? [`  ${c.summary}`] : []), `  ${c.sourceName} ${href}`, "");
    }
  }
  if (flashes.length > 0) {
    html.push(`<h2 style="font-size:16px;margin:26px 0 4px;padding-bottom:6px;border-bottom:1px solid ${C.ink};color:${C.accent};">快讯</h2>`);
    text.push("【快讯】", "");
    for (const c of flashes) {
      const href = hrefOf(c)!;
      html.push(`<div style="padding:8px 0;border-bottom:1px solid ${C.line};font-size:14px;line-height:1.7;">${link(href, c.title)} <span style="font-size:12px;color:${C.muted};">${e(c.sourceName)}</span></div>`);
      text.push(`· ${c.title}（${c.sourceName}）${href}`);
    }
    text.push("");
  }
  html.push(`<p style="margin:26px 0 0;text-align:center;">${button(issueUrl, "在网站上阅读本期")}</p>`);
  text.push(`在网站上阅读本期：${issueUrl}`, "");

  const footer = [
    `你收到这封邮件，是因为订阅了 ${e(SITE.name)} ${e(daily)}。不想再收到？${link(unsubscribeUrl, "一键退订", C.accent)}`,
    SITE.footerNote ? e(SITE.footerNote) : "",
  ].filter(Boolean).join("<br>");
  text.push("——", `你收到这封邮件，是因为订阅了 ${SITE.name} ${daily}。退订：${unsubscribeUrl}`, ...(SITE.footerNote ? [SITE.footerNote] : []));

  return {
    subject,
    html: layout({ preheader: report.lead?.leadParagraph.slice(0, 90) ?? subject, body: html.join("\n"), footer }),
    text: text.join("\n"),
  };
}
