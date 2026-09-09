---
title: "Where the palettes come from"
description: "Seven of the eight palettes are generated from @shikijs/themes and checked in byte for byte; one is hand written. Which a palette is decides how you change it."
sidebar:
  order: 2
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
reads `@shikijs/themes` 4.4.3 and writes seven files into `src/themes/`. The
output is checked in so that a consumer never resolves a syntax theme at
runtime. The package pins Shiki as a development dependency and resolves it
locally. Each generated banner records that resolved package's version.
Semantic tint thresholds use the audit's exact mixed channels; only stored hex
colors are rounded.

The script writes the checked-in shape directly, with unquoted identifier keys,
trailing commas, and two-space indent, so a regeneration that changes nothing is
a byte-for-byte no-op. Its `--check` mode writes nothing and exits 1 naming
every file whose bytes differ from what it would write now, and the package's
test suite runs exactly that on every change.

Two kinds of drift are caught, and a reader of the theme files alone can see
neither:

1. **A hand edit to a generated file.** It survives until the next regeneration
   silently reverts it. The `.ts` extension on the emitted import specifier is
   exactly that case: a Node ESM host loading this package from source does not
   resolve an extensionless relative specifier, and a fix applied to the theme
   files instead of to the generator lasts only until the next run.
2. **Upstream movement.** The Shiki themes change and the checked-in registry
   stops matching what the generator would write from them.

The consequence for anyone reading a theme file: its values are output, not a
decision. Changing a generated palette means changing the generator and
regenerating, so an edit to `src/themes/one.ts` is not a change, it is a pending
revert.

## Fucory is hand written

`src/themes/fucory.ts` carries no generator banner and is not rewritten by a
regeneration. It is the palette accessibility fixes land in directly, which is
why it has none of the recorded gaps below: both `textPlaceholder` values were
raised, its dark `brand` was nudged from `#8b78e6` to `#8e7ce8` to clear
`--surface-3`, and its light code block is light like every other palette's so
`.livelog-event` and `.livelog-node` are legible on it. The test suite pins both
of its serialized token strings.

## UI contrast and upstream fidelity

The generator adjusts the UI foreground against all four surface elevations
before deriving the text ramp. Primary text targets 5.25:1; muted, faint, and
placeholder text target 5:1, 4.75:1, and 4.5:1. Every search verifies its final
result and throws with the palette, mode, token, target, and achieved ratio if
it cannot succeed. All palettes are validated before files are written.
Solarized's former 52 UI contrast exemptions and collapsed text ramp are
removed. The same correction gives One dark a distinct primary/muted step.

Two lists in
[the audited pair table](https://github.com/smithersai/smithers/blob/main/packages/smithers/ui/ui-styleguide/tests/paintedPairs.ts)
record behavior separate from the UI text contrast guarantee:

- `KNOWN_TERMINAL_GAPS` pins Solarized light at 4.13:1. Terminal colors retain
  upstream fidelity and use the original editor foreground as a fallback.
- `KNOWN_ROLE_COLLISIONS` pins Rose Pine's shared `success` and `info` hex in
  both modes. Contrast alone does not distinguish these semantic roles.

Consumer token overrides can improve contrast in a host document; see
[Override a token](../guides/override-a-token.md). The generator's `--check`
mode is a read-only comparison of repository theme files: it never rewrites
files or reads consumer CSS.

Closing a gap in the shipped registry requires changing the generator and
regenerating. Remove the corresponding entry from the list when it passes,
because the suite asserts that nothing inside a list may pass.

## Related

- [The contrast budget](./contrast-budget.md): what the audit measures and why.
- [Build a palette picker](../guides/build-a-palette-picker.md): reading the
  registry from a UI.
