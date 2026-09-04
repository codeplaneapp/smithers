---
title: "Installation"
description: "Add @smthrs/ui-styleguide to a workspace package, the import forms it supports, and the three runtimes it loads under."
sidebar:
  order: 1
---

## Add the dependency

The package is `private` at `1.0.0-rc.0`, so it is not on npm. Inside this
workspace, depend on it the way `@smthrs/ui` and `apps/review` do:

```json
{
  "dependencies": {
    "@smthrs/ui-styleguide": "workspace:*"
  }
}
```

Then install:

```bash
pnpm install
```

There is nothing else to install. The package declares no dependencies, no
peer dependencies, and no devDependencies.

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
its `.ts` extension: `apps/review` loads the package under Node ESM, where an
extensionless relative specifier does not resolve.

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

Three loaders are covered by the package's own tests:

| Runtime          | How it loads                                                        | Proven by                   |
| ---------------- | ------------------------------------------------------------------- | --------------------------- |
| Node ESM         | `node --experimental-strip-types`, resolving the `.ts` export map.  | `tests/nodeEsmResolution.test.ts` |
| Bun              | Direct `.ts` import.                                                 | Every other suite.          |
| Browser bundlers | `bun build --target=browser`, and any bundler that compiles TypeScript. | `tests/browserBundle.test.ts` |

Nothing in `src/` imports a Node built-in or touches `process`, `require`,
`__dirname`, or `Buffer`, and `tests/browserBundle.test.ts` reads the sources to
prove it. The barrel is safe to include in a browser bundle and safe to import
during server-side rendering.

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
