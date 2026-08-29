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

Some files at the repository root are generated from `BUILD.ts` and then
pinned by suites that deliberately re-declare rather than import them.
Importing `BUILD.ts` would be circular, since it imports the very packages
doing the pinning. `pnpm-workspace.yaml` is the exception: pnpm owns and may
update it, so it is hand-written and authoritative. The build graph parses its
`packages` list and keys lockfile resolution and installation on the file plus
the root and selected member manifests.

The cost is that one edit lands in several places. If you change:

| What                                        | Also update                                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm-workspace.yaml` package membership    | `packages/flows/test/vitestCoverageIsolation.test.ts` (the coverage-universe policy pin); lockfile inputs are derived automatically                                            |
| root `package.json` scripts                 | `packages/flows/test/vitestCoverageIsolation.test.ts` (the aggregator roster)                                                                                                  |
| root `BUILD.ts` CI jobs, steps, or triggers | the generated `.github/workflows/ci.yml` (`pnpm exec smthrs build '//:ci'` with `mode: "write"`), and `packages/flows/test/vitestCoverageIsolation.test.ts` (source-text pins) |
| `.github/workflows/release.yml`             | the same suite, plus `scripts/release-rehearsal.test.mjs`                                                                                                                      |

Miss one and CI reports a generated file as a hand edit, which is exactly
what it should do — it cannot tell your deliberate change from a stray one.

## Root graph rationale

The root `BUILD.ts` intentionally contains declarations only, with its
explanatory prose kept here. Nothing in that file is a command. Jobs declare
the toolchain a runner provides and the targets they invoke; `GithubCiGen`
derives checkout, installation, tool setup, and every
`pnpm exec smthrs <verb> <pattern>` argv. A gate must therefore become a target
in the package that owns it before CI can invoke it, matching Bazel's rule that
a BUILD file has no free-form command surface.

The generated `tsconfig.json` is the root TypeScript project. The lockfile and
install are separate targets because a target cannot be keyed on a file it
also produces: `Lockfile` writes `pnpm-lock.yaml`, while `Install` consumes the
lockfile target. The hand-written `pnpm-workspace.yaml` is a planner input. Its
contents select the workspace manifests, and all of those files key both
targets, so a membership or dependency edit forces resolution before linking
`node_modules`. `PackageDefaults` applies `StandardPackage` to each
`packages/*` directory with a `package.json` and no BUILD file, synthesizing
the conventional `lib`, `check`, `test`, `lint`, `fmt`, and `docs` targets;
packages with a different layout carry their own BUILD file.

The CI declaration has several deliberate operational constraints:

- The `test` job aggregates build, test, lint, docs, format, and circular
  targets in one graph plan. It uses `parallelism: 2` because the heavy Vitest
  suites have finite 30-second per-test budgets that excessive concurrency on
  a four-core runner can starve.
- `actionlint` checks every workflow named by the declaration so GitHub-only
  expression-context failures surface in review, not in a scheduled run.
  `apps/server/scripts/canary/workflow-wiring.test.ts` ensures no workflow is
  omitted. The script targets include the browser contract and release
  pack-and-smoke chain; the agent eval suite and typecheck are offline and
  baseline-gated. CI also lint-checks its own generated workflow so the file
  describing the pipeline is not exempt from drift enforcement.
- The `apps-e2e` lane is separate because it boots Wrangler and a real Chrome;
  nothing under `apps/` needs jj. The Ubuntu runner's Chrome path is asserted
  because `BrowserLaunch.ts` probes that fixed candidate list. Screenshots in
  `/tmp` and launch-checklist reports under `apps/reports` are collected under
  one artifact root.
- Issue #163 requires jj on `PATH` for the real-binary suites so a missing
  binary fails loudly instead of skipping. GitHub checkout creates a Git
  repository, not a jj repository, so CI initializes colocated metadata before
  those contracts run.
- `rust-toolchain.toml` is the shared pin for the Rust jobs. The WebAssembly
  lane rebuilds `packages/jj/wasm/flows_jj.wasm` without a build cache and
  requires byte-for-byte equality with the committed artifact. Its Linux host
  triple is part of that reproducibility contract; `build-wasm.mjs` refuses a
  different host explicitly rather than producing a misleading byte diff.
- The Bun lane covers only the compatibility matrix documented in
  `ci/BUILD.ts`. The browser lane remains a standalone contract until a real
  browser-runner suite exists. macOS and Windows package suites are advisory
  until they establish a stable green history; known Windows path failures are
  not chased in that lane.

The package policy in `pnpm-workspace.yaml` is equally deliberate.
`verifyDepsBeforeRun` stays disabled because installation is an explicit graph
step, and a gate must not reinstall what it is measuring with different script
settings. Playwright lifecycle builds stay denied: the live browser checks use
a system or previously installed browser, so dependency installation must not
download one.

Packages under `packages/` follow the structure and conventions in the Effect repository. Use `reference/effect` as the local reference when adding or changing package modules, public APIs, tests, build configuration, or package metadata.

## A BUILD.ts file declares targets, never commands

`BUILD.ts` says what the workspace has. It never says how to run it. A raw argv
in a BUILD file — a `run:` string, a bare executable name, a shell fragment — is
a gate the build system does not know about: unplanned, unkeyed, uncached, not
addressable by label, and not runnable locally by the name CI uses. It also pins
the interpreter and the package manager at the call site, so the workspace can no
longer switch either by editing one declaration.

Argv rendering belongs in target implementations. `PackageManager.install()`
renders `pnpm install --frozen-lockfile --ignore-scripts`; `Runtime.test()`
renders `node --test`; `RustToolchain.install()` renders
`rustup toolchain install`. A declaration passes the toolchain in and the
implementation asks it for the argv.

Every CI gate is therefore a target, in the package that owns it:
`scripts/BUILD.ts` for the operator and release scripts, `crates/*/BUILD.ts` for
the cargo gates, `apps/*/BUILD.ts` for an app's end-to-end suites, `ci/BUILD.ts`
for the targets that belong to no single package. `.github/workflows/ci.yml` is
generated from those declarations: a job names what it requires and which targets
it runs, and `GithubCiGen` derives every step. Its attrs schema has no field that
would hold a command, so reintroducing one is a compile error rather than a
review conversation.

Bazel is the prior art: a `BUILD` file has no way to write a command at all,
every check is a test target, and CI is one verb over the graph. If a gate does
not fit an existing target type, add a target type; `ToolBuild` is the
deliberate escape hatch and using it is something to justify in review. The full
rule, with examples, is in
[`packages/build/docs/workspace/writing-build-files.md`](packages/build/docs/workspace/writing-build-files.md).

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
