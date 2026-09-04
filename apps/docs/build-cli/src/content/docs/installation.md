---
title: "Installation"
description: "What the smithers-build binary requires: Node 22.19, a workspace dependency, the tsx loader it boots, and the TypeScript syntax declaration modules may use."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/build/build-cli/docs/installation.md"
---

`@smthrs/build-cli` is `private: true` and publishes nothing. It reaches a
workspace as a workspace dependency, never from a registry.

## Requirements

- Node.js 22.19.0 or newer, which is what the package declares in `engines`.
- A package manager that links workspace packages. The workspace declaration
  names the one targets run their tools through, pnpm or Bun.
- Git, for the parts of a run that read the tree: write-set confinement, the
  gitignored census, `owners --diff`, and `Git.Commit` targets. Declaration
  discovery itself never asks git anything.

## Add the dependency

Declare the CLI and the authoring package as devDependencies of the workspace
root:

```json
{
  "devDependencies": {
    "@smthrs/build-cli": "workspace:*",
    "@smthrs/targets": "workspace:*"
  }
}
```

After the install, the `smithers-build` bin is on `pnpm exec` at the workspace
root:

```bash
pnpm exec smithers-build --version
```

Declaration modules then import the authoring surface by bare specifier:

```ts
import { Smithers as S } from "@smthrs/targets"
```

## What the binary boots

The `bin` entry is `src/main.js`, and it runs before any TypeScript is loaded.
It does two things:

1. Installs an Effect module resolution hook. Declarations and the flow engine
   must share one `effect` module instance; linked development packages can
   otherwise resolve physically separate peer copies whose schema internals
   are not interoperable.
2. Imports `src/main.ts` through the programmatic `tsx` loader that ships as a
   CLI dependency, which is what lets the CLI's own modules and your
   `WORKSPACE.ts` and `PACKAGE.ts` files be TypeScript with no build step.

There is no compiled `dist` tree to install or keep fresh. The `files` field
publishes `src/**` and the tsconfig sets `noEmit`.

## What declaration modules may contain

A declaration is an ordinary TypeScript ES module. The loader reports
`format: "module"` for every declaration, so a workspace whose nearest
`package.json` declares no `type` still evaluates its declarations as ES
modules.

Two constraints come from discovery rather than from the loader. A declaration
must be a real file, because a symlinked declaration is rejected outright, and
its name must be spelled exactly `WORKSPACE.ts` or `PACKAGE.ts`: the walk
compares against the directory listing, so `Package.ts` is not found even on a
case-insensitive filesystem.

Declarations resolve `effect` and `@smthrs/targets` from the CLI package that
owns the runtime, not from the workspace. That is what lets a globally
installed `smithers-build` bootstrap a repository before its dependencies are
installed, and what keeps one `effect` instance across the declarations, the
planner, and the flow engine.

## Programmatic use

A program that embeds the build imports the same modules the binary does:

```ts
import { makeCli } from "@smthrs/build-cli"
```

Every module is also importable by its own path, for example
`@smthrs/build-cli/Planner`. `@smthrs/build-cli/internal/*` is not public. See
[Embed the CLI in another program](/guides/embed-the-cli/).

## Next

[Quickstart](/quickstart/) declares a workspace and runs a target end to
end.
