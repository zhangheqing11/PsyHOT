// Daily report by email against a local SMTP server: double opt-in (one confirmation, nothing more
// until confirmed), the same answer for any address, one copy of an issue per address with a one-click
// unsubscribe, a refused address retried a bounded number of times, and unsubscribing deletes it.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import net from "node:net";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { closeMailer } from "@aihot/backend/notify/email";
import { maskEmail, normalizeEmail, sendDailyEmails } from "@aihot/backend/notify/subscriptions";
import { publishArticle } from "@aihot/backend/publication/publish";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `test-subscriptions-${T}`;
const REPORT_KEY = `2099-11-${String(10 + Math.floor(Math.random() * 19))}`;
const REFUSED = `refused-${T}@example.com`;
const NOTICE_KEY = `2099-12-${String(10 + Math.floor(Math.random() * 19))}`;
const TRACK_KEY = `2099-10-${String(10 + Math.floor(Math.random() * 19))}`;
const ONE_SIDED_KEY = `2099-09-${String(10 + Math.floor(Math.random() * 19))}`;
/** Content the local server refuses, as Alibaba Cloud's screening refuses some issues. */
const SCREENED = "SCREENED-CONTENT";

interface Received { to: string[]; data: string }
const mails: Received[] = [];
// A minimal SMTP server: accepts every message, refuses one recipient.
const smtp = net.createServer((sock) => {
  sock.setEncoding("utf8");
  let buf = "";
  let inData = false;
  let cur: Received = { to: [], data: "" };
  sock.write("220 test ESMTP\r\n");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    for (;;) {
      if (inData) {
        const end = buf.indexOf("\r\n.\r\n");
        if (end < 0) return;
        cur.data = buf.slice(0, end);
        buf = buf.slice(end + 5);
        inData = false;
        if (bodyOf(cur.data).includes(SCREENED)) sock.write("554 Reject by content spam [@sm190603] ANTISPAM_CAT: spam content\r\n");
        else (mails.push(cur), sock.write("250 queued\r\n"));
        cur = { to: [], data: "" };
        continue;
      }
      const nl = buf.indexOf("\r\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") sock.write("250-test\r\n250 8BITMIME\r\n");
      else if (cmd === "RCPT") {
        const addr = /<(.+)>/.exec(line)![1]!;
        if (addr === REFUSED) sock.write("550 no such user\r\n");
        else (cur.to.push(addr), sock.write("250 ok\r\n"));
      } else if (cmd === "DATA") (inData = true, sock.write("354 go ahead\r\n"));
      else if (cmd === "QUIT") sock.end("221 bye\r\n");
      else if (cmd === "MAIL" || cmd === "RSET") (cur = { to: [], data: "" }, sock.write("250 ok\r\n"));
      else sock.write("250 ok\r\n");
    }
  });
});
await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
process.env.EMAIL_SMTP_HOST = "127.0.0.1";
process.env.EMAIL_SMTP_PORT = String((smtp.address() as net.AddressInfo).port);
process.env.EMAIL_FROM = "PsyHOT <daily@example.com>";
config.emailEnabled = true;
const app = await buildApp();

/** The decoded text of every part of a message (quoted-printable or base64). */
function bodyOf(raw: string): string {
  return raw.split(/\r\n--[^\r\n]+\r\n/).map((part) => {
    const [head = "", ...rest] = part.split("\r\n\r\n");
    const body = rest.join("\r\n\r\n");
    if (/content-transfer-encoding:\s*base64/i.test(head)) return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
    if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) {
      return Buffer.from(body.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
    }
    return body;
  }).join("\n");
}
const mailsTo = (addr: string) => mails.filter((m) => m.to.includes(addr));
const tokenIn = (m: Received, path: string) => new RegExp(`${path.replace("/", "\\/")}\\?t=([A-Za-z0-9_-]+)`).exec(bodyOf(m.data))?.[1];

let ip = 0;
const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, payload: payload as object, headers: { "x-real-ip": `10.9.${T.length}.${++ip}` } });

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test subscriptions', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await sql`DELETE FROM email_subscribers WHERE email LIKE ${`%${T}%`}`;
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key IN (${REPORT_KEY}, ${NOTICE_KEY}, ${TRACK_KEY}, ${ONE_SIDED_KEY})`;
  closeMailer();
  await app.close();
  smtp.close();
  await stopBoss();
  await closeDb();
});

test("addresses: checked, stored with the domain in lower case, shown masked", () => {
  assert.equal(normalizeEmail("  Reader.One@163.COM "), "Reader.One@163.com");
  for (const bad of ["no-at-sign", "a@b", "a b@c.com", "a@-b.com", `${"x".repeat(65)}@c.com`]) assert.equal(normalizeEmail(bad), null, bad);
  assert.equal(maskEmail("reader@163.com"), "re***@163.com");
});

test("double opt-in: one confirmation, the same answer twice, active once confirmed", async () => {
  const addr = `reader-${T}@example.com`;
  assert.equal((await post("/api/site/subscriptions", { email: "not an address" })).statusCode, 400);
  const first = await post("/api/site/subscriptions", { email: addr });
  assert.equal(first.statusCode, 202);
  const again = await post("/api/site/subscriptions", { email: addr.toUpperCase().replace("EXAMPLE.COM", "example.com") });
  assert.equal(again.statusCode, 202, "a second request answers the same");
  assert.equal(mailsTo(addr).length, 1, "and sends nothing more within ten minutes");
  const [row] = await sql<{ status: string }[]>`SELECT status FROM email_subscribers WHERE lower(email) = lower(${addr})`;
  assert.equal(row!.status, "pending", "nothing is sent but the confirmation until it is confirmed");

  const token = tokenIn(mailsTo(addr)[0]!, "/subscribe/confirm");
  assert.ok(token, "the confirmation carries its link");
  assert.equal((await post("/api/site/subscriptions/confirm", { token: "x".repeat(32) })).statusCode, 404);
  const confirmed = await post("/api/site/subscriptions/confirm", { token });
  assert.equal(confirmed.statusCode, 200);
  assert.equal(JSON.parse(confirmed.body).email, maskEmail(addr));
  assert.equal((await post("/api/site/subscriptions", { email: addr })).statusCode, 202, "a confirmed address answers the same too");
  assert.equal(mailsTo(addr).length, 1);
});

test("an issue goes once to each confirmed address; a refused one is retried, then given up", async () => {
  const reader = `daily-${T}@example.com`;
  const pending = `pending-${T}@example.com`;
  await sql`INSERT INTO email_subscribers (email, token, status, confirmed_at) VALUES
    (${reader}, ${`tok-reader-${T}`}, 'active', now()), (${REFUSED}, ${`tok-refused-${T}`}, 'active', now()), (${pending}, ${`tok-pending-${T}`}, 'pending', NULL)`;
  const now = new Date(`${REPORT_KEY}T03:00:00Z`);
  assert.equal(await sendDailyEmails(now), null, "nothing before the report exists");

  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/subs-${T}`, title: "Attachment study", bodyText: `BODY ${T} `.repeat(40), bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  } as never);
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
            VALUES (${articleId}, 1, 'rule', 'pass', 'research', ${`依恋研究-${T}`}, '一项元分析。', '理由', 80, true)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  const citation = { itemId: articleId, title: `依恋研究-${T}`, summary: "一项元分析。", sourceName: "Test subscriptions", sourceUrl: `https://example.com/subs-${T}`, sourceId: SOURCE, firstParty: false, role: null, storyPublicId: null, publishedAt: new Date().toISOString() };
  const content = { date: REPORT_KEY, lead: { title: `今日导语-${T}`, leadParagraph: "今天的心理学研究。" }, highlights: [], sections: [{ label: "研究", items: [citation] }], flashes: [], metrics: {} };
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, model, origin)
            VALUES ('daily', ${REPORT_KEY}, now() - interval '1 day', now(), ${sql.json(content as never)}, now(), 'test', 'model')`;

  const first = await sendDailyEmails(now);
  assert.ok(first && first.sent >= 1 && first.failed >= 1);
  const issue = mailsTo(reader);
  assert.equal(issue.length, 1);
  assert.equal(mailsTo(pending).length, 0, "an unconfirmed address gets nothing");
  const text = bodyOf(issue[0]!.data);
  assert.ok(text.includes(`依恋研究-${T}`) && text.includes(`/items/${articleId}`), "the issue lists the item with its page");
  assert.ok(text.includes(`/unsubscribe?t=tok-reader-${T}`), "with an unsubscribe link");
  assert.match(issue[0]!.data, new RegExp(`List-Unsubscribe:\\s+<[^>]*/api/site/subscriptions/one-click\\?t=tok-reader-${T}>`));
  assert.match(issue[0]!.data, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);

  await sendDailyEmails(now);
  await sendDailyEmails(now);
  await sendDailyEmails(now);
  assert.equal(mailsTo(reader).length, 1, "the same issue is not sent twice");
  const [refused] = await sql<{ status: string; attempts: number; error: string }[]>`
    SELECT d.status, d.attempts, d.error FROM email_deliveries d JOIN email_subscribers s ON s.id = d.subscriber_id WHERE s.email = ${REFUSED} AND d.report_key = ${REPORT_KEY}`;
  assert.deepEqual([refused!.status, refused!.attempts], ["failed", 3], "a refused address is tried three times");
  assert.match(refused!.error, /550/);
});

test("an issue the mail service refuses for its content goes out as the short notice", async () => {
  const reader = `notice-${T}@example.com`;
  await sql`INSERT INTO email_subscribers (email, token, status, confirmed_at) VALUES (${reader}, ${`tok-notice-${T}`}, 'active', now())`;
  const citation = { itemId: null, title: `${SCREENED} 抑郁症研究-${T}`, summary: "一项研究。", sourceName: "Test", sourceUrl: "https://example.com/x", sourceId: null, firstParty: false, role: null, storyPublicId: null, publishedAt: null };
  const content = { date: NOTICE_KEY, lead: null, highlights: [], sections: [{ label: "研究", items: [citation, { ...citation, title: `另一条-${T}` }] }], flashes: [], metrics: {} };
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, model, origin)
            VALUES ('daily', ${NOTICE_KEY}, now() - interval '1 day', now(), ${sql.json(content as never)}, now(), 'test', 'model')`;

  const run = await sendDailyEmails(new Date(`${NOTICE_KEY}T03:00:00Z`));
  assert.ok(run && run.notices >= 1);
  const got = mailsTo(reader);
  assert.equal(got.length, 1, "one email, the notice");
  const text = bodyOf(got[0]!.data);
  assert.ok(text.includes(`/daily/${NOTICE_KEY}`) && text.includes("共 2 条"), "it links the issue and counts its entries");
  assert.ok(!text.includes(SCREENED), "without the refused content");
  assert.ok(text.includes("内容政策限制"), "and says why it is only a link");
  assert.ok(text.includes(`/unsubscribe?t=tok-notice-${T}`));
  const [d] = await sql<{ status: string; error: string }[]>`
    SELECT d.status, d.error FROM email_deliveries d JOIN email_subscribers s ON s.id = d.subscriber_id WHERE s.email = ${reader} AND d.report_key = ${NOTICE_KEY}`;
  assert.equal(d!.status, "sent");
  assert.match(d!.error, /short notice/);
});

test("unsubscribing from the page or the mail client deletes the address", async () => {
  const one = `oneclick-${T}@example.com`;
  const page = `page-${T}@example.com`;
  await sql`INSERT INTO email_subscribers (email, token, status, confirmed_at) VALUES
    (${one}, ${`tok-oneclick-${T}`}, 'active', now()), (${page}, ${`tok-page-${T}`}, 'active', now())`;
  const click = await app.inject({
    method: "POST", url: `/api/site/subscriptions/one-click?t=tok-oneclick-${T}`,
    payload: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  assert.equal(click.statusCode, 200);
  assert.equal((await post("/api/site/subscriptions/unsubscribe", { token: `tok-page-${T}` })).statusCode, 200);
  assert.equal((await post("/api/site/subscriptions/unsubscribe", { token: `tok-page-${T}` })).statusCode, 200, "twice is fine");
  const left = await sql`SELECT 1 FROM email_subscribers WHERE email IN (${one}, ${page})`;
  assert.equal(left.length, 0);
});

test("the track chosen at subscribing is kept, confirmed and changed from the link in the mail", async () => {
  const addr = `track-${T}@example.com`;
  assert.equal((await post("/api/site/subscriptions", { email: addr, track: "sideways" })).statusCode, 400, "only 综合, 学界 and 业界");
  assert.equal((await post("/api/site/subscriptions", { email: addr, track: "industry" })).statusCode, 202);
  assert.match(bodyOf(mailsTo(addr)[0]!.data), /业界版/, "the confirmation says which");
  const [row] = await sql<{ track: string }[]>`SELECT track FROM email_subscribers WHERE lower(email) = lower(${addr})`;
  assert.equal(row!.track, "industry");

  const token = tokenIn(mailsTo(addr)[0]!, "/subscribe/confirm")!;
  assert.deepEqual(JSON.parse((await post("/api/site/subscriptions/confirm", { token })).body), { email: maskEmail(addr), track: "industry" });
  assert.deepEqual(JSON.parse((await post("/api/site/subscriptions/preferences", { token })).body), { email: maskEmail(addr), track: "industry" });
  assert.equal((await post("/api/site/subscriptions/preferences", { token: "y".repeat(32) })).statusCode, 404);

  assert.equal((await post("/api/site/subscriptions/track", { token, track: "sideways" })).statusCode, 400);
  assert.equal((await post("/api/site/subscriptions/track", { token: "y".repeat(32), track: "academic" })).statusCode, 404);
  assert.equal((await post("/api/site/subscriptions/track", { token, track: "academic" })).statusCode, 200);
  const [after] = await sql<{ track: string; status: string }[]>`SELECT track, status FROM email_subscribers WHERE lower(email) = lower(${addr})`;
  assert.deepEqual([after!.track, after!.status], ["academic", "active"], "changed, and still subscribed");

  // Asked for without a track, a subscription is the whole report, as it was before tracks.
  const plain = `plain-${T}@example.com`;
  assert.equal((await post("/api/site/subscriptions", { email: plain })).statusCode, 202);
  assert.equal((await sql<{ track: string }[]>`SELECT track FROM email_subscribers WHERE email = ${plain}`)[0]!.track, "combined");
});

test("each subscriber gets the issue for their track; a track with nothing that day gets nothing", async () => {
  const citation = (title: string) => ({ itemId: null, title: `${title}-${T}`, summary: "摘要。", sourceName: "Test", sourceUrl: "https://example.com/x", sourceId: null, firstParty: false, role: null, storyPublicId: null, publishedAt: null });
  const lead = (title: string) => ({ lead: { title, leadParagraph: `${title}的导语。` }, highlights: [] });
  const store = (key: string, content: Record<string, unknown>) => sql`
    INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, model, origin)
    VALUES ('daily', ${key}, now() - interval '1 day', now(), ${sql.json(content as never)}, now(), 'test', 'model')`;
  await store(TRACK_KEY, {
    date: TRACK_KEY, lead: { title: "业界头条", leadParagraph: "业界的导语。" }, highlights: [],
    tracks: { academic: lead("学界头条"), industry: lead("业界头条") },
    sections: [{ label: "研究发现", track: "academic", items: [citation("学界条目")] }, { label: "行业与政策", track: "industry", items: [citation("业界条目")] }],
    flashes: [], metrics: {},
  });
  await store(ONE_SIDED_KEY, {
    date: ONE_SIDED_KEY, lead: { title: "只有学界", leadParagraph: "导语。" }, highlights: [], tracks: { academic: lead("只有学界") },
    sections: [{ label: "研究发现", track: "academic", items: [citation("学界条目")] }], flashes: [], metrics: {},
  });
  const who = { combined: `both-${T}@example.com`, academic: `acad-${T}@example.com`, industry: `ind-${T}@example.com` };
  for (const [track, email] of Object.entries(who)) {
    await sql`INSERT INTO email_subscribers (email, token, status, confirmed_at, track) VALUES (${email}, ${`tok-${track}-${T}`}, 'active', now(), ${track})`;
  }
  await sendDailyEmails(new Date(`${TRACK_KEY}T03:00:00Z`));
  const read = (email: string) => { const m = mailsTo(email); assert.equal(m.length, 1, email); return bodyOf(m[0]!.data); };
  const both = read(who.combined);
  assert.ok(both.includes(`学界条目-${T}`) && both.includes(`业界条目-${T}`) && both.includes("学界头条") && both.includes("业界的导语。"), "the whole report");
  const acad = read(who.academic);
  assert.ok(acad.includes(`学界条目-${T}`) && !acad.includes(`业界条目-${T}`) && !acad.includes("业界的导语。"), "only the academic side");
  assert.ok(acad.includes(`/daily/${TRACK_KEY}?track=academic`) && acad.includes(`/unsubscribe?t=tok-academic-${T}`));
  const ind = read(who.industry);
  assert.ok(ind.includes(`业界条目-${T}`) && !ind.includes(`学界条目-${T}`) && !ind.includes("学界头条"), "only the industry side");

  // A day with nothing on one side: that side's subscribers get no mail and no delivery record; the rest do.
  await sendDailyEmails(new Date(`${ONE_SIDED_KEY}T03:00:00Z`));
  assert.equal(mailsTo(who.combined).length, 2);
  assert.equal(mailsTo(who.academic).length, 2);
  assert.equal(mailsTo(who.industry).length, 1, "nothing for the industry track that day");
  const [none] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM email_deliveries d JOIN email_subscribers s ON s.id = d.subscriber_id WHERE s.email = ${who.industry} AND d.report_key = ${ONE_SIDED_KEY}`;
  assert.equal(none!.n, 0);
});

test("closed: nobody can subscribe and nothing is sent", async () => {
  config.emailEnabled = false;
  try {
    assert.equal((await post("/api/site/subscriptions", { email: `closed-${T}@example.com` })).statusCode, 503);
    assert.equal(await sendDailyEmails(new Date(`${REPORT_KEY}T03:00:00Z`)), null);
  } finally {
    config.emailEnabled = true;
  }
});
