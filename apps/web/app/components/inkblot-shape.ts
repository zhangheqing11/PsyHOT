// A Rorschach-style blot, grown from a seed: ink dropped on the left half of a 240×160 sheet (a spine
// along the fold, a few wings spreading out from it, small splatters and one or two dry holes), which
// the renderer mirrors across the fold and melts together. The same seed always gives the same blot,
// so a daily issue keeps its own plate.

export interface InkDot {
  x: number;
  y: number;
  r: number;
}

export interface InkblotShape {
  /** Ink on the left half; the fold is x = FOLD. */
  dots: InkDot[];
  /** Dry spots cut out of the ink, also on the left half. */
  holes: InkDot[];
}

export const SHEET = { width: 240, height: 160 } as const;
export const FOLD = SHEET.width / 2;

function hashSeed(s: string): number {
  let h = 2166136261;
  for (const ch of s) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function inkblotShape(seed: string): InkblotShape {
  const rnd = mulberry32(hashSeed(seed));
  const between = (a: number, b: number) => a + (b - a) * rnd();
  const dots: InkDot[] = [];
  const put = (x: number, y: number, r: number) => {
    const dot = { x: clamp(x, 12, FOLD), y: clamp(y, 12, SHEET.height - 12), r };
    dots.push(dot);
    return dot;
  };

  // The spine: ink pooled along the fold, a little wider in the middle.
  const top = between(20, 38);
  const bottom = between(120, 142);
  const spineCount = 5 + Math.floor(rnd() * 3);
  const spine: InkDot[] = [];
  for (let i = 0; i < spineCount; i++) {
    const t = i / (spineCount - 1);
    const swell = Math.sin(Math.PI * t);
    spine.push(put(FOLD - between(0, 9), top + (bottom - top) * t + between(-4, 4), between(6, 10) + swell * between(4, 8)));
  }

  // Wings: ink pressed outwards from the spine, thinning as it goes.
  const wings = 2 + Math.floor(rnd() * 2);
  for (let w = 0; w < wings; w++) {
    const from = spine[Math.floor(between(0.15, 0.85) * spine.length)]!;
    let angle = Math.PI + between(-0.8, 0.8);
    let r = between(9, 14);
    let x = from.x;
    let y = from.y;
    const steps = 4 + Math.floor(rnd() * 4);
    for (let s = 0; s < steps; s++) {
      const step = between(10, 15);
      x += Math.cos(angle) * step;
      y += Math.sin(angle) * step;
      put(x, y, r);
      r *= between(0.76, 0.9);
      angle += between(-0.5, 0.5);
    }
    // A wing often ends in a drop that broke away.
    if (rnd() < 0.6) put(x + Math.cos(angle) * (r + between(5, 10)), y + Math.sin(angle) * (r + between(5, 10)), Math.max(1.6, r * between(0.45, 0.8)));
  }

  // Splatters around the body.
  const splatters = 4 + Math.floor(rnd() * 6);
  const body = dots.length;
  for (let i = 0; i < splatters; i++) {
    const near = dots[Math.floor(rnd() * body)]!;
    const angle = Math.PI + between(-1.4, 1.4);
    const dist = near.r + between(5, 16);
    put(near.x + Math.cos(angle) * dist, near.y + Math.sin(angle) * dist, between(1.3, 3.4));
  }

  // One or two dry holes where the paper did not take the ink, set inside the spine's widest part.
  const holes: InkDot[] = [];
  const holeCount = rnd() < 0.7 ? 1 + Math.floor(rnd() * 2) : 0;
  for (let i = 0; i < holeCount; i++) {
    const at = spine[1 + Math.floor(rnd() * (spine.length - 2))]!;
    holes.push({ x: at.x - between(10, 18), y: at.y + between(-6, 6), r: between(2.5, 5.5) });
  }

  return { dots, holes };
}
