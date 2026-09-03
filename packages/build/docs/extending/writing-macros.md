# Writing macros

A macro is an ordinary function that calls targets and returns targets. It is not a
target: it has no id, no attrs schema, no node in the graph, and no label. The
targets it returns are the only things that exist afterwards.

## The worked example

`StandardPackage` expands one conventional TypeScript package into six targets.

```ts
// packages/targets/src/StandardPackage.ts
export interface Options {
  readonly packageManager: PackageManager.PackageManager
  readonly deps: ReadonlyArray<Target.AnyTarget>
  readonly cwd?: string | undefined
  readonly sources?: Input.Glob | undefined
  readonly tests?: Input.Glob | undefined
  readonly tsconfig?: Input.File | undefined
  readonly vitestConfig?: Input.File | null | undefined
  readonly eslintConfigs?: ReadonlyArray<Input.File> | undefined
}

export interface StandardTargets {
  readonly lib: ReturnType<typeof TsBuild>
  readonly test: ReturnType<typeof Vitest>
  readonly lint: ReturnType<typeof EsLint>
}

export const StandardPackage = (options: Options): StandardTargets => {
  const cwd = options.cwd ?? "."
  const sources = options.sources ?? Input.glob("src/**/*.ts")
  const tests = options.tests ?? Input.glob("test/**/*.test.ts")
  const tsconfig = options.tsconfig ?? Input.file("tsconfig.json")
  const vitestConfig = options.vitestConfig === undefined
    ? Input.file("vitest.config.ts")
    : options.vitestConfig
  const eslintConfigs = options.eslintConfigs ?? [
    Input.file("eslint.config.js"),
    Input.file("//eslint.jsdoc.js")
  ]

  const lib = TsBuild({
    packageManager: options.packageManager,
    srcs: [sources],
    entries: ["src/index.ts"],
    deps: options.deps,
    tsconfig,
    tool: { name: "tsc" },
    format: "dual",
    outDir: "dist",
    cwd
  })

  const test = Vitest({
    packageManager: options.packageManager,
    tests: [tests],
    sources: [sources],
    deps: [lib, ...options.deps],
    config: vitestConfig,
    environment: "node",
    passWithNoTests: false,
    cwd
  })

  const lint = EsLint({
    packageManager: options.packageManager,
    sources: [sources],
    deps: [],
    configs: eslintConfigs,
    maxWarnings: 0,
    fix: false,
    cwd
  })

  return { lib, test, lint }
}
```

Use it by destructuring:

```ts
// packages/plan/PACKAGE.ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

export const { lib, test, lint } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/plan"
})
```

## What the example demonstrates

**Defaults are a policy, not a mechanism.** Every default in `StandardPackage`
encodes the Smithers repository layout. A caller who overrides `sources` gets a
different declared input; nothing else changes.

**The toolchain has no default.** `packageManager` is a required option: a macro
that guessed one would reintroduce the hardcoded manager the attr exists to
remove. The caller passes the workspace's declared manager, and the macro
threads it into every target call.

**Edges are threaded, not inferred.** `lib` gets the caller's `deps` directly.
`test` gets `[lib, ...deps]`, because a test run needs its own package built and
its dependencies too. `lint` gets `[]`, because linting one package's sources
does not require another package to be built.

**A declared value is shared, not duplicated.** `sources` is one `Input.Glob`
value used by both `lib` and `test`. Each target digests it independently and
gets the same digest for the same content.

**Nullability is meaningful.** `vitestConfig` distinguishes `undefined`, which
means "use the default `vitest.config.ts`", from `null`, which means "pass no
`--config`". The `undefined` check has to be explicit; `??` would collapse the
two.

**Lint covers sources only.** The flat config declares no coverage for test
files, and ESLint 9 fails on a pattern whose matches are all unconfigured. The
macro encodes that constraint so callers do not rediscover it.

## Composing a macro with target calls

The macro's result is an ordinary object. Rename, drop, or extend it.

```ts
// packages/engine/PACKAGE.ts
import { Smithers } from "@smthrs/targets"
import { packageManager, runtime } from "../../PACKAGE.ts"
import { lib as flow } from "../flow/PACKAGE.ts"

const standard = Smithers.StandardPackage({ packageManager, deps: [flow], cwd: "packages/engine" })

export const lib = standard.lib
export const test = standard.test
export const lint = standard.lint

export const dependencyPolicy = Smithers.DepsLint({
  runtime,
  packageManager,
  packageJson: Smithers.file("package.json"),
  sources: [Smithers.glob("src/**/*.ts"), Smithers.glob("test/**/*.ts")],
  deps: [lib],
  tool: "knip",
  ignoreDependencies: ["@effect/platform-node"],
  ignoreBinaries: [],
  cwd: "packages/engine"
})
```

Only exported targets get labels. Export every macro target that another exported
target depends on. Planning labels every dependency it walks, so a dependency
that no `PACKAGE.ts` exports fails the command with
`could not derive a label for <target>; export it from a PACKAGE.ts file`. In the
example above, dropping the `export` on `lib` would fail every command that
reaches `dependencyPolicy`.

## Writing your own macro

Put it in a shared module and import it from `PACKAGE.ts` files, or define it
directly in the root `PACKAGE.ts` and import it from package files.

```ts
// build/macros.ts
import { Smithers } from "@smthrs/targets"

export interface BrowserPackageOptions {
  readonly packageManager: PackageManager.PackageManager
  readonly deps: ReadonlyArray<Target.AnyTarget>
  readonly cwd: string
}

export const BrowserPackage = (options: BrowserPackageOptions) => {
  const sources = Smithers.glob("src/**/*.ts")

  const lib = Smithers.TsBuild({
    packageManager: options.packageManager,
    srcs: [sources],
    entries: ["src/index.ts"],
    deps: options.deps,
    tsconfig: Smithers.file("tsconfig.json"),
    tool: { name: "tsup", external: ["react"] },
    format: "esm",
    outDir: "dist",
    cwd: options.cwd
  })

  const lint = Smithers.EsLint({
    packageManager: options.packageManager,
    sources: [sources],
    deps: [],
    configs: [Smithers.file("eslint.config.js")],
    maxWarnings: 0,
    fix: false,
    cwd: options.cwd
  })

  return { lib, lint }
}
```

Guidelines:

- Take the toolchain as a required option and thread it into every tool-running
  target call. A macro that hardcodes a package manager cannot follow the
  workspace's declared one.
- Take `cwd` and thread it into every target call. A macro that hardcodes the
  workspace root cannot be reused by a package.
- Accept `deps` and thread them explicitly. Nothing infers edges.
- Give every option a default and let callers override one thing without
  replacing the macro.
- Return an object whose keys are the intended export names, so callers can
  destructure.
- Do not read the filesystem. A macro runs during `PACKAGE.ts` evaluation.

## Macros as default targets

A macro whose remaining required options arrive through the declaration's
`attrs` can be used directly as a default-target macro, which is how
`StandardPackage` covers every package in the Smithers workspace that has no
`PACKAGE.ts` of its own:

```ts
export const packageDefaults = PackageDefaults({
  directories: "packages/*",
  macro: StandardPackage,
  attrs: { packageManager }
})
```

Synthesis calls the macro with `{ cwd: <directory>, ...attrs }`. See
[Default targets](default-rules.md).

## Next

- [Default targets](default-rules.md)
- [Writing targets](writing-targets.md)
- [StandardPackage reference](../reference/targets/standard-package.md)
