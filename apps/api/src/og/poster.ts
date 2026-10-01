// Share posters (1080×1440 PNG) for articles, made for phones: saved from the page or long-pressed in
// chat apps. Same font pipeline as the share cards; the QR code opens the article on the site.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import satori from "satori";
import sharp from "sharp";
import { renderSVG } from "uqr";
import { SITE } from "@aihot/industry/site";
import { config } from "@aihot/backend/config";
import { fonts, h, nameMark, OG_PNG, SITE_HOST, type Node } from "./render.ts";

export const POSTER_TEMPLATE_VERSION = "poster-2026-10-01.1";
const WIDTH = 1080;
const HEIGHT = 1440;
const CACHE_DIR = path.join(config.dataDir, "ogcache");

export interface Poster {
  url: string;
  kicker: string;
  title: string;
  summary: string | null;
  source: string;
  date: string;
  score: number | null;
}


function clamp(text: string, max: number) {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

const INK = "#241f35";
const ACCENT = "#5e4a8e";

async function tree(p: Poster): Promise<Node> {
  const title = clamp(p.title, 72);
  const len = [...title].length;
  const titleSize = len > 48 ? 58 : len > 30 ? 66 : 76;
  // The summary takes the room the title leaves.
  const summary = p.summary ? clamp(p.summary, len > 48 ? 120 : len > 30 ? 150 : 180) : null;
  const qr = `data:image/svg+xml;base64,${Buffer.from(renderSVG(p.url, { border: 0, ecc: "M", blackColor: INK, whiteColor: "#ffffff" })).toString("base64")}`;
  return h(
    "div",
    {
      width: WIDTH,
      height: HEIGHT,
      display: "flex",
      flexDirection: "column",
      padding: "84px 88px 72px",
      fontFamily: "Noto Sans SC",
      color: INK,
      backgroundColor: "#f4f3f7",
      backgroundImage: "radial-gradient(circle at 100% 0%, rgba(94,74,142,0.14), rgba(244,243,247,0) 52%), radial-gradient(circle at 0% 100%, rgba(181,164,240,0.14), rgba(244,243,247,0) 45%)",
    },
    [
      h("div", { display: "flex", alignItems: "center", justifyContent: "space-between" }, [
        nameMark(44, INK, ACCENT),
        h("div", { display: "flex", fontSize: 26, color: "#686280" }, p.date),
      ]),
      h("div", { display: "flex", alignItems: "center", marginTop: 96 }, [
        h("div", { width: 12, height: 12, borderRadius: 999, backgroundColor: ACCENT, marginRight: 16 }),
        h("div", { display: "flex", fontSize: 30, fontWeight: 700, color: ACCENT, letterSpacing: 1 }, clamp(p.kicker, 20)),
        p.score !== null
          ? h("div", { display: "flex", marginLeft: 20, padding: "4px 16px", borderRadius: 999, backgroundColor: "rgba(94,74,142,0.09)", fontSize: 26, color: "#4f3d7a" }, `精选 · ${Math.round(p.score)} 分`)
          : null,
      ].filter(Boolean)),
      h("div", { display: "flex", marginTop: 30, fontSize: titleSize, fontWeight: 700, lineHeight: 1.3, color: INK }, title),
      summary ? h("div", { display: "flex", marginTop: 36, fontSize: 34, lineHeight: 1.7, color: "#352f47" }, summary) : null,
      h("div", { display: "flex", marginTop: 36, fontSize: 28, color: "#686280" }, clamp(`来源：${p.source}`, 34)),
      h("div", { display: "flex", flex: 1 }),
      h(
        "div",
        { display: "flex", alignItems: "center", padding: "36px 40px", borderRadius: 32, backgroundColor: "#ffffff", boxShadow: "0 1px 2px rgba(36,31,53,0.06), 0 12px 32px rgba(36,31,53,0.07)" },
        [
          h("img", { width: 200, height: 200 }, undefined, { src: qr, width: 200, height: 200 }),
          h("div", { display: "flex", flexDirection: "column", marginLeft: 44, flex: 1 }, [
            h("div", { display: "flex", fontSize: 36, fontWeight: 700, color: INK }, "长按识别二维码"),
            h("div", { display: "flex", marginTop: 14, fontSize: 28, lineHeight: 1.5, color: "#686280" }, "阅读全文、中文译文与原文链接"),
            h("div", { display: "flex", marginTop: 22, fontSize: 26, color: ACCENT }, SITE_HOST),
          ]),
        ],
      ),
      h("div", { display: "flex", justifyContent: "center", marginTop: 40, fontSize: 24, color: "#8e87a2" }, `${SITE.name} · ${SITE.tagline}`),
    ].filter(Boolean),
  );
}

export function posterEtag(p: Poster): string {
  return createHash("sha256").update(POSTER_TEMPLATE_VERSION).update(SITE.name).update(SITE_HOST).update(JSON.stringify(p)).digest("hex").slice(0, 24);
}

/** PNG bytes for a poster, from the disk cache when this exact poster was rendered before. */
const inflight = new Map<string, Promise<{ png: Buffer; etag: string }>>();

export function renderPoster(p: Poster): Promise<{ png: Buffer; etag: string }> {
  const etag = posterEtag(p);
  let job = inflight.get(etag);
  if (!job) {
    job = render(p, etag).finally(() => inflight.delete(etag));
    inflight.set(etag, job);
  }
  return job;
}

async function render(p: Poster, etag: string): Promise<{ png: Buffer; etag: string }> {
  const file = path.join(CACHE_DIR, `poster-${etag}.png`);
  try {
    return { png: await readFile(file), etag };
  } catch {
    // not cached yet
  }
  const svg = await satori((await tree(p)) as never, { width: WIDTH, height: HEIGHT, fonts: await fonts() });
  const png = await sharp(Buffer.from(svg)).png(OG_PNG).toBuffer();
  await mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, png);
  await rename(tmp, file);
  return { png, etag };
}
