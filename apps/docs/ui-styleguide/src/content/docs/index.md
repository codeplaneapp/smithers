---
title: "@smthrs/ui-styleguide"
description: "The Smithers house stylesheet: eight color palettes in light and dark, emitted as CSS custom properties, with the base element and component rules that consume them."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/ui/ui-styleguide/docs/README.md"
---

`@smthrs/ui-styleguide` is the one place a Smithers browser UI gets its colors,
spacing, type scale, and control chrome. It exports CSS as strings. There is no
build step, no runtime dependency, and no framework binding: a host drops a
string into a `<style>` element and every rule below it themes.

The package answers two questions the rest of the UI stack does not:

- **What does a color mean here?** `--brand` is action or active, `--success`
  is done, `--warning` needs attention, `--danger` failed, `--info` is a neutral
  highlight. A component names the role, never a hex value.
- **Is the color legible?** Every (foreground, background) pair the shipped
  rules paint is measured at WCAG AA across all eight palettes in both modes,
  and the failures that remain are enumerated by name. See
  [The contrast budget](/concepts/contrast-budget/).

[`@smthrs/ui`](https://ui.smithers.sh/reference/api/) builds its shadcn-anatomy React components on these
tokens. `apps/ui` and `apps/review` embed the sheets directly.

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

## Where to go next

- [Installation](/installation/): the workspace dependency, the import
  forms, and the three runtimes this package loads under.
- [Quickstart](/quickstart/): a themed page with a working palette and mode
  switcher, start to finish.
- [Theming](/theming/): the two selection axes and why the cascade order is
  load bearing. Read this before you override anything.
- Guides: [embed a stylesheet](/guides/embed-a-stylesheet/),
  [override a token](/guides/override-a-token/),
  [pin a palette](/guides/pin-a-palette/),
  [build a palette picker](/guides/build-a-palette-picker/), and
  [audit a color pair](/guides/audit-a-color-pair/).
- Concepts: [the contrast budget](/concepts/contrast-budget/) and
  [where the palettes come from](/concepts/palette-sources/).
- Reference: [every token](/reference/tokens/), [every class](/reference/classes/),
  and the [API](/reference/api/).
- [Troubleshooting](/troubleshooting/): the errors this package throws and
  the theming failures that produce no error at all.
