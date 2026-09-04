---
title: "Pin a palette"
description: "Ship the tokens for one palette instead of all eight, and keep the primitive and layout rules, using themeCss and the prefix relationship the tests pin."
sidebar:
  order: 3
---

Every palette costs roughly 2.9 KB of CSS. A host that offers no palette picker
is paying 20 KB to ship seven palettes nobody can select.

## Emit a subset

`themeCss(options)` returns the token rules alone, for whichever palettes you
name:

```ts
import { themeCss } from "@smthrs/ui-styleguide"

const tokens = themeCss({ palettes: ["gruvbox"] })
```

That is 7.7 KB instead of 24.9 KB. Three properties hold whatever you pass:

- **The default palette is always emitted.** Its three rules carry the 61
  theme-invariant tokens and the two font stacks, so the sheet is incomplete
  without them. `themeCss({ palettes: [] })` is the floor at 4.8 KB.
- **Registry order, not your order.** The function walks the registry, so
  `["github", "one"]` and `["one", "github"]` return byte-identical CSS, and a
  repeated key emits once. Order is load bearing in the cascade, and this is
  what keeps a caller from breaking it.
- **An unregistered key throws.** `themeCss({ palettes: ["dracula"] })` raises a
  `RangeError` naming the key and listing the registered ones, rather than
  emitting a sheet that silently themes nothing.

## Keep the primitive rules

`workflowUiThemeCss` is `themeCss()` followed by a newline and the primitive
element and component rules. `tests/index.test.ts` asserts that prefix
relationship, so you can swap the prefix:

```ts
import { themeCss, workflowUiLayoutCss, workflowUiThemeCss } from "@smthrs/ui-styleguide"

const primitives = workflowUiThemeCss.slice(themeCss().length + 1)

export const pinnedStyles = [
  themeCss({ palettes: ["gruvbox"] }),
  primitives,
  workflowUiLayoutCss
].join("\n")
```

18 KB instead of 35 KB, with the same buttons, badges, tables, and workflow
grid. The primitive block on its own is 8.4 KB and mentions no color literal:
every rule in it resolves through a token.

## The standalone sheet has no subset form

`standaloneThemeCss()` is prebuilt at module evaluation with all eight palettes,
and it quotes its attribute selectors with `"` while `themeCss()` quotes with
`'`. The prefix trick above does not transfer. A host that wants a pinned
standalone sheet composes `themeCss(subset)` with its own base element rules.

## Check what you saved

```ts
console.log(themeCss().length, themeCss({ palettes: ["gruvbox"] }).length)
```

```text
24933 7707
```

## Related

- [Embed a stylesheet](./embed-a-stylesheet.md): the full sheet inventory and
  their sizes.
- [Build a palette picker](./build-a-palette-picker.md): if you do want all
  eight after all.
