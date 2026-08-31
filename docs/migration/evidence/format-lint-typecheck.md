# Phase 7 gate: format-lint-typecheck

Verdict: PASS

This file supersedes the run recorded at `163fdf4bf5` in
`migration/clean-checkout-3` (verdict PASS). That file is kept beside this one
as `format-lint-typecheck-prev-163fdf4bf5.md` with its logs in
`format-lint-typecheck-logs-163fdf4bf5/`; the still older `20b32c6316` logs
remain in `format-lint-typecheck-logs-20b32c6316/`. This run validates
`cd14388ed7` in `migration/clean-checkout-4`.

Every command exits 0: typecheck for all 59 workspace members with a `check`
script, dprint plus eslint for all 51 members with a `lint` script, the same
lint targets through the `BUILD.ts` graph (106 targets, 0 failed), the three
root generated-file drift targets (`//:ci`, `//:tsconfig`, `//:knownFiles`),
the `known-files.d.ts` regeneration idempotency check, and `test:jsdoc`.
`git status --porcelain` was empty before the first command and after every
command.

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2 (build 25C56), Darwin 25.2.0, arm64, 16 cores, 64 GiB |
| Date | 2026-08-31 12:00 to 12:15 UTC (2026-08-31 05:00 to 05:15 PDT) |
| git | 2.50.1 (Apple Git-155) |
| Node | v24.18.0 (`/Users/williamcory/.nvm/versions/node/v24.18.0/bin/node`); rc-contract floor `>=22.19.0`, CI pins 22.19.0 |
| corepack | 0.35.0 |
| pnpm | 11.21.0, selected by corepack from `packageManager: pnpm@11.21.0` |
| Bun | 1.4.0. Not used by this gate. |
| typescript (resolved in the checkout) | 6.0.3 |
| eslint / typescript-eslint | 9.39.1 / 8.65.0 |
| eslint-plugin-jsdoc / unicorn / import | 64.1.0 / 61.0.2 / 2.32.0 |
| dprint | 0.55.2 (51 per-package `dprint.json`: `indentWidth 2`, `lineWidth 120`, ASI, double quotes, no trailing commas) |
| @effect/language-service (tsc plugin) | 0.87.1 |
| electrobun (`apps/ui`) | 2.0.1 |
| Free disk | 12 GiB after the run |
| Host load | 62.6 at driver start, 66.3 at the end of the typecheck step, 50.7 at driver end (1-minute averages from `vm.loadavg`, recorded per step in `driver.log`) |

`SMITHERS_HOME` was unset in the shell and additionally stripped from every
pnpm, node, and smithers-build invocation with `env -u SMITHERS_HOME`.

### Concurrent load on the checkout

Sibling Phase 7 gates ran in `<clean-checkout-4>` for the whole window. The
top-level commands observed at 12:02:51 UTC are captured in
`concurrent-processes.txt`: `pnpm -r --no-bail --if-present run test`, a
`--filter`ed `pnpm -r run test`, the SQLite gate's `vitest run` suites
(`run-suite.sh engine-store`), `generate-docs-pages.mjs --check`, two
`pnpm --dir packages/migrate run build`, one `pnpm run build`, a second
`smithers-build lint //:ci`, `smithers-build test //examples/... --no-cache`,
and the scans gate's fresh clone plus `pnpm install --frozen-lockfile --offline`
in the scratchpad. Two consequences, both recorded rather than worked around:

- Durations are inflated. The typecheck step took 490 s here against about
  120 s at `163fdf4bf5`, and lint 261 s against about 120 s.
- The concurrent `pnpm run build` writes the same gitignored `dist/` and
  `tsbuildinfo` outputs that `tsc -b` writes in the typecheck step. A
  collision of that kind can only produce a spurious failure, never a
  spurious pass, and no step failed. `git status --porcelain` was empty after
  every step, so no concurrent gate touched a tracked file either.

## Checkout

`/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4`
(written as `<clean-checkout-4>` below). HEAD
`cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba`, `🔧 chore(wave-6): regenerate
known-files.d.ts for the two landed lanes`, authored 2026-08-31 04:08:04 PDT.
It equals `v1/rc0-migration` in `/Users/williamcory/smithers`. Submodule
`vendor/jj` at `47589ada70c12b3e829b5c98ab32503abad49eac`. `git status
--porcelain` was empty before the first command and after every command.
Dependencies were installed by the clean-install gate (`00-clean-install.md`,
same commit, same directory); this gate ran no install.

`git log --oneline 163fdf4bf5..HEAD` lists 19 commits; `git diff --stat` for
the range is 81 files, 9588 insertions, 1413 deletions. The range lands the
wave-5 and wave-6 lanes (`cli-exit-code`, `engine-failed-persist`,
`release-hygiene`, `cli-lifecycle`), adds `packages/engine-store/src/internal/ExitEncoding.ts`
and its tests, adds `packages/cli/test/{Bin,ControlSurface}.test.ts`, widens
`scripts/BUILD.ts` by 39 lines, edits `scripts/check-npm-dedupe.mjs`, makes
vitest an optional peer of `packages/testing`, and regenerates
`known-files.d.ts` twice. Every one of those files typechecks and lints clean
below.

### Precondition: `apps/ui` devkit projection

`apps/ui check` is `node scripts/ensure-devkit.mjs && tsc --noEmit`.
`ensure-devkit.mjs` projects the Electrobun 2.0.1 SDK into the gitignored
`apps/ui/.hutch/devkit` (`apps/ui/.gitignore:35`) with `electrobun prepare`,
and `apps/ui/tsconfig.json` extends the projected tsconfig. The clean-install
evidence for this checkout records that `electrobun prepare` blocks because the
source tree's `electrobun dev` holds Hutch's release locks; that process tree
(PIDs 33164, 33196, 33202, elapsed 4 h 15 min) was still alive at 12:00 UTC.
The setup therefore copied `/Users/williamcory/smithers/apps/ui/.hutch/devkit`
(1.9 MiB) into `<clean-checkout-4>/apps/ui/.hutch/devkit`, the same setup the
`163fdf4bf5` run used. `projection.json` (sha256 `6fcd6e741ade98add0fbc6d49ac0219072744a7a20444a8cd8398b45f394f571`)
pins `electrobun 2.0.1`, `macos/arm64`, `sourceManifestSha256 e7978b03...`.

| Command (in `<clean-checkout-4>/apps/ui`) | Exit | Result |
| --- | --- | --- |
| `env -u SMITHERS_HOME node scripts/ensure-devkit.mjs` | 0 | No output; `devkitIsFresh` accepts the copied projection against the installed `electrobun@2.0.1`; root `git status --porcelain` stays empty (`00-ensure-devkit.log`) |

This is toolchain state, not repository content, and it changes no tracked
file. The source tree was read, not written.

## What the gate covers

Root `package.json`: `check` is `pnpm --recursive --if-present run check`,
`lint` is `pnpm --recursive --if-present run lint`. There is no separate root
format script: per rc-contract section 9 the formatter is dprint per package,
and every package `lint` script ends in `dprint check`. The workspace has 64
projects; `-r` recurses into 63 (the private root is excluded). `--if-present`
skips:

- No `check` script (4): `apps/bug-worker`, `apps/status-site`, `packages/ui`,
  `packages/ui-styleguide`. 63 - 4 = 59 projects typechecked.
- No `lint` script (12): `apps/bug-worker`, `apps/review`, `apps/server`,
  `apps/shared`, `apps/status-site`, `apps/tui`, `apps/ui`, `e2e`, `examples`,
  `packages/build/infra`, `packages/ui`, `packages/ui-styleguide`.
  63 - 12 = 51 projects linted.

`check` script variants observed in `01-pnpm-check.log`:

| Count | Script | Members |
| --- | --- | --- |
| 51 | `tsc -b tsconfig.json && tsc -p tsconfig.test.json --noEmit` | every `packages/*` with a `check` script except `packages/build/infra` |
| 3 | `tsc --noEmit` | `apps/server`, `apps/shared`, `apps/tui` |
| 2 | `tsc -p tsconfig.json --noEmit` | `e2e`, `examples` |
| 1 | `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit` | `apps/review` |
| 1 | `tsc -b tsconfig.json --force` | `packages/build/infra` |
| 1 | `node scripts/ensure-devkit.mjs && tsc --noEmit` | `apps/ui` |

`lint` script variants observed in `02-pnpm-lint.log`: 50 members run
`eslint src --max-warnings=0 && dprint check`; `packages/build` runs
`eslint src infra terraform/modules/cache/service --max-warnings=0 && dprint check`.

The `BUILD.ts` graph is exercised as well, because rc-contract section 9 names
it as the CI entry point: `smithers-build lint '//packages/...'` runs the
`Dprint` and `EsLint` targets `PackageDefaults` synthesizes for every package,
plus `//packages/engine:dependencyPolicy`, and the three root `lint` targets
drift-check the generated `.github/workflows/ci.yml`, `tsconfig.json`, and
`known-files.d.ts`.

## Commands and results

All commands ran from `<clean-checkout-4>` through a sequential driver
(`driver.log` records start, end, exit, wall seconds, `git status --porcelain`
line count, and `vm.loadavg` per step). Each command's stdout and stderr is in
the named log; its exit code is in the matching `.exit` file.

| # | Command | Exit | Wall | Final output lines |
| --- | --- | --- | --- | --- |
| 1 | `env -u SMITHERS_HOME corepack pnpm -r --no-bail --if-present run check` | 0 | 490 s | `Scope: 63 of 64 workspace projects`; 59 `<member> check: Done` lines; zero lines other than the `check$` echo and `check: Done` per member (`01-pnpm-check.log`, 119 lines) |
| 2 | `env -u SMITHERS_HOME corepack pnpm -r --no-bail --if-present run lint` | 0 | 261 s | `Scope: 63 of 64 workspace projects`; 51 `<member> lint: Done` lines; one benign note, described below (`02-pnpm-lint.log`, 104 lines) |
| 3 | `env -u SMITHERS_HOME corepack pnpm exec smithers-build lint '//:ci' --ui plain` | 0 | 2 s | `//:ci  ran  21ms`; `1 targets: 0 hit, 1 ran, 0 failed, 0 skipped (37ms)`; `ok: true` (`03-smithers-build-lint-ci.log`) |
| 4 | `env -u SMITHERS_HOME corepack pnpm exec smithers-build lint '//:tsconfig' --ui plain` | 0 | 2 s | `//:tsconfig  ran  18ms`; `1 targets: 0 hit, 1 ran, 0 failed, 0 skipped (22ms)`; `ok: true` (`04-smithers-build-lint-tsconfig.log`) |
| 5 | `env -u SMITHERS_HOME corepack pnpm exec smithers-build lint '//:knownFiles' --ui plain` | 0 | 2 s | `//:knownFiles  ran  709ms`; `1 targets: 0 hit, 1 ran, 0 failed, 0 skipped (710ms)`; `ok: true` (`05-smithers-build-lint-knownFiles.log`) |
| 6 | `env -u SMITHERS_HOME corepack pnpm exec smithers-build lint '//packages/...' --ui plain` | 0 | 47 s | `106 targets: 0 hit, 106 ran, 0 failed, 0 skipped (44.5s)`; `ok: true`; rows: 51 `Dprint`, 51 `EsLint`, 1 `DepsLint` (`//packages/engine:dependencyPolicy`), 3 `TsBuild` (`//packages/{plan,flow,engine}:lib`, the `dependencyPolicy` deps) (`06-smithers-build-lint-packages.log`) |
| 7 | `env -u SMITHERS_HOME node scripts/generate-known-files.mjs`, then `git status --short known-files.d.ts` and `git diff --quiet -- known-files.d.ts` | 0 | 1 s | Generator exit 0. Blob before and after the rewrite: `4d81799c6fe6c93a50d011de790f690707368272`, equal to `HEAD:known-files.d.ts`; 11428 lines before and after; line 2 reads `// The 4667 workspace files below follow the same .gitignore and host-state rules as globs.`; `git status --short` prints nothing; `git diff --quiet` exits 0 (`07-generate-known-files-idempotency.log`) |
| 8 | `env -u SMITHERS_HOME corepack pnpm run test:jsdoc` | 0 | 1 s | `tests 5`, `suites 0`, `pass 5`, `fail 0`, `cancelled 0`, `skipped 0` (`08-pnpm-test-jsdoc.log`) |
| 9 | `env -u SMITHERS_HOME corepack pnpm exec smithers-build query '//...' --ui plain` | 0 | 2 s | `targets[446]` (reference listing of every label the graph declares at this commit; 444 at `163fdf4bf5`, the range widened `scripts/BUILD.ts`) (`09-smithers-build-query.txt`) |

Typechecked (59): apps/review apps/server apps/shared apps/tui apps/ui e2e
examples packages/agent packages/artifacts packages/build packages/build-cli
packages/build/infra packages/canonical packages/capability packages/chain
packages/cli packages/control packages/core packages/create-app packages/crypto
packages/database packages/engine packages/engine-store packages/errors
packages/evals packages/flow packages/flows packages/fs packages/gateway
packages/harness packages/integrations packages/jj packages/journal
packages/kernel packages/keys packages/mcp packages/memory packages/migrate
packages/model packages/notifications packages/observability packages/patterns
packages/plan packages/platform-browser packages/platform-bun
packages/platform-node packages/plugin packages/registry packages/run-store
packages/sandbox packages/scorers packages/smthrs-deprecation packages/std
packages/step-cache packages/sync packages/targets packages/testing
packages/time-travel packages/triggers.

Linted (51): every `packages/*` directory above except `packages/build/infra`,
`packages/ui`, `packages/ui-styleguide`.

The one line in command 2 that is neither a `lint$` echo nor a `lint: Done`
is `packages/build lint: Multiple projects found, consider using a single
`tsconfig` with `references` to speed up, or use `noWarnOnMultipleProjects` to
suppress this warning`. It is the typescript-eslint projectService performance
note for a package that lints three tsconfig roots, not an eslint rule
warning; the package exits 0 under `--max-warnings=0`. The same note was
recorded at `9c464343f0`, `20b32c6316`, and `163fdf4bf5`.

In command 6, `grep -n "failed\|error"` matches six lines: the four
`//packages/errors:{fmt,lint}` rows (the package is named `errors`), the
summary `0 failed`, and the counts block `failed: 0`. No target failed.

## What changed since the prior run

At `163fdf4bf5` the same nine commands passed with `known-files.d.ts` at 11398
lines and 4653 registered files. The 19 commits since add 14 net tracked files
and regenerate the registry (`5ac7610b5c`, `0fa6148b4b`, `d7c5a3e503`,
`cd14388ed7`), so it now has 11428 lines and registers 4667 files; `//:knownFiles`
(command 5) and the idempotency check (command 7) agree that the checked-in
blob equals the regenerated blob. `//:ci` and `//:tsconfig` still match their
checked-in files. The package graph gained no lint targets (106 both runs);
`query '//...'` grew from 444 to 446 labels through `scripts/BUILD.ts`.

## Post-run tree state

`git status --porcelain` printed zero lines after every command and at driver
end. The gate wrote nothing tracked: `tsc -b` emits into gitignored `dist/`
(`.gitignore:5`), `eslint` without `--fix` and `dprint check` mutate nothing,
`smithers-build` writes only the gitignored `.flows/` cache (`.gitignore:90`),
and the one deliberate rewrite of `known-files.d.ts` reproduced the HEAD blob
byte for byte. `apps/ui/.hutch/devkit` (gitignored) remains in place for later
gates that typecheck or build `apps/ui`. HEAD is still
`cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba` at 12:14:47 UTC.

## Raw logs

`format-lint-typecheck-logs/` beside this file: `00-ensure-devkit.log`,
`01-pnpm-check.log`, `02-pnpm-lint.log`, `03-smithers-build-lint-ci.log`,
`04-smithers-build-lint-tsconfig.log`, `05-smithers-build-lint-knownFiles.log`,
`06-smithers-build-lint-packages.log`,
`07-generate-known-files-idempotency.log`, `08-pnpm-test-jsdoc.log`,
`09-smithers-build-query.txt`, one `.exit` file per numbered command,
`driver.log`, and `concurrent-processes.txt`. The driver script is
`/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/flt-driver.sh`.
The superseded runs' logs are in `format-lint-typecheck-logs-163fdf4bf5/` and
`format-lint-typecheck-logs-20b32c6316/`.

## Verdict

PASS. From the clean checkout at `cd14388ed7`: typecheck 59 of 59, eslint plus
dprint 51 of 51 through pnpm and 106 of 106 lint targets through the `BUILD.ts`
graph, `//:ci`, `//:tsconfig`, `//:knownFiles`, the `known-files.d.ts`
regeneration idempotency check, and `test:jsdoc` all exit 0 with a clean tree
after every step. No blockers remain for this gate.
