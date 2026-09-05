---
title: "Installation"
description: "Where @smthrs/ui-styleguide comes from at 1.0.0-rc.0, the single import form it supports, the three runtimes it loads under, and what importing the barrel costs."
sidebar:
  order: 1
---

## Where the package comes from

`@smthrs/ui-styleguide` is not published to npm at `1.0.0-rc.0`. It ships inside
the Smithers repository, and it reaches an application through
[`@smthrs/ui`](https://github.com/smithersai/smithers/tree/main/packages/smithers/ui), the component library that depends on it.

From another package in the same workspace, name it as a workspace dependency:

```json
{
  "dependencies": {
    "@smthrs/ui-styleguide": "workspace:*"
  }
}
```

```bash
pnpm install
```

There is nothing else to install. The package declares no dependencies, no peer
dependencies, and no devDependencies, so a copy of
[`src/`](https://github.com/smithersai/smithers/tree/main/packages/smithers/ui/ui-styleguide/src)
is self-contained if you would rather vendor it than depend on it.

## What you actually get

The export map has one entry, `.`, and it points straight at `src/index.ts`:

```json
{
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts",
      "default": "./src/index.ts"
    }
  }
}
```

The package ships as TypeScript source with no build step. Your bundler or
runtime compiles it. That is why every relative specifier inside `src/` carries
its `.ts` extension: under Node ESM, an extensionless relative specifier does
not resolve.

## Import forms

There is one entry point, and it is a barrel:

```ts
import { standaloneThemeCss, themeCss, themeRegistry, workflowUiStyles } from "@smthrs/ui-styleguide"
```

Types come from the same specifier:

```ts
import type { SmithersTheme, ThemeKey, ThemeVariantTokens } from "@smthrs/ui-styleguide"
```

There are no subpath exports. A deep import such as
`@smthrs/ui-styleguide/src/themeRegistry.ts` is not part of the contract and
will break.

## Supported runtimes

Three loaders work, and the package's own test suite covers each of them on
every change:

| Runtime          | How it loads                                                            |
| ---------------- | ----------------------------------------------------------------------- |
| Node ESM         | `node --experimental-strip-types`, resolving the `.ts` export map.       |
| Bun              | Direct `.ts` import.                                                     |
| Browser bundlers | `bun build --target=browser`, and any bundler that compiles TypeScript.  |

Nothing in the sources imports a Node built-in or touches `process`, `require`,
`__dirname`, or `Buffer`, and a test reads them to prove it. The barrel is safe
to include in a browser bundle and safe to import during server-side rendering.

## Cost

Importing the barrel builds the sheets as module-level strings:
`workflowUiThemeCss` (33 KB), `workflowUiLayoutCss` (2 KB), their join as
`workflowUiStyles` (35 KB), and the sheet behind `standaloneThemeCss()` (26 KB).
All of them come from the same frozen registry snapshot, taken once at module
evaluation, so repeat calls cost nothing and the two theme surfaces cannot
disagree about a selected theme.

A host that ships only one palette can cut that. See
[Pin a palette](./guides/pin-a-palette.md).

## Next step

Build a themed page with a working palette and mode switcher in the
[Quickstart](./quickstart.md).
