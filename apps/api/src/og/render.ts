// 1200×630 share images. satori lays out text with Noto Sans SC (assets/og-fonts) and emits glyphs
// as paths, so rasterising with sharp needs no system fonts. Output is cached on disk by content.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import satori from "satori";
import sharp from "sharp";
import { SITE } from "@aihot/industry/site";
import { config, REPO_ROOT } from "@aihot/backend/config";

export const OG_TEMPLATE_VERSION = "og-2026-10-01.1";
const WIDTH = 1200;
const HEIGHT = 630;
const CACHE_DIR = path.join(config.dataDir, "ogcache");

export interface OgCard {
  kicker: string;
  title: string;
  subtitle?: string | null;
  meta?: string | null;
  /** Small emphasised figure on the right (e.g. an item score). */
  badge?: { value: string; label: string } | null;
  accent?: "violet" | "hot" | "amber";
}

let fontsPromise: Promise<Array<{ name: string; data: Buffer; weight: 400 | 700; style: "normal" }>> | null = null;

export function fonts() {
  fontsPromise ??= Promise.all([
    readFile(path.join(REPO_ROOT, "assets/og-fonts/noto-sans-sc-400.ttf")),
    readFile(path.join(REPO_ROOT, "assets/og-fonts/noto-sans-sc-700.ttf")),
  ]).then(([regular, bold]) => [
    { name: "Noto Sans SC", data: regular, weight: 400, style: "normal" },
    { name: "Noto Sans SC", data: bold, weight: 700, style: "normal" },
  ]);
  return fontsPromise;
}

/** The site's host as shown on cards. */
export const SITE_HOST = new URL(config.siteUrl).host;

/** The site name as a wordmark: bold, with the accent dot the cards use. */
export function nameMark(size: number, color: string, dot: string): Node {
  return h("div", { display: "flex", alignItems: "center" }, [
    h("div", { width: size * 0.36, height: size * 0.36, borderRadius: 999, backgroundColor: dot, marginRight: size * 0.28 }),
    h("div", { display: "flex", fontSize: size, fontWeight: 700, color, letterSpacing: 0.5 }, SITE.name),
  ]);
}

export type Node = { type: string; props: Record<string, unknown> & { style?: Record<string, unknown>; children?: unknown } };
export const h = (type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): Node => ({ type, props: { style, children, ...extra } });

const ACCENTS = { violet: "#b5a4f0", hot: "#e27586", amber: "#d8b36a" } as const;

function clamp(text: string, max: number) {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

async function tree(card: OgCard): Promise<Node> {
  const accent = ACCENTS[card.accent ?? "violet"];
  const title = clamp(card.title, 64);
  const titleSize = [...title].length > 40 ? 50 : [...title].length > 24 ? 58 : 66;
  return h(
    "div",
    {
      width: WIDTH,
      height: HEIGHT,
      display: "flex",
      flexDirection: "column",
      padding: "64px 72px",
      fontFamily: "Noto Sans SC",
      color: "#ece8f4",
      backgroundColor: "#15131b",
      backgroundImage: "radial-gradient(circle at 88% 8%, rgba(181,164,240,0.22), rgba(21,19,27,0) 46%), radial-gradient(circle at 0% 100%, rgba(94,74,142,0.32), rgba(21,19,27,0) 50%)",
    },
    [
      h("div", { display: "flex", alignItems: "center", justifyContent: "space-between" }, [
        nameMark(34, "#ece8f4", "#b5a4f0"),
        h("div", { display: "flex", fontSize: 24, color: "#8e87a2" }, SITE_HOST),
      ]),
      h("div", { display: "flex", marginTop: 56, alignItems: "center" }, [
        h("div", { width: 10, height: 10, borderRadius: 999, backgroundColor: accent, marginRight: 14 }),
        h("div", { display: "flex", fontSize: 28, fontWeight: 700, color: accent, letterSpacing: 1 }, clamp(card.kicker, 30)),
      ]),
      h("div", { display: "flex", flex: 1, marginTop: 22, gap: 40 }, [
        h("div", { display: "flex", flexDirection: "column", flex: 1 }, [
          h("div", { display: "flex", fontSize: titleSize, fontWeight: 700, lineHeight: 1.25, color: "#ffffff" }, title),
          // Long titles take three lines; the summary then gets one line so nothing reaches the footer.
          card.subtitle ? h("div", { display: "flex", marginTop: 22, fontSize: 28, lineHeight: 1.5, color: "#c3bdd2" }, clamp(card.subtitle, [...title].length > 40 ? 26 : [...title].length > 24 ? 50 : 78)) : null,
        ].filter(Boolean)),
        card.badge
          ? h("div", { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", width: 170, height: 170, borderRadius: 999, border: `6px solid ${accent}` }, [
              h("div", { display: "flex", fontSize: 58, fontWeight: 700, color: "#ffffff" }, card.badge.value),
              h("div", { display: "flex", fontSize: 22, color: "#8e87a2" }, card.badge.label),
            ])
          : null,
      ].filter(Boolean)),
      card.meta ? h("div", { display: "flex", fontSize: 24, color: "#8e87a2", borderTop: "1px solid rgba(236,232,244,0.12)", paddingTop: 22 }, clamp(card.meta, 70)) : null,
    ].filter(Boolean),
  );
}

/**
 * Palette PNG at full quality with dithering: the flat card and its soft glow look the same as a
 * truecolour PNG at about half the bytes (117 → 62 KB for a typical article card). Share crawlers
 * keep getting PNG.
 */
export const OG_PNG = { compressionLevel: 9, palette: true, quality: 100, dither: 1, effort: 10 } as const;

export function ogEtag(card: OgCard): string {
  return createHash("sha256").update(OG_TEMPLATE_VERSION).update(SITE.name).update(SITE_HOST).update(JSON.stringify(card)).digest("hex").slice(0, 24);
}

/** PNG bytes for a card, from the disk cache when this exact card was rendered before. */
const inflight = new Map<string, Promise<{ png: Buffer; etag: string }>>();

export function renderOg(card: OgCard): Promise<{ png: Buffer; etag: string }> {
  const etag = ogEtag(card);
  let job = inflight.get(etag);
  if (!job) {
    job = render(card, etag).finally(() => inflight.delete(etag));
    inflight.set(etag, job);
  }
  return job;
}

async function render(card: OgCard, etag: string): Promise<{ png: Buffer; etag: string }> {
  const file = path.join(CACHE_DIR, `${etag}.png`);
  try {
    return { png: await readFile(file), etag };
  } catch {
    // not cached yet
  }
  const svg = await satori(await tree(card) as never, { width: WIDTH, height: HEIGHT, fonts: await fonts() });
  const png = await sharp(Buffer.from(svg)).png(OG_PNG).toBuffer();
  await mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, png);
  await rename(tmp, file);
  return { png, etag };
}
