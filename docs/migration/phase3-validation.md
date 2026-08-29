# Phase 3 validation: the 1.0.0-rc.0 package and release contract

Scope: PLAN.md Phase 3, executed against `docs/migration/rc-contract.md`
sections 3 and 9. Everything below was run in this working tree on 2026-08-29
at Node 24.18.0, Bun 1.4.0, pnpm 11.21.0. Commands are repository-root relative.

## 1. What the release now is

| Fact | Value | Where it is enforced |
| --- | --- | --- |
| Published packages | 40 | `scripts/pack-release.mjs` `publishedPackages`, checked against the workspace on every read |
| Version | `1.0.0-rc.0`, one synchronized version | `node scripts/set-release-version.mjs --check 1.0.0-rc.0` |
| Release train | `smthrs.group` in `{engine, agent}`, `private !== true` | `scripts/pack-release.mjs` `releaseGroups`, `.github/workflows/release.yml` |
| Dist-tag | `rc` for any version containing `-`, never `latest` | `publishConfig.tag` in every public manifest, `publish_tag` in `release.yml`, `scripts/pack-release.test.mjs` |
| User-facing binary | `smithers`, from `@smthrs/cli` | `packages/cli/package.json` `bin`, `packages/cli/test/Bin.test.ts` |
| Build binary | `smithers-build`, from the private `@smthrs/build-cli` | `packages/build-cli/package.json` `bin`, generated `.github/workflows/ci.yml` |
| Unscoped `smthrs` | Migration notice that throws on import | `packages/smthrs-deprecation`, `scripts/smoke-release.mjs` |

## 2. Version and dependency coherence

`node scripts/set-release-version.mjs 1.0.0-rc.0` rewrote 48 of 57 workspace
manifests. `--check` now reports `58 workspace manifests and 1 versioned source
are at 1.0.0-rc.0`. The 58th manifest is `packages/smthrs-deprecation`, created
later in this change (section 5); the versioned source is section 8's
`Otlp.defaultServiceVersion`.

**The private-to-private exact-edge trap.** `retarget()` keeps `version` on a
`private: true` manifest but rewrites every exact range that names a workspace
package. Bumping without preparation therefore leaves a range pointing at a
version no private package carries, and with `linkWorkspacePackages: true` pnpm
falls through to the registry and fails. Phase 3 switched every edge whose
target is private to `workspace:*` before the bump:

| Manifest | Edge | Was | Now |
| --- | --- | --- | --- |
| `packages/build-cli` | `@smthrs/build`, `@smthrs/create-app`, `@smthrs/targets` | `0.1.0` | `workspace:*` |
| `packages/targets` | `@smthrs/build` | `0.1.0` | `workspace:*` |
| `packages/create-app` | `@smthrs/targets` | `0.1.0` | `workspace:*` |
| `packages/evals` | `@smthrs/scorers` | `0.1.0` | `workspace:*` |
| `apps/ui` | `@smthrs/ui` | registry `0.33.0` | `workspace:*` (decision D14) |
| root `package.json` | `@smthrs/build-cli`, `@smthrs/targets` | `0.1.0` | `workspace:*` |

The root manifest is outside pnpm's workspace patterns, so
`set-release-version.mjs` never sees it; its edges were fixed by hand in the
same pass. An independent sweep over all 58 manifests plus the root found no
exact internal range whose target declares a different version.

**The D14 swap needed one more edit than the manifest edge.**
`phase2-baseline.md` section 5 measured the swap breaking `apps/ui`'s unit suite
(1084 passing to 90 failures and 23 errors) and deferred it to the Phase 4 UI
port, reading the failures as the `0.33.0`-to-`0.35.0` behavioral delta in
`packages/ui/src`. They were a duplicated React instead. `apps/ui` pins `react`
at exactly `19.2.7`; `packages/ui` declared `^19.2.7`, which resolves to
`19.2.8`. A registry tarball takes React from the consumer through
`peerDependencies`, but `workspace:*` links `packages/ui/src` directly and its
own `node_modules/react` then wins for every module under it. The failures are
all one shape: `Invalid hook call` raised from `packages/ui/src/styles.tsx`
`useInjectUiCss`, so every component that injects styles renders nothing.

`apps/ui`, `apps/tui`, and `packages/create-app` all pin `19.2.7` already, so
the fix is to pin `packages/ui`'s `react` and `react-dom` devDependencies to
the same version. That deduplicates React and makes the swap green with no UI
port: `bun test src` in `apps/ui` is 1084 tests, 0 fail, 0 errors, and
`//scripts:releaseVersion` passes. The root manifest keeps `^19.2.8` for the
vocs docs build, which is in no app's resolution path. `packages/ui`'s own suite
(904 tests) and `packages/ui-styleguide`'s (53) stay green. Both lockfiles were
regenerated for the pin. `phase2-baseline.md` section 5 records the correction.

`@smthrs/ui` and `@smthrs/ui-styleguide` are private and carry `1.0.0-rc.0`
anyway, as rc-contract section 3.2 requires. Every other private package keeps
`0.1.0`; nothing depends on those versions any more.

## 3. Public and private split

Public (39, all `publishConfig.access: "public"`, `provenance: true`,
`tag: "rc"`): the unscoped `smthrs` notice, plus these 38 under the `@smthrs`
scope: `agent`, `artifacts`, `canonical`, `capability`, `cli`, `control`,
`core`, `crypto`, `database`, `engine`, `engine-store`, `flow`, `flows`,
`gateway`, `harness`, `jj`, `journal`, `kernel`, `keys`, `mcp`, `memory`,
`model`, `notifications`, `observability`, `patterns`, `plan`,
`platform-browser`, `platform-bun`, `platform-node`, `plugin`, `registry`,
`run-store`, `sandbox`, `std`, `step-cache`, `sync`, `testing`, `time-travel`.
`node scripts/pack-release.mjs --names` prints the authoritative list.

Newly `private: true` in this change: `@smthrs/build`, `@smthrs/chain`,
`@smthrs/create-app`, `@smthrs/evals`, `@smthrs/fs`, `@smthrs/scorers`,
`@smthrs/triggers`, `@smthrs/ui`, `@smthrs/ui-styleguide`. Already private:
`@smthrs/build-cli`, `@smthrs/targets`, `@smthrs/build-infra`, every app, and
`@smthrs/examples`.

`@smthrs/create-app` is not in the section 3.1 roster because it arrived with
the `b8af974334` import catch-up, after the contract was frozen. Its only
consumer is the private build CLI, so rule (d) makes it private. The contract's
section 3.2 table now records it.

`scripts/pack-release.mjs` refuses to pack when the non-private
`{engine, agent}` set differs from the 39 names, so a package cannot join or
leave the release by flipping a flag alone.

## 4. Binaries

`packages/cli` declares `{"smithers": "./bin/smithers.mjs"}`. The imported
`flows` bin is gone. `Command.make("smithers")` was already in place from the
Phase 2 rename lane.

`packages/cli/bin/smithers.mjs` is a `#!/usr/bin/env node` shim:

- it imports `../dist/esm/bin.js` when that file exists, which is the packaged
  install path and what every tarball ships;
- otherwise it imports `../src/bin.ts`, which Node strips types from directly
  (the package requires Node >= 22.19.0, and `erasableSyntaxOnly` is on), so a
  source checkout runs the code under edit with no build step.

The shebang pins Node on every installer path, including
`bun x --package @smthrs/cli smithers`, because the durable engine does not
support Bun (rc-contract section 1). The shim silences only the Node
type-stripping `ExperimentalWarning`, so a development invocation is not
prefixed with a paragraph of warning text.

`scripts/check-local-smithers.mjs` `SOURCE_ENTRY` now names
`packages/cli/bin/smithers.mjs`; `node scripts/check-local-smithers.mjs` and
its `node --test` suite both pass.

Working-tree execution, verified:

```
$ corepack pnpm exec smithers --version
smithers v1.0.0-rc.0
$ corepack pnpm exec smithers --help
DESCRIPTION
  Plan, approve, and run durable flows
USAGE
  smithers <subcommand> [flags]
```

The root manifest gained `"@smthrs/cli": "workspace:*"` so pnpm links the bin.

`packages/build-cli` renamed its bin from `smthrs` to `smithers-build`. The
rename reached `Cli.create`, the generated GitHub workflow and setup-action
headers, the generated git-hook scripts, `packages/targets`
`GithubCiGen.stepCommand` and `PackageJson`, their tests and goldens,
`apps/ui`'s CI-matrix parser (which now accepts `smithers-build`, `smthrs`, and
`smithers`, because it reads other repositories' workflows), the `packages/build`
documentation set (33 files; every command invocation and every prose mention of
the binary), `CLAUDE.md`, `CONTRIBUTING.md`, and the `evals` and `crates`
BUILD files. Three names deliberately keep the old spelling: the `@smthrs/*`
package scope, the `{smthrs:cache-directory}` plan token, and the `smthrs: `
prefix `packages/build-cli`'s reporter still writes on its own log lines
(section 12, follow-up 3). So does `smthrs-shadow` in
`packages/build/docs/workspace/flows-repo-adoption.md`, which names a CI job
that was deleted upstream on 2026-08-19 and never existed under another name. `.github/workflows/ci.yml` was regenerated with
`smithers-build build '//:ci'` and drift-checks clean.

`packages/create-app` renamed its `smthrs-routes` bin to `smithers-routes`, so
no bin in the tree carries the deprecated unscoped name. The package is
private, so the bin never publishes.

Every declared bin in the workspace, after the change:

```
packages/build-cli/package.json:  {"smithers-build": "./src/main.js"}
packages/cli/package.json:        {"smithers": "./bin/smithers.mjs"}
packages/create-app/package.json: {"smithers-routes": "./bin/routes.mjs"}
```

## 5. The unscoped `smthrs` package

`packages/smthrs-deprecation` publishes as `smthrs@1.0.0-rc.0`: `smthrs.group`
`agent`, `private` absent, no `bin`, `exports` `"."` only, `publishConfig`
`access: public`, `provenance: true`, `tag: "rc"`. Its single module throws the
rc-contract section 3.3 notice on import. Its README carries the same text, the
migration guide link, and the removed-API table.

The directory is named `smthrs-deprecation` rather than `smthrs` so a path
under `packages/` does not read as `@smthrs/smthrs`. The published name is
unchanged. `rc-contract.md` section 3.3 and both halves of the disposition
ledger record the same directory.

The package is inside every conformance cell in
`packages/flows/test/vitestCoverageIsolation.test.ts` except the export-shape
cell, which is carved out by name because sections 3.3 and 3.5 pin its export
map to `.` with no wildcard. It ships a vitest config with the pinned
tmpdir-scoped report directory, `scripts.test: "vitest"`, and a 100% coverage
gate that its two behavior tests meet.

`scripts/smoke-release.mjs` treats a successful load of `smthrs` as the
failure, so the release workflow checks the notice rather than a human reading
the output.

## 6. Gate results

| Gate | Command | Result |
| --- | --- | --- |
| Script target graph | `corepack pnpm exec smithers-build test '//scripts/...'` | 12 targets, 0 failed |
| Release version coherence | `node --test scripts/set-release-version.test.mjs` | 10 pass (4 new: the versioned-source rewrite, its missing-declaration refusal, its drift report, and every versioned source against its own package's version) |
| Release manifest | `node --test scripts/pack-release.test.mjs` | 12 pass (3 new: the 39-name roster, the RC version and `rc` tag on every packed manifest, the widened group set) |
| Test-pin register | `node scripts/check-test-pins.mjs` | clean, register widened to every group |
| Working-tree CLI | `node --test scripts/check-local-smithers.test.mjs` | 20 pass |
| Single Effect version | `node scripts/check-single-effect-version.mjs` | `effect@4.0.0-rc.108` everywhere (58 sources) |
| Dependency boundaries | `node scripts/check-dependency-boundaries.mjs` | 59 packages pass |
| Browser contract | `node scripts/browser-check.mjs` | 28 browser entry points, 7 Node-only |
| Generated CI workflow | `corepack pnpm exec smithers-build lint '//:ci'` | no drift |
| Generated tsconfig | `corepack pnpm exec smithers-build lint '//:tsconfig'` | no drift |
| Disposition ledger | `node docs/migration/check-disposition-ledger.mjs` | 492 rows ok |
| Release pack | `node scripts/pack-release.mjs <dir>` | 39 tarballs in dependency order |
| Release smoke | `node scripts/smoke-release.mjs <dir>` | 39 tarballs install, import, and typecheck |
| Whole workspace test | `corepack pnpm --recursive --if-present --no-bail run test` | `Summary: 2 fails, 56 passes`. The two are the environmental packages `phase2-baseline.md` section 2.1 names, and nothing else: `examples` (one live-OpenAI test) and `packages/build-cli` (three Docker tests) |
| `apps/ui` unit suite | `bun test src` in `apps/ui` | 1084 tests, 0 fail, 0 errors, 134 files |
| `apps/ui` typecheck | `corepack pnpm -C apps/ui run check` | exit 0 |
| `packages/observability` | `corepack pnpm -C packages/observability run test` | 28 tests, 9 files, coverage gate at 100% |
| `packages/ui` / `packages/ui-styleguide` | `bun test tests` | 904 and 53 tests, 0 fail |
| Workspace typecheck | `corepack pnpm --recursive --if-present --no-bail run check` | 54 workspaces, exit 0 |
| Workspace lint | `corepack pnpm --recursive --if-present --no-bail run lint` | exit 0 |
| Circular dependencies | `corepack pnpm --recursive --if-present --no-bail run circular` | exit 0 |
| JSDoc rule harness | `corepack pnpm run test:jsdoc` | 5 pass |

Both lockfiles were refreshed in this change and both verify frozen:

```
$ corepack pnpm install            # then
$ corepack pnpm install --frozen-lockfile --offline          # Already up to date
$ bun install --lockfile-only      # then
$ bun install --frozen-lockfile --offline --lockfile-only    # Saved bun.lock (2172 packages)
```

`bun.lock` holds 2172 packages, against `phase2-baseline.md`'s 2174. The
difference is this change's manifest edits, not a dropped dependency.

Review pass, 2026-08-29. Two findings were fixed after the table above was
written: the `LICENSE` rewrite was reverted to the ruling R-26 wording
(`phase2-baseline.md` section 6) and contract section 9's `jsx` row was amended
(section 11). Both touch packed files or prose, so the gates that read them were
rerun: `pack-release.mjs` (39 tarballs), `smoke-release.mjs` (39 install, import,
and typecheck on Node 24.18.0), `smithers-build test '//scripts/...'` (12
targets, 0 failed), `check-disposition-ledger.mjs` (492 rows), and
`check-dependency-boundaries.mjs` (59 packages). Every result matches its row
above. The packed `LICENSE` files were read back out of the tarballs: 37 carry
the R-26 line, 2 carry the import's variant (section 7).

## 7. Export resolution, Node and Bun

79 specifiers were resolved from a throwaway project outside the repository
that installs all 39 tarballs: every published root entry plus every named
subpath in rc-contract section 3.5 and the published test helpers. Each was
loaded with `node --input-type=module --eval 'await import(...)'` and with
`bun --eval 'await import(...)'`.

Result: 78 of 79 load under both runtimes. The one failure under both is
`smthrs`, which throws the migration notice by design. `@smthrs/flows/NodeRuntime`,
`@smthrs/database/node/NodeDatabase`, `@smthrs/jj/node/NodeJj`,
`@smthrs/jj/bun/BunJj`, `@smthrs/platform-node`, and `@smthrs/platform-bun` all
load under Bun as well as Node; those entries are Node-only for browser
bundling, which is a separate claim that `scripts/browser-check.mjs` holds.

`scripts/smoke-release.mjs` additionally requires every package as CJS and
typechecks `import * as Flows from "@smthrs/flows"` plus
`@smthrs/kernel/test/contract` under `--module NodeNext`.

`npm pack --dry-run` on all 39 source manifests produced the intended file
lists: `bin/smithers.mjs` in `@smthrs/cli`, `wasm/flows_jj.wasm` plus
`THIRD_PARTY_NOTICES.md` in `@smthrs/jj`, `Migrations` modules in
`@smthrs/database`, `@smthrs/journal`, `@smthrs/run-store` and
`@smthrs/step-cache`, and `LICENSE` in every tarball. Sizes range from 12 kB
(`smthrs`) to 5.1 MB (`@smthrs/jj`, which carries the wasm). 37 of the 39
`LICENSE` files are byte-identical and carry the ruling R-26 line
`Copyright (c) 2026 William Cory and the Smithers Flows contributors`;
`@smthrs/canonical` and `@smthrs/observability` ship the import's shorter
`Copyright (c) Smithers` variant, which is a maintainer question, not a
migration edit (section 12).

No published source imports a path outside its own package root: a sweep of
every `from "../..."` specifier in the 39 packages' `src` trees resolved every
one inside its own package. `scripts/check-dependency-boundaries.mjs` covers
the same rule from the manifest side.

No publishable manifest or README contains `"0.1.0"`, `0.35.0`, an old Effect
beta pin, `smithers-orchestrator`, or `@smthrs/{graph,scheduler,driver,react-reconciler,components}`.
The one `0.35.0` in the tree's published prose is the deliberate sentence in
the `smthrs` README that says `smthrs@0.35.0` keeps the `latest` dist-tag.

## 8. Defects found and fixed while validating

**`@smthrs/mcp` had no root entry.** Its manifest maps `exports["."]` to
`./src/index.ts`, and that file did not exist, so `import "@smthrs/mcp"` failed
in every consumer while the subpaths `@smthrs/mcp/McpClient` and
`@smthrs/mcp/McpFlows` (the two `@smthrs/cli` uses) worked. The release smoke
caught it. Fixed by adding the barrel and a test that pins its namespace set.
The conformance suite asserts the manifest's export map, not that the file it
names exists, which is why nothing saw this before the package went public.

**`require("@smthrs/testing")` could never succeed.** The root barrel
re-exported `Vitest.ts`, and vitest's CJS entry throws by design
("Vitest cannot be imported in a CommonJS module using require()"). Every CJS
consumer of the assertion helpers would have hit that. Fixed by dropping
`Vitest` from the barrel; it stays public at its own subpath
`@smthrs/testing/Vitest`, which is ESM-only because vitest is. No in-repo
consumer imported it through the barrel.

**`pack-release.mjs` accumulated stale tarballs.** It created its output
directory but never cleared it, so a local `dist/release-packs` ended up
holding both `0.1.0` and `1.0.0-rc.0` tarballs and `smoke-release.mjs` refused
the set. CI packs into a fresh `runner.temp`, so it only bit locally. The pack
now removes existing `*.tgz` and `manifest.json` first.

**`Otlp.defaultServiceVersion` did not move with the manifests.**
`packages/observability/src/Otlp.ts` writes the release version into the source
as a literal, because a published package cannot read its own `package.json` on
every runtime it supports. The version bump rewrote the manifest and left the
literal at `0.1.0`, so `@smthrs/observability` would have reported
`service.version 0.1.0` on every rc.0 OTLP export. The package's own test
already pinned the constant to the manifest, so the suite was red; the first
sweep of section 6's gates missed it because it reran named packages rather than
the whole workspace.

Fixed in two parts. The constant is `1.0.0-rc.0`, and the wire assertion in
`test/Otlp.test.ts` now compares against `Otlp.defaultServiceName` and
`Otlp.defaultServiceVersion` rather than repeating their values, so only one
place in the package carries the literal. `scripts/set-release-version.mjs`
gained a `versionedSources` table naming that declaration: the bump rewrites it
with the manifests, `--check` reports it as drift, and `retargetSource` throws
rather than passing silently if the declaration is ever renamed. A future bump
therefore cannot leave it behind, and adding another such literal is one row.

**Two undocumented test pins surfaced** when the pin register widened to the
`agent` group: `@smthrs/harness`'s `workerd smoke`
(`FLOWS_WORKERD_SMOKE`-gated) and a `.skip` inside
`packages/create-app/template/aomi`, which is scaffolding rather than a suite
this repository runs. Both are now in the `docs/alpha-notes.md` register with
what breaks if they regress and how to run them.

## 9. Known failures, not fixed here

**`node scripts/check-npm-dedupe.mjs` fails on duplicated Effect.** The gate
resolves the release set with npm's own arborist and reports
`effect resolves to 39 copies at 4.0.0-rc.108, 4.0.0-rc.112`. The cause is a
pin-versus-caret conflict, not a version literal: every Smithers manifest
depends on `effect` at exact `4.0.0-rc.108`, while `@effect/platform-node`,
`@effect/sql-sqlite-node`, and `@effect/opentelemetry` peer-depend on
`effect@^4.0.0-rc.108`, which npm hoists to the newest matching release
(`4.0.0-rc.112`) and then nests our exact copy under each package. Two Effect
instances do not share schema internals, so this is a correctness defect for an
npm consumer, not a size problem.

`docs/migration/phase2-baseline.md` predicted that "Phase 3's version rewrite
fixes" this. That prediction was wrong: the duplication does not depend on
which version the Smithers packages carry. Closing it requires a decision the
contract owns, because either fix changes rc-contract section 9's Effect row:
move `effect` from `dependencies` to `peerDependencies` in the published
manifests, or relax the exact pin to `^4.0.0-rc.108`. pnpm consumers are
unaffected, and the workspace gate
(`scripts/check-single-effect-version.mjs`) is green.

**`corepack pnpm exec smithers-build lint '//:knownFiles'` fails.** Pre-existing
and recorded in `phase2-baseline.md` section 5: the target disagrees with
`node scripts/generate-known-files.mjs`, which is idempotent and current
(re-running it after this change produces no further diff). No CI lane runs
that target.

**Three `packages/build-cli` Docker tests fail locally.** Pre-existing, recorded
in `phase2-baseline.md`: `//packages/build-cli:test` needs Docker.

## 10. Prerelease publishing rule

Every public manifest carries `publishConfig.tag: "rc"`. `release.yml` resolves
`publish_tag="rc"` for any version containing `-` and passes it to
`pnpm publish --tag`. A prerelease never takes `latest`, so `npm install smthrs`
and every range tracking `latest` keeps resolving the Smithers 0.x line until
`1.0.0` is final.

The rule lives in four places, and they must agree:

1. `publishConfig.tag` in each of the 39 public manifests.
2. The `publish_tag` case in `.github/workflows/release.yml`.
3. The `--tag "$PUBLISH_DIST_TAG"` argument on the `pnpm publish` line.
4. `docs/release-runbook.md`, which is the maintainer's publish recipe.

`scripts/pack-release.test.mjs` asserts the manifest half on every run, and the
release workflow prints the resolved dist-tag in its publish plan on both the
dry-run and the real path. `rc-contract.md` section 3.3 records the ruling
(R-40) that replaced the imported repository's `next` tag with `rc`.

## 11. Deviations from the frozen contract

| Item | Contract said | This change did | Why |
| --- | --- | --- | --- |
| Prerelease dist-tag | `next` (sections 3.3, 9) | `rc` | The orchestrator's Phase 3 brief specifies `rc`. `rc` names what the version already says and leaves `next` free for a later track. Recorded in the contract as ruling R-40 and in the release runbook. |
| Notice package directory | `packages/smthrs` (section 3.3, ledger) | `packages/smthrs-deprecation` | The Phase 3 brief names this directory. A `packages/smthrs` path reads as `@smthrs/smthrs`. The published name, group, exports, and behavior are unchanged. Contract and both ledger halves updated. |
| `@smthrs/create-app` | absent from sections 3.1 and 3.2 | `private: true` | The package arrived after the contract was frozen. Rule (d) applies: its only consumer is the private build CLI. Contract section 3.2 now lists it. |
| `smthrs-routes` bin | not mentioned | renamed `smithers-routes` | Decision D7 requires resolving `smthrs` bin names before packing; leaving one behind contradicts the notice package's own message. The package is private, so nothing publishes either name. |
| Contract section 9 `jsx` claim | "No `jsx` setting anywhere in the tree except `apps/ui` (`react-jsx`) and `apps/tui`" | Amended the row to name `packages/ui` and the two `packages/create-app` templates as well | The claim was false at the import reference, not made false by this change: `packages/ui/tsconfig.json:8-9` sets `jsx: react-jsx` and `jsxImportSource: react`, and both template tsconfigs set `jsx`. The invariant the row exists to protect holds and section 11 still enforces it: no `jsxImportSource: smthrs` and no `smthrs/jsx-runtime` or `smthrs/jsx-dev-runtime` outside `legacy/`. |

## 12. Follow-ups for later phases

1. Decide the Effect dependency shape for npm consumers (section 9). This is
   the one blocking release defect Phase 3 found and did not fix.
2. `docs/pages/create-app.md` documents `smithers-build create-app`, a verb of a
   now-private CLI. The Phase 4 docs lane decides whether the page stays.
3. `packages/build-cli` still prefixes its own log lines with `smthrs: `
   (`Reporter.ts` parses that prefix). Cosmetic, and out of Phase 3's scope.
4. The `//:knownFiles` target quirk still needs the build-system owner.
5. `@smthrs/testing/Vitest` is ESM-only. Say so in the Phase 4 testing docs.
6. Ledger row `packages/ui/src/status.ts` still assigns the status-vocabulary
   rewrite to Phase 4. The D14 swap no longer waits on it (section 2), but the
   two retained 0.x kits and their conformance carve-outs
   (`phase2-baseline.md` sections 2.3 and 3) still go with that port.
7. `docs/pages/telemetry.md` and `Otlp.defaultServiceName` still say `flows`
   where the product is Smithers. Changing the default `service.name` is a
   behavior change for anyone already scraping it, so it belongs to the Phase 4
   docs and observability lane, not to a rename sweep.
8. The `LICENSE` copyright line is one open maintainer decision with three
   parts: whether to widen the year to `2025-2026` so the claim covers the
   retained 0.x sources, whether to drop `Flows` from
   `William Cory and the Smithers Flows contributors` now that the repository is
   `smithersai/smithers`, and whether to normalize `packages/canonical` and
   `packages/observability`, which arrived from the import with
   `Copyright (c) Smithers`. Ruling R-26 freezes the current wording as
   owner-confirmed (2026-08-17), so all three need a superseding ruling recorded
   in `rc-contract.md` and the ledger `LICENSE` row. A published version is
   immutable, so the decision is cheapest before the first `rc` publish.
   `phase2-baseline.md` section 6 records the reverted rewrite that raised it.
