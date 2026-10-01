// The site's wordmark (its name from industry/site.ts, set in type, after the Ψ of the site icon) and a
// small ring mark used as the loader. A site with its own logo can replace Wordmark here.
import { SITE } from "@aihot/industry/site";

export function Wordmark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center font-black leading-none tracking-[-0.03em] ${className}`} style={{ fontSize: size }} aria-label={SITE.name} role="img">
      <PsiMark className="mr-[0.26em] size-[0.86em] text-accent" />
      <span aria-hidden="true">{SITE.name}</span>
    </span>
  );
}

/** The Ψ of industry/brand/logo.svg, drawn in the current colour. */
export function PsiMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="96 96 320 320" className={className} aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="50" strokeLinecap="round" strokeLinejoin="round">
        <path d="M150 146V226C150 312 196 352 256 352C316 352 362 312 362 226V146" />
        <path d="M256 118V412" />
      </g>
    </svg>
  );
}

/** A ring with a dot; spinning, it is the loader. */
export function RingMark({ className = "", spinning = false }: { className?: string; spinning?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <g style={spinning ? { transformOrigin: "12px 12px", animation: "spin-slow 1.1s linear infinite" } : undefined}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeDasharray="42 15" />
      </g>
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
    </svg>
  );
}
