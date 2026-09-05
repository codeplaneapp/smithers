---
title: "What is smithers build"
description: "The everything-is-a-flow model behind smithers build, and how it compares with Bazel, Turborepo, and nx."
---

Examples importing `buildAndCheckPackage` use the [local helper defined here](../reference/targets/standard-package.md). Create that file in your repository before using those examples.


smithers build orchestrates builds for TypeScript workspaces. It borrows Bazel's model:
a workspace is a set of packages, a package declares targets, a target names its
inputs and its dependencies, and a verb selects a set of targets to run.

The difference is the authoring language. A `PACKAGE.ts` file is a plain
TypeScript module that exports one `Package` value, and the keys of its target
map are the package's target names. There is no new configuration dialect, no
Starlark, and no JSON pipeline file.

```ts
import { buildAndCheckPackage } from "./package-targets.ts"
// packages/greeter/PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"

const { lib, test, lint } = buildAndCheckPackage({ deps: [], cwd: "packages/greeter" })

export const Package = S.Package({ targets: { lib, test, lint } })
```

That file declares three targets: `//packages/greeter:lib`,
`//packages/greeter:test`, and `//packages/greeter:lint`.

## Everything is a flow

A target call returns a [flow](https://github.com/smithersai/smithers): a declaration
with a schema-typed payload, a schema-typed success value, a schema-typed error
channel, and a pure plan-time body. smithers build attaches planner metadata to that
flow under a symbol, which makes it a target.

Three consequences follow.

- **Module evaluation performs no I/O.** `file()` and `glob()` return inert
  values. The target body records plan nodes and runs nothing. Reading the
  filesystem happens later, in the planner, and running tools happens later
  still, in the engine.
- **Every step is keyed.** A target body records action calls. The engine derives a
  content key for each one from its payload, its declared effects, its resolved
  layers, and its capability ceiling.
- **Host access is a layer.** Spawning a process, writing a file, and calling a
  model are all actions whose implementations arrive as Effect layers. Swapping
  npm for pnpm is a layer swap, not a branch.

See [Target definitions and targets](../concepts/targets.md) and
[Actions and boundaries](../concepts/actions-and-boundaries.md).

## Comparison

|                   | smithers build                                                                                                         | Bazel                                               | Turborepo                                      | nx                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------- | ------------------------------------------ |
| Build file        | `PACKAGE.ts`, plain TypeScript                                                                                         | `BUILD.bazel`, Starlark                             | `turbo.json` plus package scripts              | `project.json` plus plugins                |
| Unit of work      | Target: a target call exported by name                                                                                 | Target: a target call with a `name` attribute       | Task: a package script                         | Target: an executor invocation             |
| Dependency edges  | Direct `import` between `PACKAGE.ts` files                                                                             | `deps` attribute holding label strings              | Inferred from `package.json` plus `dependsOn`  | Inferred from imports plus explicit config |
| Input declaration | `file()`, `glob()`, `gitDiff()`                                                                                        | `srcs`, `glob()`                                    | Package directory hashing, `inputs` globs      | Named input sets                           |
| Sandboxing        | Per-action: bubblewrap on Linux, seatbelt on macOS, Docker where declared; reads and writes scoped to the declared set | Per-action sandbox                                  | None                                           | None                                       |
| Cache key         | sha256 over target id, canonicalized attrs, input digests, and dependency keys                                         | Action digest over declared inputs and command line | Hash over package files, dependencies, and env | Hash over inputs and project graph         |
| Remote cache      | HTTP `/ac` read-through for CLI results; `/ac` and `/cas` services for the engine step cache                           | gRPC remote execution API                           | Vercel Remote Cache                            | Nx Cloud                                   |
| Language          | TypeScript                                                                                                             | Starlark                                            | JSON                                           | JSON plus TypeScript plugins               |

smithers build takes Bazel's target model and label grammar, Turborepo's presentation
and workspace assumptions, and the Smithers engine's keying and durability model.
Actions run under a per-host sandbox scoped to the declared read and write
sets, and a declared confinement the host cannot enforce fails the target
rather than running it unconfined. See
[Actions and boundaries](../concepts/actions-and-boundaries.md).

## The three packages

| Package                                                                                                   | What it holds                                                                                                                   |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [`@smthrs/build`](../api.md)                                                                              | Dependency installation as a flow, and the `PackageManager` and `Runtime` host seams.                                           |
| [`@smthrs/targets`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build/targets)     | The declaration surface: `Target.make`, `Input`, `Workspace`, `Package`, `PackageDefaults`, and the catalog. |
| [`@smthrs/build-cli`](https://github.com/smithersai/smithers/tree/main/packages/smithers/build/build-cli) | The `smithers-build` CLI: workspace discovery, the planner, the executor, the caches, and query and graph output.               |

## Next

- [Install smithers build in a workspace](../getting-started/install.md)
- [Write your first PACKAGE.ts](../getting-started/first-build.md)
