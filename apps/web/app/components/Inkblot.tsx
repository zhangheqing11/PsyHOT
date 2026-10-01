// The site's signature: a Rorschach-style blot drawn from a seed (inkblot-shape.ts). Three passes of the
// same drops melt into one mirrored shape: a faint bleed into the paper, the ink itself, and a denser wet
// core, so the blot has the uneven tone of real ink. It takes the text colour (currentColor) and renders
// on the server; the same seed always gives the same plate.
import { useId } from "react";
import { inkblotShape, SHEET, type InkDot } from "./inkblot-shape";

const MIRROR = `matrix(-1 0 0 1 ${SHEET.width} 0)`;
const REGION = { x: "-10%", y: "-10%", width: "120%", height: "120%" };

/** Blur the drops together, then cut the edge at an alpha threshold (`slope`, `offset`). */
function Melt({ id, blur, slope, offset }: { id: string; blur: number; slope: number; offset: number }) {
  return (
    <filter id={id} {...REGION}>
      <feGaussianBlur stdDeviation={blur} />
      <feColorMatrix type="matrix" values={`1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${slope} ${offset}`} />
    </filter>
  );
}

function Drops({ dots }: { dots: InkDot[] }) {
  return (
    <>
      {dots.map((d, i) => (
        <circle key={i} cx={d.x.toFixed(1)} cy={d.y.toFixed(1)} r={d.r.toFixed(1)} />
      ))}
    </>
  );
}

/** Both halves of the sheet: the drops as dropped, and their mirror across the fold. */
function Folded({ dots }: { dots: InkDot[] }) {
  return (
    <>
      <g>
        <Drops dots={dots} />
      </g>
      <g transform={MIRROR}>
        <Drops dots={dots} />
      </g>
    </>
  );
}

export function Inkblot({ seed, className = "" }: { seed: string; className?: string }) {
  const id = `ink${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const { dots, holes } = inkblotShape(seed);
  const core = dots.filter((d) => d.r > 4).map((d) => ({ ...d, r: d.r * 0.62 }));
  return (
    <svg viewBox={`0 0 ${SHEET.width} ${SHEET.height}`} className={className} aria-hidden="true" focusable="false">
      <defs>
        <Melt id={`${id}-bleed`} blur={5.5} slope={9} offset={-3} />
        <Melt id={`${id}-ink`} blur={3.2} slope={20} offset={-8} />
        <Melt id={`${id}-core`} blur={3.4} slope={9} offset={-3.6} />
        <mask id={`${id}-dry`}>
          <rect width={SHEET.width} height={SHEET.height} fill="#fff" />
          <g fill="#000">
            <Folded dots={holes} />
          </g>
        </mask>
      </defs>
      <g fill="currentColor" mask={`url(#${id}-dry)`}>
        <g filter={`url(#${id}-bleed)`} opacity={0.28}>
          <Folded dots={dots} />
        </g>
        <g filter={`url(#${id}-ink)`} opacity={0.74}>
          <Folded dots={dots} />
        </g>
        <g filter={`url(#${id}-core)`} opacity={0.9}>
          <Folded dots={core} />
        </g>
      </g>
    </svg>
  );
}
