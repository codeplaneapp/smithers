import type { SVGProps } from "react";

/**
 * The Smithers brand mark: a rounded-square badge with a search-ring glyph. One
 * source of geometry for both the persistent {@link CornerLogo} and the
 * first-run splash mark (onboarding SmithersIntro) — they must stay pixel-identical
 * for the splash's fly-to-corner hand-off to read as one continuous motion.
 *
 * Each caller passes a `part` prefix so its own stylesheet can target the pieces
 * (`${part}-bg` / `${part}-ring` / `${part}-stem`) for color and animation. Fill
 * and strokes resolve from the shared --logo-* tokens. Remaining SVG props
 * (className, role, aria-*, onAnimationEnd) pass straight through.
 */
export function SmithersMark({
  part,
  ...svgProps
}: { part: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 512 512" {...svgProps}>
      <rect className={`${part}-bg`} width="512" height="512" rx="96" />
      <circle
        className={`${part}-ring`}
        cx="230"
        cy="230"
        r="112"
        fill="none"
        strokeWidth="44"
      />
      <path
        className={`${part}-stem`}
        d="M310 310l84 84"
        strokeWidth="52"
        strokeLinecap="round"
      />
    </svg>
  );
}
