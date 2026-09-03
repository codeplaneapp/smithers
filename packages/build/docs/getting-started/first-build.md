# First build

This tutorial writes a root `PACKAGE.ts` and one package `PACKAGE.ts`, then runs the
core query, graph, build, test, lint, CI, and install paths. It assumes the
layout from [Install](install.md).

## 1. Declare the root

The root `PACKAGE.ts` holds workspace-wide declarations: configuration, shared
input values, the install target, and any default targets.

```ts
// PACKAGE.ts
import { Smithers } from "@smthrs/targets"

export const config = Smithers.Workspace({ cacheDirectory: ".flows", gitignored: true })

export const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })

export const nodeModules = Smithers.Install({ packageManager })

export const rootJSDocConfig = Smithers.file("//eslint.jsdoc.js")
```

A workspace whose tools come from a Nix closure adds one more export beside
these. It applies to every package below the root, and a package that exports
its own overrides it. See [Environments](../concepts/environments.md).

```ts
export const environment = Smithers.Nix.Environment({ flake: Smithers.file("//flake.nix") })
```

`config` and `rootJSDocConfig` are not targets. `nodeModules` is: it becomes
`//:nodeModules`, and `//` resolves to it because the default-target search tries
`lib`, then `nodeModules`, then the package basename, then `default`. The
runtime and package-manager declarations are inert data: nothing runs when the
file is evaluated, and every tool-running target takes the manager as an attr,
so switching either is one edit to this file.

## 2. Declare a package

Point `StandardPackage` at a package directory, passing the toolchain the root
file declared. It expands into six targets.

```ts
// packages/greeter/PACKAGE.ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

export const { lib, check, test, lint, fmt, docs } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/greeter"
})
```

`cwd` is the workspace-relative directory every emitted tool runs in. The macro's
defaults follow the Smithers layout: sources at `src/**/*.ts`, tests at
`test/**/*.test.ts`, `tsc -p tsconfig.json`, Vitest with the package
`vitest.config.ts`, and ESLint with the package `eslint.config.js` plus the root
`eslint.jsdoc.js`.

The labels are `//packages/greeter:lib`, `//packages/greeter:check`,
`//packages/greeter:test`, `//packages/greeter:lint`, `//packages/greeter:fmt`,
and `//packages/greeter:docs`.

## 3. Add an edge

Import another package's target to declare a dependency.

```ts
// packages/app/PACKAGE.ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"
import { lib as greeter } from "../greeter/PACKAGE.ts"

export const { lib, test, lint } = Smithers.StandardPackage({
  packageManager,
  deps: [greeter],
  cwd: "packages/app"
})
```

`//packages/app:lib` now depends on `//packages/greeter:lib`. No label string
appears anywhere. See [Dependencies](../concepts/dependencies.md).

## 4. List targets

```sh
smithers-build query //...
```

The result lists each discovered target with its target and the verbs it
participates in:

```
query: //...
targets:
  - label: //:nodeModules
    target: Install
    kinds: [run]
  - label: //packages/app:lib
    target: TsBuild
    kinds: [build]
  ...
```

Output is [TOON](https://github.com/toon-format/toon) by default. Add `--json`
for JSON.

## 5. Inspect the graph

```sh
smithers-build graph //packages/app:lib
```

```
//packages/app:lib (TsBuild)
└─ //packages/greeter:lib (TsBuild)
```

`--mermaid` renders the same graph as a Mermaid `flowchart LR`.

## 6. Print a plan without running it

```sh
smithers-build build //... --plan
```

The plan lists targets in dependency-first order with the expanded declared
inputs, the four key-material fields, and the sha256 content key. Nothing runs.

## 7. Execute

```sh
smithers-build build //...
smithers-build test //packages/greeter:test
smithers-build lint //packages/...
```

Each verb selects the targets whose target declares that kind, plans their
transitive dependency closure, and executes it in dependency order with bounded
parallelism. One status line per target goes to standard error:

```
//packages/greeter:lib  ran  1.4s
//packages/app:lib  ran  0.9s
2 targets: 0 hit, 2 ran, 0 failed, 0 skipped (2.3s)
```

Run it again and the cacheable targets report `hit`.

`ci` merges the build, test, and lint plans over one pattern and executes the
merged graph once:

```sh
smithers-build ci //...
```

## 8. Install dependencies

```sh
smithers-build install --workspace .
```

This runs the `Install` flow under the declared package manager's layer:
measure, fetch into `.flows/store/<manager>`, then reconcile `node_modules`.
Only pnpm has a live implementation today; the other managers fail with a typed
`unsupported` error. Install requires the default `.flows` cache-directory
setting and is not answered from the cross-run engine cache. See
[Install](../concepts/install.md).

## Next

- [Writing BUILD files](../workspace/writing-build-files.md)
- [Running targets](../workspace/running-targets.md)
- [CLI reference](../reference/cli.md)
