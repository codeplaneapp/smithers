# Public API

`@smthrs/ui-styleguide` ships as source. The export map has one entry, `.`,
pointing at `src/index.ts`; there is no build step and no runtime dependency.
Consumers import it under Node ESM, Bun, and browser bundlers, so every relative
specifier inside `src/` carries its `.ts` extension.

## Stylesheets

| Export | Type | What it is |
| --- | --- | --- |
| `workflowUiThemeCss` | `string` | Theme tokens plus the base element and primitive rules (buttons, inputs, pills and badges, cards, tables, code and livelog). 33 KB. |
| `workflowUiLayoutCss` | `string` | The `.workflow-*` shell and dashboard grid classes. 2 KB. |
| `workflowUiStyles` | `string` | Both of the above joined, for one-tag embedding. |
| `standaloneThemeCss()` | `() => string` | A complete theme for HTML rendered outside a Smithers UI shell, with `"` selector quoting. 26 KB. Built once at module evaluation; repeat calls return the same string. |
| `reducedMotionCss` | `string` | The document-wide reduced-motion guard, already composed into both sheets above. |
| `themeCss(options?)` | `(options?: { palettes?: readonly string[] }) => string` | Just the token rules, optionally for a subset of palettes. Throws `RangeError` naming an unregistered key. |

Every sheet grows by roughly 2.9 KB per registered palette. A host that pins one
palette calls `themeCss({ palettes: ["one"] })` (7.7 KB) instead of shipping all
eight (24.9 KB).

## Registry

| Export | Type | What it is |
| --- | --- | --- |
| `themeRegistry` | `DeepReadonly<Record<ThemeKey, SmithersTheme>>` | The eight palettes, in emission order. |
| `DEFAULT_THEME_KEY` | `"night-owl"` | The palette the base `:root` rule carries. |
| `findTheme(key)` | `(key: string) => theme \| undefined` | Registry lookup for an unvalidated `data-palette` value. |
| `ThemeKey` | type | The registered `data-palette` values. |

The registry is **deeply frozen at construction** and typed to match. That is
load bearing: `workflowUiThemeCss` snapshots it at module evaluation while
widget adapters read it per render, so a runtime mutation would give one
document two different answers for the same selected theme. Copy before
editing.

## Serialization

`serializeThemeVariant(variant, options?)` turns one `ThemeVariantTokens` into
the joined declaration string a rule body needs.

- `options.fonts` (default `false`) adds the theme-invariant font block. Exactly
  one rule in a stylesheet should set it. Palette rules are
  `:root[data-palette='<key>']`, specificity (0,2,0), so restating fonts there
  out-ranks a consumer's own bare-`:root` overrides.
- Input is trusted but checked. Every token is read as an own data property
  (accessors are rejected) and must be a non-empty string of at most 160
  characters with no CSS or markup delimiter, because the result is
  interpolated into a stylesheet verbatim. Violations throw `TypeError` naming
  the property.

## Color math

`contrastRatio(foreground, background)` returns the WCAG 2.x ratio, 1 to 21.
Both arguments must be **opaque** `#rgb`, `#rrggbb`, or `#rrggbbaa` with
`aa === ff`. Anything else throws `TypeError` quoting the offending value:

- A translucent color has no contrast ratio of its own. `#00000000` on white is
  not 21:1, it is whatever the invisible text sits on. Composite first.
- Six of the 29 tokens in every variant are `rgba(...)` by construction, and so
  is `TerminalPalette.selectionBackground`. Passing one used to return `NaN`,
  and `NaN >= 4.5` is `false`, so a caller read "fails contrast" instead of
  "unsupported input".
- An over-long hex is rejected, not sliced: `"#123456789"` is an error, not
  `"#123456"`.

`mixColors(foreground, background, amount)` is the srgb mix the house recipes
use, matching `color-mix(in srgb, fg <amount>%, bg)` with `amount` as a 0-1
fraction. It drops alpha on its inputs, requires a finite `amount` in `[0, 1]`,
and rounds the result to `#rrggbb`.

`mixChannels(...)` returns the same mix as **unrounded** 0-255 channels, and
`contrastRatioOf(fg, bg)` scores an already-parsed pair. It takes numbers, not
hex, so the parser that guards `contrastRatio` never sees its input: it checks
that each argument is three finite channels from 0 to 255 and throws `TypeError`
otherwise. Unrounded values are legal; negative, `NaN`, `Infinity`, and over-255
ones are not, because each of those returns a number outside the documented
1-to-21 range instead of an error. Use the pair when auditing a `color-mix`
recipe: browsers evaluate `color-mix` in floating point,
and rounding can change the verdict. The 12% `one` dark `--success` tint recipe
that shipped before `SOFT_TINT_AMOUNT` was lowered scored 4.5033 with rounded
channels but 4.4781 with rendered channels. The current 10% recipe scores 4.6329
rounded and 4.6469 rendered, so it clears AA.

## Recipe constants

`SOFT_TINT_AMOUNT` (0.1) is the ceiling for a semantic fill that carries text in
its own semantic color. `STRONG_TINT_AMOUNT` (0.16) is for fills that carry no
tinted text. The test suite reads these constants, so the recipes and their
proof cannot drift apart.

## Types

`SmithersTheme`, `ThemeVariantTokens`, `TerminalPalette`, `ThemeSyntaxId`,
`ThemeKey`, `DeepReadonly`, `Rgb`, `PaletteThemeCssOptions`, and
`SerializeThemeVariantOptions`.

`Rgb` is `readonly [number, number, number]`, the parsed 0-255 srgb channels
that `mixChannels` returns and `contrastRatioOf` scores. Its channels are
unrounded on purpose, so the pair a `color-mix` recipe is audited against is the
one the browser renders.

`tests/docs.test.ts` reads this page against the barrel and fails when an export
is missing from it, so the list above cannot fall behind `src/index.ts`.
