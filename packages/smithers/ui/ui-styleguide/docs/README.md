---
title: "@smthrs/ui-styleguide"
description: "The Smithers house stylesheet: eight color palettes in light and dark, emitted as CSS custom properties, with the base element and component rules that consume them."
---

`@smthrs/ui-styleguide` is a stylesheet you import as a string. It carries eight
color palettes, each with a light and a dark variant, as CSS custom properties,
along with the element and component rules that paint with them. There is no
build step, no runtime dependency, and no framework binding: put the string in a
`<style>` element and every rule below it themes.

## What it solves

Any product with a palette picker has to answer two questions about every color
it paints, and answer them the same way on every screen.

**What does this color mean?** `--brand` is action or active, `--success` is
done, `--warning` needs attention, `--danger` failed, `--info` is a neutral
highlight. A rule names the role and never a hex value, so changing the palette
is one attribute on `<html>` instead of a sweep through your CSS.

**Is the color legible?** Eight palettes times two modes is 16 token sets, and
someone who picks Solarized is not opting out of readable text. Every
(foreground, background) pair the shipped rules paint is measured against WCAG
AA in all 16 sets, the tint percentages are chosen by what survives that
measurement, and the pairs that still fail are listed by name with the ratio
each one scores. See [The contrast budget](./concepts/contrast-budget.md).

## The shortest real example

```ts
import { workflowUiStyles } from "@smthrs/ui-styleguide"

document.head.append(
  Object.assign(document.createElement("style"), { textContent: workflowUiStyles })
)
document.documentElement.dataset.palette = "gruvbox"
```

The document now follows the operating system light and dark preference, and
`data-palette` picks which of the eight palettes it follows it in. Nothing else
is required.

## What is in the box

| Piece                    | What it gives you                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| Theme tokens             | 29 per-variant color properties plus `color-scheme`, over 63 theme-invariant ones, for eight palettes in two modes. |
| Primitive rules          | Base element styling and the `.button`, `.input`, `.badge`, `.card`, `.table`, `.code` families.        |
| Layout rules             | The `.workflow-*` shell, dashboard, and run-row grid.                                                   |
| The palette registry     | The eight themes as data, including their Shiki syntax ids and xterm terminal palettes.                 |
| Contrast math            | `contrastRatio`, `mixColors`, and the unrounded-channel pair the audit is written against.              |

## How this fits with @smthrs/ui

This package is the layer underneath [`@smthrs/ui`](https://github.com/smithersai/smithers/tree/main/packages/smithers/ui), the React
component library the Smithers surfaces are built from. `@smthrs/ui` builds its
shadcn-anatomy components on these tokens, and it owns the React way of getting
the sheet into a document: render its `SmithersUiStyles` component once, near
the root, rather than appending a `<style>` element yourself.

Reach for `@smthrs/ui-styleguide` on its own when you are theming plain HTML: a
server-rendered report, a static page, a widget with no React in it. Reach for
[`@smthrs/ui`](https://github.com/smithersai/smithers/tree/main/packages/smithers/ui) when you want the components too, and let it pull these
tokens in for you. Nothing here imports React, so both routes lead to the same
CSS.

Both packages sit under [`@smthrs/cli`](/api/cli), the `smthrs` command line
that runs Smithers flows. Start there for the product these interfaces are
built for.

## Where to go next

- [Installation](./installation.md): where the package comes from, the import
  forms, and the three runtimes it loads under.
- [Quickstart](./quickstart.md): a themed page with a working palette and mode
  switcher, start to finish.
- [Theming](./theming.md): the two selection axes and why the cascade order is
  load bearing. Read this before you override anything.
- Guides: [embed a stylesheet](./guides/embed-a-stylesheet.md),
  [override a token](./guides/override-a-token.md),
  [pin a palette](./guides/pin-a-palette.md),
  [build a palette picker](./guides/build-a-palette-picker.md), and
  [audit a color pair](./guides/audit-a-color-pair.md).
- Concepts: [the contrast budget](./concepts/contrast-budget.md) and
  [where the palettes come from](./concepts/palette-sources.md).
- Reference: [every token](./reference/tokens.md), [every class](./reference/classes.md),
  and the [API](./api.md).
- [Troubleshooting](./troubleshooting.md): the errors this package throws and
  the theming failures that produce no error at all.
