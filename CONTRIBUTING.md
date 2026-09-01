# Contributing

Use Node.js 22.19 or later. Install dependencies with `pnpm install`.

Before opening a pull request, run every gate:

```sh
pnpm run check
pnpm test
pnpm run lint
pnpm run circular
pnpm run browser
pnpm run test:examples
pnpm exec vocs build
```

`pnpm test` is the one that catches the most, and it stops at the first
failing package — so a green partial run proves less than it looks like it
does. `pnpm --recursive --if-present --no-bail run test` reports every
package instead of the first casualty.

## Changing a root file

Package mode uses two declaration layers. `.smithers/WORKSPACE.ts` declares
the runtime, package manager, `nodeModules`, host binaries, Rust toolchain,
agents, git hooks, and nested repositories. Each participating directory has a
`PACKAGE.ts` that declares its targets. The root `PACKAGE.ts` composes those
targets and owns generated root surfaces.

`pnpm-workspace.yaml` remains hand-written and authoritative. pnpm uses it for
package membership, while `.smithers/WORKSPACE.ts` uses it as the workspace
input for `nodeModules`.

The cost is that one edit lands in several places. If you change:

| What | Also update |
| --- | --- |
| `pnpm-workspace.yaml` package membership | The affected directory's `PACKAGE.ts`, any root `PACKAGE.ts` imports and suites that consume it, `packages/flows/test/vitestCoverageIsolation.test.ts`, and both lockfiles. |
| Root `package.json` scripts | `packages/flows/test/vitestCoverageIsolation.test.ts` (the aggregator roster). |
| Root `PACKAGE.ts` CI lanes, triggers, or generated-file set | The generated GitHub files (`pnpm exec smithers-build target '//:githubCi' --write`) and `packages/flows/test/vitestCoverageIsolation.test.ts` source-text pins. |
| Any tracked file addition or removal | `known-files.d.ts` (`node scripts/generate-known-files.mjs`). |
| The `tsconfig` declaration in root `BUILD.ts` | `tsconfig.json` (`pnpm exec smithers-build target '//:tsconfig' --write`). |
| A dependency or package manifest | Both `pnpm-lock.yaml` and `bun.lock`. |
| A nested `WORKSPACE.ts` or `.smithers/WORKSPACE.ts` tree | The `repos` map in `.smithers/WORKSPACE.ts`. Discovery otherwise throws `nested_workspace_undeclared`. |
| `.github/workflows/release.yml` | `packages/flows/test/vitestCoverageIsolation.test.ts` and `scripts/release-rehearsal.test.mjs`. |

Miss one and CI reports a generated file as a hand edit, which is exactly
what it should do. It cannot tell your deliberate change from a stray one.

## Package graph rationale

Every declaration file is named `PACKAGE.ts` and exports exactly one package
map:

```ts
export const Package = S.Package({
  targets: { check, test, lint }
})
```

Keep targets private constants until the `targets` map gives them labels. Do
not export naked targets or additional package maps. The loader rejects those
shapes.

Package mode does not run `PackageDefaults`, so it synthesizes no `lib`,
`check`, `test`, `lint`, `fmt`, `docs`, or `circular` targets. Each package
declares the checks that apply to its own layout. Use
`packages/canonical/PACKAGE.ts` as the reference shape for a TypeScript
package, then add or omit targets only when the package's runtime or layout
requires it.

The root `PACKAGE.ts` imports the package maps that its suites consume. It
composes the deterministic `gates` suite, the cheap `preCommit` suite, the
agent-judged `agentLints` suite, and the `prGate` suite. A gate must become a
target in the `PACKAGE.ts` of the package that owns it before a root suite or
CI lane can invoke it.

`.smithers/WORKSPACE.ts` is the workspace declaration. Its `repos` map marks
nested workspaces as opaque discovery boundaries. Add every nested
`WORKSPACE.ts` or `.smithers/WORKSPACE.ts` tree to that map before it enters
the repository. Otherwise discovery stops with
`nested_workspace_undeclared`.

The CI declaration has several deliberate operational constraints:

- The root `PACKAGE.ts` declares each lane with `S.Github.Workflow` and renders
  the set through one `S.Github.CiGen` target. Run
  `pnpm exec smithers-build target '//:githubCi' --write` to regenerate it and
  `pnpm exec smithers-build lint '//:githubCi'` to check drift.
- Jobs name package-mode targets. The generator derives checkout, package
  setup, tool setup, and target invocation from the workspace and target
  declarations.
- `.smithers/WORKSPACE.ts` pins the Node runtime, pnpm, host binaries, and Rust
  toolchain that those jobs use.
- Package mode serves `query`, `graph`, `target <label> [--plan]`, `test`,
  `build`, `lint`, and `gitHooks`. The `ci`, `docs`, and `install` verbs refuse
  in package mode. Invoke the declared suites and generation targets directly.

The package policy in `pnpm-workspace.yaml` is equally deliberate.
`verifyDepsBeforeRun` stays disabled so a gate does not reinstall what it is
measuring with different script settings. Playwright lifecycle builds stay
denied: the live browser checks use a system or previously installed browser,
so dependency installation must not download one.

Packages under `packages/` follow the structure and conventions in the Effect repository. Use `reference/effect` as the local reference when adding or changing package modules, public APIs, tests, build configuration, or package metadata.

## A PACKAGE.ts file declares addressable work

Module evaluation constructs the target graph. It must not execute a command,
read ambient host state, or mutate the workspace. Put executable behavior in a
supported target constructor such as `S.Shell.Test`, `S.Shell.Build`, or
`S.Generate`. Declare the binary, arguments, working directory, inputs, outputs,
write set, sandbox, and approval that the constructor needs.

Every CI gate belongs to its owner: `scripts/PACKAGE.ts` for operator and
release scripts, `crates/flows-jj/PACKAGE.ts` for Cargo gates, and each
`apps/*/PACKAGE.ts` or `packages/*/PACKAGE.ts` for its own checks. The root
package composes those labeled targets. This makes each gate planned, keyed,
cached, locally addressable, and identical to the target CI invokes.

If a gate does not fit an implemented target type, add or extend a target type.
Do not hide the gate in a workflow step or execute it while loading a
declaration.

## Working with the vendored jj submodule

The Rust crates under `crates/` build against `jj-lib` from the `vendor/jj` git submodule. A plain `git clone` leaves that directory empty and `cargo` then fails with a missing `vendor/jj/lib/Cargo.toml`. Populate it once after cloning:

```sh
git submodule update --init
```

Run the same command after any pull that moves the submodule pointer. Only the Rust and WebAssembly work reads `vendor/jj`; the TypeScript gates do not.

## JSDoc convention

`pnpm run lint` enforces this. The rules live in [`eslint.jsdoc.js`](eslint.jsdoc.js), which every package's `eslint.config.js` spreads in.

- **Every module gets a header** — a block above the first statement, carrying prose and `@since`. It says what the module is for and why it is shaped the way it is, not what its exports are called.
- **Every exported declaration gets prose, `@category`, and `@since`.** The prose must let a reader learn what the thing IS and when to reach for it without opening the implementation. `packages/flow/src/RetryPolicy.ts` is the bar; `packages/kernel/src/GrantStore.ts` is the canonical service-module shape and `packages/engine-store/src/internal/AttemptProbe.ts` the internal-module one.
- **One tag per line.** `@since 0.1.0 @category models` on a single line parses as one `@since` tag whose description happens to contain the word `@category`, so the second tag silently does not exist.
- **`@category` is a lowercase noun** — `models`, `constructors`, `layers`, `services`, `errors`, `schemas`, and the few narrower ones a module already uses.
- **`@since` is `0.1.0`** for new code; nothing here has shipped. Code adapted from Effect v4 keeps the `4.0.0` it was written with, because that is the release it dates from.
- **`@private` blocks drop `@category`** and need no prose — a private export belongs to no documented category. They still carry `@since`.
- **There is no `@internal` tag.** Hiding a module is done three other ways, all of which survive a reader who ignores comments: put it under `internal/`, null its entry in the package `exports` map, and mark the declaration `@private`.
- **Re-exports are not gated.** `export { x }` and `export * as Ns from "…"` document the module they point at; their prose belongs at the definition site.

The full contributor guide is [docs/pages/contributing.md](docs/pages/contributing.md), served at `/contributing` by `pnpm exec vocs dev`. It covers what each gate proves, the prose rules for docs pages, the commit conventions including the `Docs:` and `Depends-on:` trailers, and the epic plan.
