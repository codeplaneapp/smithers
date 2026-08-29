# Adoption in the flows repository

The flows monorepo dogfoods smithers build on itself. This page records what is
adopted today, what still runs through plain pnpm scripts, and the criteria
for moving the boundary. Dates are absolute because this page is a status
record, not a design.

## Adopted (2026-08-15)

- **Targets for every package.** The root `BUILD.ts` declares
  `PackageDefaults({ directories: "packages/*", macro: StandardPackage })`, so
  every package without its own `BUILD.ts` synthesizes six targets: `lib`
  (TsBuild), `check` (Typecheck over `tsconfig.test.json`, scheduled after
  `lib`), `test` (Vitest), `lint` (EsLint), `fmt` (Dprint), and `docs`
  (DocsParity). Four packages declare targets by hand — `packages/flow`
  (the desugared form, kept equivalent to the macro), `packages/engine`,
  `packages/plan`, and `packages/build` — and
  `build-cli/test/CommittedBuildFiles.test.ts` loads every committed
  `BUILD.ts` on each test run so a targets-API change cannot silently
  invalidate one again.
- **Gate parity at the package level.** `smthrs ci "//packages/..."` plans
  130 targets over 26 packages. `lib` + `check` cover what the package
  `check` scripts cover; `lint` + `fmt` cover the package `lint` scripts;
  `test` runs the same vitest configs, including their coverage gates.
- **The graph IS the CI lane (2026-08-19).** The advisory `smthrs-shadow`
  job is gone: it existed to shadow the recursive pnpm scripts, and those
  are no longer in the pipeline. The required `test` job runs
  `smthrs ci "//packages/..."` directly, alongside `smthrs test
  "//scripts/..."` and the labelled gates of the other jobs. The shadow
  lane's first flights found two real defects (the pnpm
  `verify-deps-before-run` mid-gate reinstall, now off via the repo
  `.npmrc`, and the withheld `CI` variable, now inherited by `ExecLive`),
  which was the lane's purpose.
- **Verb-aware package labels.** `smthrs lint //packages/plan` selects the
  package's lint-participating targets instead of refusing on the
  build-only default target.
- **Workflow generation (2026-08-19).** `.github/workflows/ci.yml` is a
  generated root file. The root `BUILD.ts` declares it through `GithubCiGen`
  with `mode: "check"`, `smthrs build //:ci` regenerates it, and every other
  verb drift-checks it, on the same terms as `tsconfig.json`. Nothing in the
  declaration is a command: a job states what the runner must provide and
  which targets it runs, and the generator derives every step. The `test` job
  also runs `smthrs lint "//:ci"`, so the workflow describing the pipeline is
  drift-checked by the pipeline.
- **Workspace-file authority (2026-08-19).** `pnpm-workspace.yaml` is
  hand-written and authoritative rather than generated from root BUILD attrs.
  The root lockfile and install declarations use a planner input that parses
  and schema-validates its `packages` list, then digests the file, root
  manifest, and every selected member manifest. pnpm can therefore maintain
  settings that are not representable by the old generator without creating
  an unsatisfiable drift check, while membership and manifest edits still
  invalidate dependency resolution.

- **Root-level gates (2026-08-19).** Every gate that used to be a workflow
  string is a target now, in the package that owns it: `scripts/BUILD.ts`
  (the operator and release scripts, the browser bundle guard, the release
  pack-and-smoke chain), `crates/flows-jj/BUILD.ts` (the cargo gates and the
  wasm reproducibility rebuild), `apps/ui/BUILD.ts` (the end-to-end suites),
  `evals/agent/BUILD.ts` (the offline eval suite), and `ci/BUILD.ts` (the Bun
  compatibility matrix, which belongs to no single package). The
  circular-dependency guard is emitted per package by `StandardPackage`.
  `NodeTest`, `NodeBinary`, `CargoLint`, and `CargoTest` are the catalog
  target types that made it possible.

## Not yet adopted

- **Caching.** TsBuild, Typecheck, Vitest, EsLint, and Dprint are
  `cache: false`: their input contracts are not yet complete key material
  (the external toolchain versions are not folded in). Until they opt in,
  the shadow lane re-runs everything. The remote cache service is
  implemented but not deployed, and no `RemoteCache` declaration exists in
  the root `BUILD.ts`.
- **Green `docs` verdicts.** DocsParity is in the `ci` verb set — the `test`
  job's step declares `Verb.Ci`, which plans the docs verb with the rest —
  but its verdicts stay red until the README backfill (factory queue item
  0007) lands.
- **A clean-slate build.** The workflow used to wipe every `dist` tree
  before building, which the target graph does not reproduce: it rebuilds
  from declared inputs instead. A stale-artifact failure would now surface as
  a `TsBuild` key that did not change when it should have.

## Remaining migration

1. The workhorse targets opt into caching with complete input contracts, so
   the lane's wall-clock earns the migration.
2. The recursive pnpm scripts stay for local use (`pnpm run check`,
   `pnpm test`), but nothing in CI calls them; they retire when the local
   entry points move to `smthrs` too.
