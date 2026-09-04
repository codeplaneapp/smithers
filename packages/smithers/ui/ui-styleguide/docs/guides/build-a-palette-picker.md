---
title: "Build a palette picker"
description: "Read the theme registry to render a picker, validate a stored palette value, and hand the selected theme's syntax and terminal colors to the adapters that need literals."
sidebar:
  order: 4
---

The registry is the palettes as data. A picker reads it; it does not hard-code
eight names.

## Render the options

```ts
import { DEFAULT_THEME_KEY, themeRegistry } from "@smthrs/ui-styleguide"

const options = Object.values(themeRegistry).map((theme) => ({
  value: theme.key,
  label: theme.label
}))
```

`Object.values` preserves the registry's declaration order, which puts the
default first. `theme.label` is the display name ("Night Owl", "Rosé Pine");
`theme.key` is the `data-palette` value.

## Apply a selection

```ts
document.documentElement.dataset.palette = selectedKey
```

That is all. The rule for that palette is already in the sheet; stamping the
attribute is what makes it match.

## Validate a stored value

A palette key that arrives from `localStorage`, a query parameter, or a server
is a string, not a `ThemeKey`. `findTheme` is the guard:

```ts
import { DEFAULT_THEME_KEY, findTheme, themeRegistry } from "@smthrs/ui-styleguide"
import type { ThemeKey } from "@smthrs/ui-styleguide"

function resolvePalette(stored: string | null): ThemeKey {
  return stored !== null && findTheme(stored) !== undefined ? (stored as ThemeKey) : DEFAULT_THEME_KEY
}
```

It returns the frozen theme record for a registered key and `undefined`
otherwise. It reads through `Object.hasOwn`, so a prototype name such as
`"toString"` is not a palette.

An unvalidated value is not a crash: it matches no rule, so the default
palette's tokens stand. Validate when you need to know, for example before
handing the key to an adapter that indexes the registry with it.

## Feed the adapters that need literals

Most of the UI themes through CSS custom properties. Two surfaces cannot, and
they read the selected theme's own upstream colors from the registry.

**Syntax highlighting.** Each theme names a Shiki bundled theme per mode:

```ts
import { themeRegistry } from "@smthrs/ui-styleguide"
import type { ThemeKey, ThemeSyntaxId } from "@smthrs/ui-styleguide"

const syntaxId = (palette: ThemeKey, mode: "light" | "dark"): ThemeSyntaxId =>
  mode === "dark" ? themeRegistry[palette].syntax.shikiDark : themeRegistry[palette].syntax.shikiLight
```

`ThemeSyntaxId` is the closed union of the 14 ids the shipped suite uses, so a
typo is a type error rather than a highlighter that silently renders unstyled.

**Terminals.** Each theme carries the 19 xterm.js palette fields per mode:

```ts
import { themeRegistry } from "@smthrs/ui-styleguide"
import type { TerminalPalette, ThemeKey } from "@smthrs/ui-styleguide"

const terminalTheme = (palette: ThemeKey, mode: "light" | "dark"): TerminalPalette =>
  themeRegistry[palette].terminal[mode]
```

`@smthrs/ui` ships this as `terminalThemeFor` and widens the record to xterm's
`ITheme` at the call site, which is why the styleguide can carry terminal colors
without an `@xterm/xterm` dependency.

## Do not mutate the registry

`themeRegistry` is deeply frozen at construction, and its type says so:
`DeepReadonly<Record<ThemeKey, SmithersTheme>>`. Assigning to a nested property
throws a `TypeError` in strict mode.

The freeze is load bearing rather than defensive. `workflowUiThemeCss` snapshots
the registry at module evaluation while widget adapters read it per render, so a
runtime mutation would give one document two different answers for the same
selected theme: old colors in the stylesheet, new colors in the terminal. Copy
before editing.

## Related

- [Where the palettes come from](../concepts/palette-sources.md): what is in
  each record and who generated it.
- [Theming](../theming.md): what `data-palette` actually selects.
