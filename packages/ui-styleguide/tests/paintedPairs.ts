/**
 * Every (foreground, background) pair the shipped stylesheets actually paint,
 * plus the palettes that still miss WCAG AA on one of them.
 *
 * The package's central claim is that any `data-palette` a user can select is
 * accessible. Proving that needs a table, not a spot check: the previous suite
 * asserted three pairs behind a per-key `continue` and an `if` guard that
 * skipped precisely when the primary foreground was the thing failing, so no
 * assertion in it could fail.
 *
 * Backgrounds are resolved to exact unrounded channels. `mixColors` rounds each
 * channel to an integer; a browser evaluating `color-mix(in srgb, ...)` does
 * not, and at least one shipped pair (`one` dark `--success` on its own soft
 * tint) sits in the gap between the two.
 */
import { contrastRatioOf, type Rgb } from "../src/contrastRatio.ts";
import { mixChannels } from "../src/mixColors.ts";
import { rgbChannels } from "../src/rgbChannels.ts";
import type { ThemeVariantTokens } from "../src/ThemeVariantTokens.ts";
import { SOFT_TINT_AMOUNT } from "../src/themeTokens.ts";

/** WCAG AA for normal-size text. The sheet's type scale tops out at 24px bold nowhere near the large-text exemption for body copy. */
export const AA_MINIMUM = 4.5;

/** The four surface tokens `ThemeVariantTokens` documents as interchangeable elevations. */
const SURFACES = ["bg", "surface", "surface2", "surface3"] as const;

/** The graded foreground ramp, most to least prominent. */
export const TEXT_RAMP = ["text", "textMuted", "textFaint", "textPlaceholder"] as const;

const SEMANTICS = ["brand", "success", "danger", "warning", "info"] as const;

/** Composite an `rgba(...)` token over an already-resolved background. */
function rgbaOver(color: string, background: Rgb): Rgb {
  const parsed = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(color);
  if (parsed === null) throw new TypeError(`expected an rgb()/rgba() token, received ${JSON.stringify(color)}`);
  const alpha = parsed[4] === undefined ? 1 : Number(parsed[4]);
  const channels = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])] as const;
  return channels.map((channel, index) => channel * alpha + background[index]! * (1 - alpha)) as unknown as Rgb;
}

/** One audited pair: a label a failure can be read from, and both resolved colors. */
export type PaintedPair = {
  readonly label: string;
  readonly foreground: (variant: ThemeVariantTokens) => Rgb;
  readonly background: (variant: ThemeVariantTokens) => Rgb;
};

/**
 * The table. Each entry names the rule in `src/index.ts` or
 * `src/standaloneThemeCss.ts` that paints it, so an entry can be retired when
 * its rule goes away and a new rule can be checked against the list.
 *
 * Backgrounds are the RESOLVED fill for the state, not the first declaration
 * that mentions it. `.primary:hover` matches the generic `.button:hover` rule
 * too, so the tinted states restate their own `background`; if that ever stops
 * being true, the resolved pair is `brand` on `--hover`, which is not here.
 */
export const PAINTED_PAIRS: readonly PaintedPair[] = [
  // body/h1-h3 (`--text`), p/.muted/.meta/.section-head/.label/.table th
  // (`--muted`), and input::placeholder (`--text-placeholder`), on every
  // surface elevation a consumer may place them on.
  ...TEXT_RAMP.flatMap((token) =>
    SURFACES.map((surface): PaintedPair => ({
      label: `${token} on ${surface}`,
      foreground: (variant) => rgbChannels(variant[token]),
      background: (variant) => rgbChannels(variant[surface]),
    }))
  ),
  // .button:hover, .run-row:hover, .workflow-run-row:hover
  ...(["text", "textMuted"] as const).map((token): PaintedPair => ({
    label: `${token} on hover`,
    foreground: (variant) => rgbChannels(variant[token]),
    background: (variant) => rgbChannels(variant.hover),
  })),
  // .button:active:not(:disabled)
  {
    label: "text on the neutral active fill",
    foreground: (variant) => rgbChannels(variant.text),
    background: (variant) => mixChannels(variant.text, variant.hover, 0.06),
  },
  // `.top,.topbar`: the one translucent background this sheet paints text on.
  // It sits directly on the shell, whose background is `--bg`, and carries the
  // title, meta text, and brand-colored pills.
  ...(["text", "textMuted", "textFaint", "textPlaceholder", "brand"] as const).map((token): PaintedPair => ({
    label: `${token} on the glass topbar over bg`,
    foreground: (variant) => rgbChannels(variant[token]),
    background: (variant) => rgbaOver(variant.surfaceGlassStrong, rgbChannels(variant.bg)),
  })),
  // .badge.ok/.warn/.running/.info/.bad and .pill, whose text is the semantic
  // color on the matching `*-soft` tint.
  ...SEMANTICS.map((semantic): PaintedPair => ({
    label: `${semantic} on ${semantic}-soft`,
    foreground: (variant) => rgbChannels(variant[semantic]),
    background: (variant) => mixChannels(variant[semantic], variant.surface, SOFT_TINT_AMOUNT),
  })),
  // .plus/.minus, .error-text, .alert.err, and every untinted semantic label.
  ...SEMANTICS.flatMap((semantic) =>
    SURFACES.map((surface): PaintedPair => ({
      label: `${semantic} on ${surface}`,
      foreground: (variant) => rgbChannels(variant[semantic]),
      background: (variant) => rgbChannels(variant[surface]),
    }))
  ),
  // .code/.source/pre.code and .livelog + .livelog-event + .livelog-node.
  {
    label: "codeText on codeBg",
    foreground: (variant) => rgbChannels(variant.codeText),
    background: (variant) => rgbChannels(variant.codeBg),
  },
  {
    label: "brand on codeBg",
    foreground: (variant) => rgbChannels(variant.brand),
    background: (variant) => rgbChannels(variant.codeBg),
  },
  {
    label: "warning on codeBg",
    foreground: (variant) => rgbChannels(variant.warning),
    background: (variant) => rgbChannels(variant.codeBg),
  },
  // Inverted chrome (`--ink`, tooltips, inverse buttons) and `::selection`,
  // which inverts rather than tinting so the selected pair does not depend on
  // which run of text the user dragged over.
  {
    label: "inverseText on inverseBg",
    foreground: (variant) => rgbChannels(variant.inverseText),
    background: (variant) => rgbChannels(variant.inverseBg),
  },
];

/** `contrastRatio` for one pair of one variant, from exact channels. */
export function ratioFor(pair: PaintedPair, variant: ThemeVariantTokens): number {
  return contrastRatioOf(pair.foreground(variant), pair.background(variant));
}

/**
 * Pairs that still miss AA, as `palette/mode/label`.
 *
 * Every entry traces to one upstream seed this package cannot re-seed:
 * `scripts/generate-theme-registry.ts` takes `editor.foreground` raw for
 * `--text` and the terminal foreground, applies its contrast ratchet only to
 * the three secondary tokens, and gives up silently at `amount === 1` instead
 * of failing. `src/themes/*.ts` are byte-for-byte generator output guarded by
 * `tests/generatedThemes.test.ts`, so re-seeding them means changing the
 * generator, which lives outside this package.
 *
 * The suite asserts both directions: nothing outside this list may fail, and
 * nothing inside it may pass. Fixing the generator therefore forces the entry
 * out rather than leaving a stale exemption behind.
 */
export const KNOWN_CONTRAST_GAPS: ReadonlyMap<string, number> = new Map([
["solarized/light/text on bg", 4.1296],
  ["solarized/light/text on surface", 4.3819],
  ["solarized/light/text on surface2", 4.1193],
  ["solarized/light/text on surface3", 4.4546],
  ["solarized/light/textMuted on bg", 4.1296],
  ["solarized/light/textMuted on surface", 4.3819],
  ["solarized/light/textMuted on surface2", 4.1193],
  ["solarized/light/textMuted on surface3", 4.4546],
  ["solarized/light/textFaint on bg", 4.1296],
  ["solarized/light/textFaint on surface", 4.3819],
  ["solarized/light/textFaint on surface2", 4.1193],
  ["solarized/light/textFaint on surface3", 4.4546],
  ["solarized/light/textPlaceholder on bg", 4.1296],
  ["solarized/light/textPlaceholder on surface", 4.3819],
  ["solarized/light/textPlaceholder on surface2", 4.1193],
  ["solarized/light/textPlaceholder on surface3", 4.4546],
  ["solarized/light/text on hover", 4.1193],
  ["solarized/light/textMuted on hover", 4.1193],
  ["solarized/light/text on the neutral active fill", 3.8499],
  ["solarized/light/text on the glass topbar over bg", 4.3432],
  ["solarized/light/textMuted on the glass topbar over bg", 4.3432],
  ["solarized/light/textFaint on the glass topbar over bg", 4.3432],
  ["solarized/light/textPlaceholder on the glass topbar over bg", 4.3432],
  ["solarized/light/codeText on codeBg", 4.1296],
  ["solarized/light/inverseText on inverseBg", 4.1296],
  ["solarized/dark/text on surface", 4.3939],
  ["solarized/dark/text on surface2", 4.1596],
  ["solarized/dark/text on surface3", 3.9251],
  ["solarized/dark/textMuted on surface", 4.3939],
  ["solarized/dark/textMuted on surface2", 4.1596],
  ["solarized/dark/textMuted on surface3", 3.9251],
  ["solarized/dark/textFaint on surface", 4.3939],
  ["solarized/dark/textFaint on surface2", 4.1596],
  ["solarized/dark/textFaint on surface3", 3.9251],
  ["solarized/dark/textPlaceholder on surface", 4.3939],
  ["solarized/dark/textPlaceholder on surface2", 4.1596],
  ["solarized/dark/textPlaceholder on surface3", 3.9251],
  ["solarized/dark/text on hover", 4.1596],
  ["solarized/dark/textMuted on hover", 4.1596],
  ["solarized/dark/text on the neutral active fill", 3.8358],
  ["solarized/dark/text on the glass topbar over bg", 4.4463],
  ["solarized/dark/textMuted on the glass topbar over bg", 4.4463],
  ["solarized/dark/textFaint on the glass topbar over bg", 4.4463],
  ["solarized/dark/textPlaceholder on the glass topbar over bg", 4.4463],
]);

/**
 * Terminal palettes whose own foreground misses AA on their own background.
 * Same upstream cause: the generator applies no ratchet to `terminal.foreground`.
 */
export const KNOWN_TERMINAL_GAPS: ReadonlyMap<string, number> = new Map([
  ["solarized/light", 4.1296],
]);

/**
 * Variants whose secondary-text ramp is flat rather than graded, as
 * `palette/mode/<more prominent> > <less prominent>`.
 *
 * `secondaryText()` in the generator raises its mix amount until the value
 * clears its target, and at `amount === 1` `mix(text, bg, 1) === text`, so it
 * returns the base foreground with no failure signal.
 */
export const KNOWN_RAMP_COLLAPSES: ReadonlySet<string> = new Set([
  "one/dark/text > textMuted",
  "solarized/light/text > textMuted",
  "solarized/light/textMuted > textFaint",
  "solarized/light/textFaint > textPlaceholder",
  "solarized/dark/text > textMuted",
  "solarized/dark/textMuted > textFaint",
  "solarized/dark/textFaint > textPlaceholder",
]);

/**
 * Semantic role pairs that share one hex, as `palette/mode/<a>=<b>`.
 * `rose-pine` gives `success` and `info` the same value in both modes, so a
 * passing state and an informational state are indistinguishable.
 */
export const KNOWN_ROLE_COLLISIONS: ReadonlySet<string> = new Set([
  "rose-pine/light/success=info",
  "rose-pine/dark/success=info",
]);

export { SEMANTICS, SURFACES };
