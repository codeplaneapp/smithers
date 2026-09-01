# Theming

## Two orthogonal axes

A document picks a **palette** and a **mode**, independently.

- Palette: `data-palette="<key>"` on `<html>`, one of the eight registered keys.
  `apps/ui` stamps a user choice there; `@smthrs/ui` resolves it through
  `resolvePalette`, accepting only registered keys.
- Mode: `prefers-color-scheme` by default, overridden by `data-theme="light"` or
  `data-theme="dark"`.

`paletteThemeCss` emits, in this order:

1. `:root { ... }` with the default palette's light tokens, the shared
   theme-invariant tokens, and the one font block.
2. `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { ... } }`
3. `:root[data-theme='dark'] { ... }`
4. For every other palette: the same three shapes, prefixed with
   `[data-palette='<key>']`.

## Source order is the cascade

`:root[data-palette='<key>']` and `:root[data-theme='dark']` both compute to
specificity **(0,2,0)**. Nothing but source order stops the default palette's
dark tokens from overriding a selected palette's light tokens, so the default
rules must come first and every palette rule after. `tests/index.test.ts` pins
that order; do not reorder the emitter.

The same arithmetic is the reason `serializeThemeVariant` defaults
`fonts: false`. When the font block rode along with every light variant, all
eight `:root` rules declared `--font-sans`, and a consumer writing its own
overrides on bare `:root` (0,1,0) lost them the moment a palette was selected.
`packages/create-app/template/aomi/src/shell/theme.ts` is exactly that consumer.

## The WCAG AA discipline

The package's central claim is that any palette a user can select is accessible.
`tests/paintedPairs.ts` is that claim written down: a table of every
(foreground, background) pair the shipped stylesheets paint, checked at 4.5:1
across all eight palettes in both modes.

Backgrounds are resolved to **exact unrounded channels**, because `mixColors`
rounds and a browser evaluating `color-mix(in srgb, ...)` does not.

Two rules follow from the table:

- A tinted fill that carries text in the same semantic color is capped at
  `SOFT_TINT_AMOUNT` (10%). Above that, the darkest shipped seeds fall below AA.
  This is why hover and press on `.button.primary` and `.button.danger` move the
  border and the elevation rather than deepening the fill, and why they restate
  that fill: the generic `.button:hover` and `.button:active` rules match them
  too and out-rank the base rule. `tests/cascade.test.ts` resolves the sheet and
  pins what each state actually paints.
- Every fill under text must be a pair the table can name. The muted chips and
  inline code sit on the opaque `--surface-2` rather than the translucent
  `--hover-subtle` and `--inline-code-bg`, so their pair does not depend on the
  parent surface. `.top,.topbar` is the one translucent text background left,
  and the table composites it over `--bg` twice: once plain, for browsers
  without `backdrop-filter`, and once over a backdrop put through the rule's own
  `saturate(180%)`, which is what supported browsers paint.
- The sheet sets no `::selection` rule. A brand wash leaves the foreground
  inherited, so it lands under all nine foregrounds this sheet paints; even an
  8% wash misses 4.5:1 in 24 (foreground, palette, mode) combinations, and the
  0.x value was 24%. Pinning a foreground instead is worse: `::selection` is
  global, and a downstream sheet that overrides only the selection background
  inherits the pinned color (`@smthrs/ui`'s markdown editor does exactly that).
  The user agent's own selection colors are contrast-guaranteed.
- New rules add their pair to the table. A background expression that appears in
  a rule but not in `PAINTED_PAIRS` is an unaudited surface.

### Recorded upstream gaps

`KNOWN_CONTRAST_GAPS`, `KNOWN_TERMINAL_GAPS`, `KNOWN_RAMP_COLLAPSES`, and
`KNOWN_ROLE_COLLISIONS` enumerate the pairs that still fail, all in generated
palettes. Every one traces to `scripts/generate-theme-registry.ts`:

- It takes `editor.foreground` raw for `--text` and for the terminal
  `foreground`, applying its contrast ratchet only to the three secondary text
  tokens. `solarized` therefore ships body text at 4.13:1 on its own `--bg`.
- Its `secondaryText()` loop gives up silently at `amount === 1`, where
  `mix(text, bg, 1) === text`, so `solarized` collapses `--text`,
  `--text-muted`, `--text-faint`, and `--text-placeholder` onto one color in
  both modes and `one` dark collapses the first two.
- Its `contrast()` runs on rounded channels, so the ratchet stops one step early.
- `rose-pine` gives `success` and `info` the same hex in both modes.

Every recorded contrast gap is a `solarized` neutral-token failure. Nothing on
the list can be closed by a change to this package's CSS.

`src/themes/*.ts` are byte-for-byte generator output, guarded by
`tests/generatedThemes.test.ts`, so closing these means changing the generator
and regenerating. The suite asserts both directions: nothing outside the lists
may fail, and nothing inside them may pass, so a fix upstream forces the entry
out instead of leaving a stale exemption behind.

`fucory` is hand-written and therefore fixed in place rather than recorded:
both `textPlaceholder` values were raised, its dark `brand` was nudged
`#8b78e6` -> `#8e7ce8` to clear `--surface-3`, and its light code block is light
like every other palette's so `.livelog-event` and `.livelog-node` are legible
on it.

## Aliases

`--panel`, `--card`, `--line`, `--muted`, `--ok`, `--err`, and the rest map
0.x names onto the canonical tokens. Trap: this page vocabulary's `--accent` is
the brand color, while `@smthrs/ui`'s `tokens.accent` is the hover fill. They
are not interchangeable.
