---
title: "Where the palettes come from"
description: "Seven of the eight palettes are generated from @shikijs/themes and checked in byte for byte; one is hand written. Which a palette is decides how you change it."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/ui/ui-styleguide/docs/concepts/palette-sources.md"
---

The registry holds eight palettes:

| Key          | Label      | Source                    |
| ------------ | ---------- | ------------------------- |
| `night-owl`  | Night Owl  | Generated. The default.   |
| `fucory`     | Fucory     | Hand written.             |
| `one`        | One        | Generated.                |
| `github`     | GitHub     | Generated.                |
| `catppuccin` | Catppuccin | Generated.                |
| `solarized`  | Solarized  | Generated.                |
| `gruvbox`    | Gruvbox    | Generated.                |
| `rose-pine`  | Rosé Pine  | Generated.                |

The order matters: it is the order the CSS emitter walks, so it is the source
order the cascade depends on, and it is the order a picker built from
`Object.values(themeRegistry)` displays.

## What a palette record holds

Each entry is a `SmithersTheme`: a `key`, a `label` for pickers, `light` and
`dark` token variants, and two blocks that are not derived from the tokens at
all.

- `syntax` holds Shiki bundled-theme ids, one per mode. `@smthrs/ui`'s Pierre
  diff view picks `shikiDark` or `shikiLight` and hands it to the highlighter.
- `terminal` holds the 19 xterm.js palette fields, one set per mode.
  `terminalThemeFor(palette, mode)` in `@smthrs/ui` returns
  `themeRegistry[palette].terminal[mode]` and widens it to xterm's `ITheme`.

Both are the upstream theme's own colors. They are not re-derived from the
token variants, because a syntax theme that drifts from the editor it is named
after stops being that theme.

## Generated palettes are checked in

[`scripts/generate-theme-registry.ts`](https://github.com/smithersai/smithers/blob/main/packages/smithers/ui/ui-styleguide/scripts/generate-theme-registry.ts)
reads `@shikijs/themes` 3.23.0 and writes seven files into `src/themes/`. The
output is checked in so that a consumer never resolves a syntax theme at
runtime.

The script writes the checked-in shape directly, with unquoted identifier keys,
trailing commas, and two-space indent, so a regeneration that changes nothing is
a byte-for-byte no-op. Its `--check` mode writes nothing and exits 1 naming
every file whose bytes differ from what it would write now, and
`tests/generatedThemes.test.ts` runs exactly that under Node.

Two kinds of drift are caught, and a reader of the theme files alone can see
neither:

1. **A hand edit to a generated file.** It survives until the next regeneration
   silently reverts it. The `.ts` extension on the emitted import specifier is
   exactly that case: `apps/review` resolves this package under Node ESM, where
   an extensionless relative specifier does not resolve, and a fix applied to
   the files instead of to the generator lasts until someone re-runs it.
2. **Upstream movement.** The Shiki themes change and the checked-in registry
   stops matching what the generator would write from them.

So: to change a generated palette, change the generator and regenerate. Editing
`src/themes/one.ts` is not a change, it is a pending revert.

```bash
node --experimental-strip-types packages/smithers/ui/ui-styleguide/scripts/generate-theme-registry.ts
```

## Fucory is hand written

`src/themes/fucory.ts` carries no generator banner and is not rewritten by a
regeneration. It is the palette accessibility fixes land in directly, which is
why it has none of the recorded gaps below: both `textPlaceholder` values were
raised, its dark `brand` was nudged from `#8b78e6` to `#8e7ce8` to clear
`--surface-3`, and its light code block is light like every other palette's so
`.livelog-event` and `.livelog-node` are legible on it.
`tests/themeRegistry.test.ts` pins both of its serialized token strings.

## The recorded upstream gaps

Four lists in `tests/paintedPairs.ts` enumerate what still fails. Every entry
traces to the generator, and every one of them is a generated palette.

- **`KNOWN_CONTRAST_GAPS`** is 52 entries, all Solarized. The generator takes
  `editor.foreground` raw for `--text` and for the terminal `foreground`,
  applying its contrast ratchet only to the three secondary text tokens.
  Solarized light therefore ships body text at 4.13:1 on its own `--bg`.
- **`KNOWN_TERMINAL_GAPS`** is Solarized light, at the same 4.13:1, for the same
  reason.
- **`KNOWN_RAMP_COLLAPSES`** is seven flat spots in the four-step text ramp. The
  generator's `secondaryText()` raises its mix amount until the value clears its
  target, and at `amount === 1`, `mix(text, bg, 1) === text`, so it returns the
  base foreground with no failure signal. Solarized collapses all four text
  tokens onto one color in both modes; `one` dark collapses the first two.
- **`KNOWN_ROLE_COLLISIONS`** is Rose Pine, which gives `success` and `info` the
  same hex in both modes, so a passing state and an informational state are
  indistinguishable.

A fifth cause has no list of its own: the generator's `contrast()` runs on
rounded channels, so its ratchet stops one step early.

None of these can be fixed in this package. The token values live in generator
output, and the generator's `--check` mode will revert any edit to them. Closing
a gap means changing the generator and regenerating, at which point the
corresponding entry has to come out of the list, because the suite asserts that
nothing inside a list may pass.

## Related

- [The contrast budget](/concepts/contrast-budget/): what the audit measures and why.
- [Build a palette picker](/guides/build-a-palette-picker/): reading the
  registry from a UI.
