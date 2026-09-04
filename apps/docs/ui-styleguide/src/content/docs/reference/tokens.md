---
title: "Token reference"
description: "All 92 CSS custom properties the sheet declares: the 29 that change per palette and mode, and the 63 that never change."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/ui/ui-styleguide/docs/reference/tokens.md"
---

The base `:root` rule declares 92 custom properties plus `color-scheme`. They
fall into two groups, and the difference decides where you can override them.

- **Per-variant tokens** are redeclared by every palette rule and every mode
  rule. There are 29 of them plus `color-scheme`, and they carry the actual
  colors.
- **Theme-invariant tokens** are declared once, in the base `:root` rule. There
  are 63: 20 aliases, 15 tint and border recipes, 26 geometry values, and the
  2 font stacks. They follow the per-variant tokens without being restated.

For which selector an override needs, see
[Override a token](/guides/override-a-token/).

## Per-variant tokens

Every palette declares all of these, twice: once light, once dark. Their
TypeScript shape is `ThemeVariantTokens`.

| Token                    | Field                | What it is                                                             |
| ------------------------ | -------------------- | ---------------------------------------------------------------------- |
| `color-scheme`           | `colorScheme`        | `"light"` or `"dark"`. Drives native form controls and scrollbar chrome. |
| `--bg`                   | `bg`                 | Page background. One elevation step below `--surface`.                  |
| `--text`                 | `text`               | Primary foreground.                                                     |
| `--text-muted`           | `textMuted`          | Secondary foreground: body copy, meta text, table headers.              |
| `--text-faint`           | `textFaint`          | Tertiary foreground: counts, timestamps, gutters.                       |
| `--text-placeholder`     | `textPlaceholder`    | Input placeholder text.                                                 |
| `--surface`              | `surface`            | Card and panel surface.                                                 |
| `--surface-2`            | `surface2`           | Inset and hover surface.                                                |
| `--surface-3`            | `surface3`           | Overlay surface: popovers, dialogs.                                     |
| `--surface-glass`        | `surfaceGlass`       | Translucent surface for frosted panels.                                 |
| `--surface-glass-strong` | `surfaceGlassStrong` | The topbar's translucent fill.                                          |
| `--border`               | `border`             | Translucent hairline border.                                            |
| `--border-strong`        | `borderStrong`       | Translucent border, one step heavier.                                   |
| `--border-solid`         | `borderSolid`        | Opaque border, for controls that must not show through.                 |
| `--hover`                | `hover`              | Neutral hover fill.                                                     |
| `--hover-subtle`         | `hoverSubtle`        | Translucent hover fill for rows inside a surface.                       |
| `--inverse-bg`           | `inverseBg`          | Inverted chrome background: tooltips, inverse buttons.                  |
| `--inverse-text`         | `inverseText`        | Foreground on `--inverse-bg`, and on solid brand fills.                 |
| `--code-bg`              | `codeBg`             | Code block and log viewport background.                                 |
| `--code-text`            | `codeText`           | Foreground on `--code-bg`. Not an alias of `--text` in every palette.    |
| `--inline-code-bg`       | `inlineCodeBg`       | Translucent fill behind inline code.                                    |
| `--brand`                | `brand`              | Action or active.                                                       |
| `--success`              | `success`            | Done.                                                                   |
| `--danger`               | `danger`             | Failed.                                                                 |
| `--warning`              | `warning`            | Needs attention.                                                        |
| `--info`                 | `info`               | Neutral highlight.                                                      |
| `--shadow-rgb`           | `shadowRgb`          | Space-separated RGB channels the shadow recipes consume.                |
| `--shadow-1`             | `shadow1`            | Resting elevation.                                                      |
| `--shadow-2`             | `shadow2`            | Card elevation.                                                         |
| `--shadow-3`             | `shadow3`            | Overlay elevation.                                                      |

The three shadows are recipes over `--shadow-rgb`, for example
`0 1px 2px rgb(var(--shadow-rgb) / 0.05)`, which is what lets a dark variant
deepen every shadow by changing one channel triple.

`--bg`, `--surface`, `--surface-2`, and `--surface-3` are an elevation ramp,
and `tests/themeRegistry.test.ts` pins its direction per mode. Dark mode rises
monotonically from `--bg` to `--surface-3`. Light mode does not: `--surface-2`
sits below `--surface`, because it is an inset rather than a lift.

The four text tokens are a ramp too, graded most to least prominent against
`--bg`, and the same suite asserts each step is strictly weaker than the one
above it.

## Aliases

Twenty properties map older or shorter names onto canonical tokens. Workflow
UIs rely on them, so they stay.

| Alias             | Resolves to        |
| ----------------- | ------------------ |
| `--panel`         | `--surface`        |
| `--card`          | `--surface`        |
| `--line`          | `--border-solid`   |
| `--muted`         | `--text-muted`     |
| `--primary`       | `--brand`          |
| `--accent`        | `--brand`          |
| `--ok`            | `--success`        |
| `--warn`          | `--warning`        |
| `--warning-color` | `--warning`        |
| `--bad`           | `--danger`         |
| `--err`           | `--danger`         |
| `--error`         | `--danger`         |
| `--blue`          | `--info`           |
| `--run`           | `--brand`          |
| `--crit`          | `--danger`         |
| `--major`         | `--warning`        |
| `--minor`         | `--info`           |
| `--nit`           | `--muted`          |
| `--me`            | `--brand-soft`     |
| `--ink`           | `--inverse-bg`     |

The severity ladder stays four-way distinct: `--crit` is danger, `--major` is
warning, `--minor` is info, `--nit` is muted.

**Trap.** This page vocabulary's `--accent` is the brand color. `@smthrs/ui`'s
`tokens.accent` is the hover fill. The two are not interchangeable.

## Tints, borders, and the focus ring

Fifteen `color-mix` expressions over the semantic colors. Because they are
expressions, overriding a semantic color re-derives every one that reads it.

| Token                    | Recipe                                                  | Use for                                        |
| ------------------------ | -------------------------------------------------------- | ---------------------------------------------- |
| `--brand-soft`           | `color-mix(in srgb, var(--brand) 10%, var(--surface))`   | A fill under brand-colored text.               |
| `--brand-soft-strong`    | `color-mix(in srgb, var(--brand) 16%, var(--surface))`   | A fill with no brand-colored text on it.       |
| `--brand-border`         | `color-mix(in srgb, var(--brand) 40%, transparent)`      | Border on a brand-tinted control.              |
| `--brand-border-strong`  | `color-mix(in srgb, var(--brand) 65%, transparent)`      | Hover and press border on the same control.    |
| `--success-soft`         | `color-mix(in srgb, var(--success) 10%, var(--surface))` | A fill under success-colored text.             |
| `--success-border`       | `color-mix(in srgb, var(--success) 40%, transparent)`    | Border on a success-tinted control.            |
| `--danger-soft`          | `color-mix(in srgb, var(--danger) 10%, var(--surface))`  | A fill under danger-colored text.              |
| `--danger-border`        | `color-mix(in srgb, var(--danger) 40%, transparent)`     | Border on a danger-tinted control.             |
| `--danger-border-strong` | `color-mix(in srgb, var(--danger) 65%, transparent)`     | Press border on the same control.              |
| `--warning-soft`         | `color-mix(in srgb, var(--warning) 10%, var(--surface))` | A fill under warning-colored text.             |
| `--warning-border`       | `color-mix(in srgb, var(--warning) 40%, transparent)`    | Border on a warning-tinted control.            |
| `--info-soft`            | `color-mix(in srgb, var(--info) 10%, var(--surface))`    | A fill under info-colored text.                |
| `--info-border`          | `color-mix(in srgb, var(--info) 40%, transparent)`       | Border on an info-tinted control.              |
| `--ring`                 | `color-mix(in srgb, var(--brand) 22%, transparent)`      | The `:focus-visible` glow.                     |
| `--ring-border`          | `color-mix(in srgb, var(--brand) 50%, transparent)`      | The `:focus-visible` border color.             |

**10 percent is a ceiling, not a taste call.** Every `*-soft` tint is 10 percent
because that is the most a fill can take and still carry 11px text in the same
semantic color across all 16 variants. `--brand-soft-strong` is 16 percent and
is legal only under neutral or inverse foregrounds: brand text on it measures
below 4.5:1 in 10 of the 16. `SOFT_TINT_AMOUNT` and `STRONG_TINT_AMOUNT` are
these two numbers as exported constants, and the test suite reads them, so the
recipes and their proof cannot drift apart. See
[The contrast budget](/concepts/contrast-budget/).

## Geometry

Twenty-six properties, identical in every palette and mode.

| Group           | Tokens                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------- |
| Spacing         | `--sp-1` 4px, `--sp-2` 8px, `--sp-3` 12px, `--sp-4` 16px, `--sp-5` 20px, `--sp-6` 24px, `--sp-7` 28px, `--sp-8` 32px |
| Type scale      | `--fs-1` 11px, `--fs-2` 12px, `--fs-3` 13px, `--fs-4` 15px, `--fs-5` 17px, `--fs-6` 20px, `--fs-7` 24px |
| Line heights    | `--lh-tight` 1.35, `--lh-body` 1.5                                                                  |
| Radii           | `--r-1` 6px, `--r-2` 10px, `--r-3` 12px, `--r-4` 16px, `--r-bubble` 18px, `--r-full` 999px           |
| Control heights | `--ctl-h` 32px, `--ctl-h-sm` 28px, `--ctl-h-lg` 38px                                                 |

`--r-bubble` is the soft radius for chat bubbles and the floating glass
composer. `--r-full` is the pill radius.

Three policies ride on this scale, and `@smthrs/ui`'s css-contract tests enforce
them:

- The `--sp` scale, in 4px steps, paces layout-level spacing. Component-internal
  padding and gap sit on a 2px fine grid, so even pixel values only: no 5px, 7px,
  or 9px.
- Font weight 650 is the only emphasis weight, for titles and labels. 700 is
  reserved for KPI numerals. Body text is 400.
- Every `border-radius` in the standalone sheet resolves through this scale or
  `999px`. `tests/standaloneThemeCss.test.ts` asserts it.

## Fonts

Two properties, declared once in the base `:root` rule along with
`font-family: var(--font-sans)`.

| Token          | Value                                                                                 |
| -------------- | ------------------------------------------------------------------------------------- |
| `--font-sans`  | `Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif` |
| `--font-mono`  | `ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace`                          |

Sans carries the UI. Mono is reserved for code, ids, and tabular data; body copy
is never set in mono.

The font block is emitted exactly once on purpose, and never in a palette rule.
`tests/index.test.ts` counts the occurrences. See
[Theming](/theming/) for why.

## Related

- [Class reference](/reference/classes/): the rules that consume these tokens.
- [API reference](/reference/api/): the functions that emit them.
