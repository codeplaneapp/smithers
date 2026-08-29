# StandardPackage

Expands one conventional TypeScript package into `lib`, `check`, `test`,
`lint`, `fmt`, `docs`, and `circular`.

`StandardPackage` is a **macro**, not a target. It has no id, no attrs schema, no
node in the graph, and no label. It calls [TsBuild](ts-build.md),
[Typecheck](typecheck.md), [Vitest](vitest.md), [EsLint](es-lint.md),
[Dprint](dprint.md), [DocsParity](docs-parity.md), and [NodeTest](node-test.md) and returns their
targets.

```ts
// packages/plan/BUILD.ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/plan"
})
```

## Options

| Name             | Type                            | Default                                                 | Description                                                                 |
| ---------------- | ------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| `packageManager` | `PackageManager.PackageManager` | required                                                | The declared package manager every emitted target runs its tool through.    |
| `deps`           | `Array<Target.AnyTarget>`       | `[]`                                                    | Dependency targets threaded into `lib`, `check`, and `test`.                |
| `cwd`            | `string`                        | `"."`                                                   | Workspace-relative package directory every emitted tool runs in.            |
| `sources`        | `Input.Glob`                    | `glob("src/**/*.ts")`                                   | The source set.                                                             |
| `tests`          | `Input.Glob`                    | `glob("test/**/*.test.ts")`                             | The test set.                                                               |
| `tsconfig`       | `Input.File`                    | `file("tsconfig.json")`                                 | The tsconfig `tsc -p` builds.                                               |
| `testTsconfig`   | `Input.File`                    | `file("tsconfig.test.json")`                            | The tsconfig `check` typechecks.                                            |
| `vitestConfig`   | `Input.File \| null`            | `file("vitest.config.ts")`                              | The Vitest config. Pass `null` explicitly to run Vitest with no `--config`. |
| `eslintConfigs`  | `Array<Input.File>`             | `[file("eslint.config.js"), file("//eslint.jsdoc.js")]` | The flat configs.                                                           |
| `dprintConfig`   | `Input.File`                    | `file("dprint.json")`                                   | The dprint config.                                                          |
| `readme`         | `Input.File`                    | `file("README.md")`                                     | The README the docs-parity target summarizes.                               |
| `circularScript` | `Input.File`                    | `file("scripts/circular.mjs")`                          | The circular-dependency guard the package runs.                             |

`vitestConfig` distinguishes `undefined`, which means "use the default", from
`null`, which means "pass no `--config`".

## What it emits

```ts
interface StandardTargets {
  readonly lib: ReturnType<typeof TsBuild>
  readonly check: ReturnType<typeof Typecheck>
  readonly test: ReturnType<typeof Vitest>
  readonly lint: ReturnType<typeof EsLint>
  readonly fmt: ReturnType<typeof Dprint>
  readonly docs: ReturnType<typeof DocsParity>
  readonly circular: ReturnType<typeof NodeTest>
}
```

| Target     | Target       | Attributes                                                                                                                                     |
| ---------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib`      | `TsBuild`    | `srcs: [sources]`, `entries: [file("src/index.ts")]`, `deps`, `tsconfig`, `tool: { name: "tsc" }`, `format: "dual"`, `outDir: "dist"`, `cwd`   |
| `check`    | `Typecheck`  | `srcs: [sources, glob("test/**/*.ts")]`, `deps: [lib, ...deps]`, `tsconfig: testTsconfig`, `buildMode: false`, `incremental: false`, `cwd`     |
| `test`     | `Vitest`     | `tests: [tests]`, `sources: [sources]`, `deps: [lib, ...deps]`, `config: vitestConfig`, `environment: "node"`, `passWithNoTests: false`, `cwd` |
| `lint`     | `EsLint`     | `sources: [sources]`, `deps: []`, `configs: eslintConfigs`, `maxWarnings: 0`, `fix: false`, `cwd`                                              |
| `fmt`      | `Dprint`     | `sources: [sources, glob("test/**/*.ts")]`, `deps: []`, `config: dprintConfig`, `fix: false`, `cwd`                                            |
| `docs`     | `DocsParity` | `readme`, `deps: []`, `cwd`                                                                                                                    |
| `circular` | `NodeTest`   | `runtime: packageManager.runtime`, `runner: entrypoint(circularScript)`, `srcs: [sources]`, `deps: []`, `cwd`                                  |

Every emitted target call also receives `packageManager: options.packageManager`.

Notes on the edges and the lint scope:

- `check` and `test` depend on `lib` plus the caller's `deps`, because a
  typecheck of the test project and a test run both need their own package
  built and its dependencies too.
- `lint`, `fmt`, and `docs` depend on nothing: checking one package's sources
  does not require another package to be built.
- `lint` covers the source glob only. The flat config declares no coverage for
  test files, and ESLint 9 fails on a pattern whose matches are all
  unconfigured. A package whose config does cover tests should call `EsLint`
  directly with both globs.

## As a default-target macro

Every other option has a convention default. Synthesis supplies `cwd`, and the
declaration's `attrs` supply the toolchain, so it plugs straight into a
`PackageDefaults` declaration:

```ts
// BUILD.ts
export const packageDefaults = PackageDefaults({
  directories: "packages/*",
  macro: StandardPackage,
  attrs: { packageManager }
})
```

See [Default targets](../../extending/default-targets.md).

## Status

Not a target, so it has no kinds, no cacheability, and no execution status of its
own. The six targets it emits each carry their own; all six execute today.

## See also

- [Writing macros](../../extending/writing-macros.md)
- [TsBuild](ts-build.md), [Typecheck](typecheck.md), [Vitest](vitest.md),
  [EsLint](es-lint.md), [Dprint](dprint.md), [DocsParity](docs-parity.md),
  [NodeTest](node-test.md)
