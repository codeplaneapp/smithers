# Writing BUILD files

A `PACKAGE.ts` file is a TypeScript module. The CLI imports it through the
programmatic `tsx` loader with `tsconfig: false`, then inspects every named
export.

One constraint comes from that loader. `tsconfig: false` means no tsconfig is
read, so compiler options declared in the workspace do not apply: a `paths` alias
does not resolve, and a relative import names the real file, extension included,
as in `import { lib } from "../plan/PACKAGE.ts"`.

## Targets are named exports

Any export whose value is a target becomes a label. The label is the package path
plus the export name.

```ts
// packages/smithers/flows/flow/PACKAGE.ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const sources = Smithers.glob("src/**/*.ts")
const tests = Smithers.glob("test/**/*.test.ts")

export const lib = Smithers.TsBuild({
  packageManager,
  srcs: [sources],
  entries: [Smithers.file("src/index.ts")],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  tool: { name: "tsc" },
  format: "dual",
  outDir: "dist",
  cwd: "packages/smithers/flows/flow"
})

export const test = Smithers.Vitest({
  packageManager,
  tests: [tests],
  sources: [sources],
  deps: [lib],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd: "packages/smithers/flows/flow"
})

export const lint = Smithers.EsLint({
  packageManager,
  sources: [sources, tests],
  deps: [],
  configs: [Smithers.file("eslint.config.js"), Smithers.file("//eslint.jsdoc.js")],
  maxWarnings: 0,
  fix: false,
  cwd: "packages/smithers/flows/flow"
})
```

`sources` and `tests` are module-local bindings, not exports, so they never
become labels. They are still declared inputs of the targets that reference them.

Exports that are not targets are ignored, with two exceptions: a `Workspace` value
configures the workspace, and a `PackageDefaults` value declares synthesis. See
[Configuration](configuration.md) and
[Default targets](../extending/default-rules.md).

## BUILD files declare targets, never commands

A BUILD file says WHAT the workspace has. It never says how to run it.

```ts
// Wrong. This is a gate outside the build graph.
export const ci = Smithers.GithubCiGen({
  jobs: [{ id: "test", steps: [{ run: "node --test scripts/pack-release.test.mjs" }] }]
})

// Right. The gate is a target, and the pipeline names it.
// scripts/PACKAGE.ts
export const packManifest = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//scripts/pack-release.test.mjs")]),
  srcs: [Smithers.glob("//scripts/**/*.mjs")],
  deps: []
})

// PACKAGE.ts
export const ci = Smithers.GithubCiGen({
  jobs: [{ id: "test", toolchain, steps: [{ verb: Smithers.Verb.Test, pattern: "//scripts/..." }] }]
})
```

A raw argv in a BUILD file — a `run:` string, an executable name, a shell
fragment — is a gate the build system does not know about. It is not planned,
not keyed, not cached, not addressable by label, and not runnable locally by the
name CI uses. It also pins the interpreter and the package manager at the call
site, so the workspace can no longer switch either by editing one declaration.

**Argv rendering belongs in target implementations.** `PackageManager.install()`
renders `pnpm install --frozen-lockfile --ignore-scripts`; `Runtime.test()`
renders `node --test`; `RustToolchain.install()` renders
`rustup toolchain install`. A declaration passes the toolchain in and the
implementation asks it for the argv.

Bazel is the prior art the rule comes from: a `BUILD` file has no way to write a
command at all, every check is a test target, and CI is one verb over the graph
(`bazel test //...`). If a gate does not fit an existing target type, add a
target type — [`NodeTest`](../reference/targets/node-test.md),
[`NodeBinary`](../reference/targets/node-binary.md), and
[`CargoLint`/`CargoTest`](../reference/targets/cargo.md) all exist because a
pipeline needed one — or reach for
[`ToolBuild`](../reference/targets/tool-build.md), the deliberate escape hatch,
and say in review why the toolchain does not deserve a type of its own.

The schemas enforce this where the pressure is highest.
[`GithubCiGen`](../reference/targets/github-ci-gen.md) has no attribute anywhere
that accepts a command, an action reference, or a shell script: a job declares
what it requires and which targets it runs, and the generator derives every
step.

## Target calls

A target call takes exactly one object: the target's attributes. The attrs are an
Effect `Schema.Struct`, so the call validates them and applies constructor
defaults. Passing an unknown key or the wrong type is a type error and a runtime
decode failure.

Every attribute value is key material. A `cwd` change, a flag flip, or a
different tool re-keys the target.

The target call itself performs no I/O. It builds a flow, walks the decoded attrs
for declared inputs and target references, and attaches planner metadata.

## Imports are dependency edges

Import a target and put it in an attrs value. The target collector walks the whole
attrs object, at any depth, through arrays and plain objects.

```ts
// packages/smithers/flows/engine/PACKAGE.ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"
import { lib as flow } from "../flow/PACKAGE.ts"

const standard = Smithers.StandardPackage({ packageManager, deps: [flow], cwd: "packages/smithers/flows/engine" })

export const lib = standard.lib
export const test = standard.test
export const lint = standard.lint
```

Every catalog target has a `deps` attribute typed as `Schema.Array(Target.Target)`,
which is the conventional place to put edges. Nothing requires it: a target
value in any attribute becomes an edge.

Labels never appear in attrs. See [Dependencies](../concepts/dependencies.md).

## Declared inputs

`glob()`, `file()`, and `gitDiff()` create inert values. They read nothing at
module-evaluation time. The planner expands and digests them during discovery.

```ts
const sources = glob("src/**/*.ts")
const generated = glob("src/**/*.ts", { exclude: ["src/**/*.gen.ts"] })
const config = file("vitest.config.ts") // package-relative
const rootConfig = file("//eslint.jsdoc.js") // workspace-relative
const changes = gitDiff("origin/main")
```

Reuse one declared value across several targets. Each target digests it
independently, and equal content always produces an equal digest. See
[Inputs](../concepts/inputs.md).

## Macros

A macro is an ordinary function that returns targets. It is not a target, has no
identity in the graph, and produces no node of its own.

```ts
// packages/smithers/flows/plan/PACKAGE.ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

export const { lib, test, lint } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/smithers/flows/plan"
})
```

Destructuring the result exports each target under its own name. Rename freely:

```ts
const standard = StandardPackage({ packageManager, deps: [], cwd: "packages/smithers/flows/plan" })

export const build = standard.lib
export const check = standard.test
```

Mix a macro with extra target calls in the same file:

```ts
import { packageManager, runtime } from "../../PACKAGE.ts"

const standard = StandardPackage({ packageManager, deps: [flow], cwd: "packages/smithers/flows/engine" })

export const lib = standard.lib
export const test = standard.test
export const lint = standard.lint

export const dependencyPolicy = DepsLint({
  runtime,
  packageManager,
  packageJson: file("package.json"),
  sources: [glob("src/**/*.ts"), glob("test/**/*.ts")],
  deps: [lib],
  tool: "knip",
  ignoreDependencies: ["@effect/platform-node"],
  ignoreBinaries: [],
  cwd: "packages/smithers/flows/engine"
})
```

See [Writing macros](../extending/writing-macros.md).

## The root PACKAGE.ts

The root file carries workspace-level declarations.

```ts
// PACKAGE.ts
import { Smithers } from "@smthrs/targets"

export const config = Smithers.Workspace({ cacheDirectory: ".flows", gitignored: true })

export const runtime = Runtime.Node({ version: ">=22.19.0" })
export const packageManager = PackageManager.Pnpm({ version: "11.21.0", runtime })

export const nodeModules = Smithers.Install({ packageManager })

export const rootJSDocConfig = Smithers.file("//eslint.jsdoc.js")

export const packageDefaults = Smithers.PackageDefaults({
  directories: "packages/*",
  macro: Smithers.StandardPackage,
  attrs: { packageManager }
})
```

A shared `file()` export like `rootJSDocConfig` is a plain declared value. Other
`PACKAGE.ts` files import it and put it in their attrs.

## Targets to follow

- Do not read the filesystem, spawn a process, or await anything at module scope.
  Discovery imports these modules, and the model assumes evaluation is pure.
- Do not export the same target value under two names. Discovery refuses it.
- Give every tool-running target a `cwd` when it belongs to a package. The
  default is the workspace root.
- Keep `PACKAGE.ts` imports to `@smthrs/targets`, other `PACKAGE.ts` files, and
  standard TypeScript. Anything else runs at discovery time on every command.

## Next

- [Running targets](running-targets.md)
- [Targets and targets](../concepts/targets.md)
- [Target catalog](../reference/targets/README.md)
