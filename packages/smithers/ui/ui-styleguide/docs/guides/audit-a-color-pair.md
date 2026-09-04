---
title: "Audit a color pair"
description: "Score a new foreground and background pair across all sixteen shipped variants with the package's own contrast math, and record it so the suite keeps checking it."
sidebar:
  order: 5
---

You added a rule that paints a color on a background. Before it ships, it has to
clear 4.5:1 in eight palettes times two modes. Here is how to find out, and how
to make the check permanent.

## Score one pair

For two opaque hex colors, `contrastRatio` is the whole answer:

```ts
import { contrastRatio } from "@smthrs/ui-styleguide"

contrastRatio("#403f53", "#FBFBFB") // 9.8805
```

It returns the WCAG 2.x ratio from 1 to 21, and both arguments must be opaque
`#rgb`, `#rrggbb`, or `#rrggbbaa` with `aa` equal to `ff`. A translucent color
throws instead of scoring the dropped alpha, because `#00000000` on white is not
21:1; it is whatever the invisible text sits on. Composite first.

## Score a tint

A tinted fill is a `color-mix`, and a browser evaluates it in floating point.
`mixColors` rounds each channel to an integer, which is enough to change a
verdict: the 12 percent `one` dark `--success` tint scored 4.5033 rounded and
4.4781 as rendered. Use `mixChannels` and `contrastRatioOf`, which work in
unrounded channels end to end:

```ts
import { contrastRatioOf, mixChannels, SOFT_TINT_AMOUNT, themeRegistry } from "@smthrs/ui-styleguide"
import type { Rgb } from "@smthrs/ui-styleguide"

const AA_MINIMUM = 4.5

/** Exact 0-255 channels of a hex token. mixChannels is identity at amount 1. */
const channels = (hex: string): Rgb => mixChannels(hex, hex, 1)

for (const [key, theme] of Object.entries(themeRegistry)) {
  for (const mode of ["light", "dark"] as const) {
    const variant = theme[mode]
    const ratio = contrastRatioOf(
      channels(variant.info),
      mixChannels(variant.info, variant.surface, SOFT_TINT_AMOUNT)
    )
    const verdict = ratio >= AA_MINIMUM ? "pass" : "FAIL"
    console.log(`${verdict} ${key}/${mode} info on info-soft ${ratio.toFixed(4)}`)
  }
}
```

```text
pass night-owl/light info on info-soft 4.7626
pass night-owl/dark info on info-soft 5.9676
pass fucory/light info on info-soft 4.8992
pass fucory/dark info on info-soft 6.3054
pass one/light info on info-soft 4.6941
pass one/dark info on info-soft 4.5648
pass github/light info on info-soft 4.6519
pass github/dark info on info-soft 4.7536
pass catppuccin/light info on info-soft 4.6607
pass catppuccin/dark info on info-soft 5.6439
pass solarized/light info on info-soft 4.6579
pass solarized/dark info on info-soft 4.5776
pass gruvbox/light info on info-soft 4.5290
pass gruvbox/dark info on info-soft 4.7829
pass rose-pine/light info on info-soft 4.7197
pass rose-pine/dark info on info-soft 7.3470
```

Margins of 0.03 are the point. Read `one` dark at 4.5648 and `gruvbox` light at
4.5290 and you can see why the tint ceiling is 10 percent and not 11.

## Score the fill you actually paint

The background to score is the **resolved** fill for the state, not the first
declaration that mentions one. `.primary:hover` matches the generic
`.button:hover` rule as well as its own, so the pair a browser paints depends on
which rule wins. `tests/cascade.test.ts` resolves the sheet rule by rule for
exactly this reason; read it before you trust a background you read off a single
line.

Two cases need work before you can score them at all:

- **A translucent token** such as `--surface-glass-strong` or `--border` is
  `rgba(...)`. Composite it over what is behind it, then score the composite.
  `tests/paintedPairs.ts` has `rgbaOver` for this.
- **A `backdrop-filter` background** is the filtered backdrop, not the raw one.
  `saturate(180%)` changes the pixels under the text; `blur()` over a uniform
  background does not. The topbar is measured on both paths.

## Record the pair

A one-off script proves the pair today. Adding it to
[`tests/paintedPairs.ts`](https://github.com/smithersai/smithers/blob/main/packages/smithers/ui/ui-styleguide/tests/paintedPairs.ts) proves it on every
change:

```ts
{
  label: "info on info-soft",
  foreground: (variant) => rgbChannels(variant.info),
  background: (variant) => mixChannels(variant.info, variant.surface, SOFT_TINT_AMOUNT)
}
```

`tests/themeRegistry.test.ts` registers one test per entry per variant, so one
table row becomes 16 assertions. Inside the test tree you can import
`rgbChannels` from `src/rgbChannels.ts` directly; the barrel does not export it,
which is why the `channels` helper above exists for consumers.

If the pair fails in a generated palette and the cause is upstream, add it to
`KNOWN_CONTRAST_GAPS` with its measured ratio. The suite then asserts that it
still fails at that number, so the exemption cannot outlive the defect. Do not
add an exemption for a rule you wrote: a rule of your own that fails is a rule
to change.

## Related

- [The contrast budget](../concepts/contrast-budget.md): what the table covers
  and what the sheet forbids.
- [API reference](../api.md): every signature and the errors each function
  throws.
