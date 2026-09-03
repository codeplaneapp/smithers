# Phase 7 gate: format-lint-typecheck

Verdict: PASS

This file supersedes the run recorded at `cd14388ed7` in
`migration/clean-checkout-4` (verdict PASS). That file is kept beside this one
as `format-lint-typecheck-prev-cd14388ed7.md` with its logs in
`format-lint-typecheck-logs-cd14388ed7/`; the still older runs remain in
`format-lint-typecheck-prev-163fdf4bf5.md`,
`format-lint-typecheck-logs-163fdf4bf5/`, and
`format-lint-typecheck-logs-20b32c6316/`. This run validates `341c8fa87e` in
the same `migration/clean-checkout-4`.

Every command exits 0: typecheck for all 59 workspace members with a `check`
script, dprint plus eslint for all 51 members with a `lint` script, the same
lint targets through the `PACKAGE.ts` graph (106 targets, 0 failed), the three
root generated-file drift targets (`//:ci`, `//:tsconfig`, `//:knownFiles`),
the `known-files.d.ts` regeneration idempotency check, and `test:jsdoc`.
`git status --porcelain` was empty before the first command and after every
command.

## Environment

| Item                                   | Value                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Host                                   | macOS 26.2 (build 25C56), Darwin 25.2.0, arm64, 16 cores, 64 GiB                                                                                                               |
| Date                                   | 2026-08-31 16:17 to 16:26 UTC (2026-08-31 09:17 to 09:26 PDT)                                                                                                                  |
| git                                    | 2.50.1 (Apple Git-155)                                                                                                                                                         |
| Node                                   | v24.18.0 (`/Users/williamcory/.nvm/versions/node/v24.18.0/bin/node`); rc-contract floor `>=22.19.0`, CI pins 22.19.0                                                           |
| corepack                               | 0.35.0                                                                                                                                                                         |
| pnpm                                   | 11.21.0, selected by corepack from `packageManager: pnpm@11.21.0`                                                                                                              |
| Bun                                    | 1.4.0. Not used by this gate.                                                                                                                                                  |
| typescript (resolved in the checkout)  | 6.0.3                                                                                                                                                                          |
| eslint / typescript-eslint             | 9.39.1 / 8.65.0                                                                                                                                                                |
| eslint-plugin-jsdoc / unicorn / import | 64.1.0 / 61.0.2 / 2.32.0                                                                                                                                                       |
| dprint                                 | 0.55.2 (51 per-package `dprint.json`: `indentWidth 2`, `lineWidth 120`, ASI, double quotes, no trailing commas)                                                                |
| @effect/language-service (tsc plugin)  | 0.87.1                                                                                                                                                                         |
| electrobun (`apps/ui`)                 | 2.0.1                                                                                                                                                                          |
| Free disk                              | 12 GiB after the run                                                                                                                                                           |
| Host load                              | 3.37 at task start, 6.07 at driver start, 40.72 at the end of the typecheck step, 40.06 at driver end (1-minute averages from `vm.loadavg`, recorded per step in `driver.log`) |

`SMITHERS_HOME` was unset in the shell and additionally stripped from every
pnpm, node, and smithers-build invocation with `env -u SMITHERS_HOME`.

### Concurrent load on the checkout

Sibling Phase 7 gates ran in `<clean-checkout-4>` during the window. The
top-level commands observed just before driver start (16:17:30 UTC) are in
`concurrent-processes.txt`: the docs gate's `node scripts/check-docs.mjs`, the
exports-types-sync gate's `--filter`ed `pnpm -r run build` over 40 packages
plus its own `smithers-build lint '//:knownFiles'`, a `tsc -p tsconfig.json`
in an npm-pack scratch checkout, and the source tree's long-lived
`electrobun dev` (the process that holds the Hutch lock, see the devkit
precondition). Two consequences, both recorded rather than worked around:

- The load average passed 40 while the gate's own parallel `tsc` and `eslint`
  children ran beside the siblings. The steps above 40 were the driver's own
  serial single-target steps and the tail of the recursive runs; no new
  spawn-bound suite was started above load 40. Durations stayed close to the
  quiet-host baseline (typecheck 200 s here against about 120 s at
  `163fdf4bf5` and 490 s at the heavily loaded `cd14388ed7` run; lint 178 s
  against about 120 s and 261 s).
- The concurrent filtered `pnpm run build` writes the same gitignored `dist/`
  and `tsbuildinfo` outputs that `tsc -b` writes in the typecheck step. A
  collision of that kind can only produce a spurious failure, never a
  spurious pass, and no step failed. `git status --porcelain` was empty after
  every step, so no concurrent gate touched a tracked file either.

## Checkout

`/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4`
(written as `<clean-checkout-4>` below). HEAD
`341c8fa87e2dadbe80d0f0d3258dae112a7d03d3`, `📝 docs(release): consumer
overrides note and the browser-contract list's new home`. It equals
`v1/rc0-migration` in `/Users/williamcory/smithers`. Submodule `vendor/jj` at
`47589ada70c12b3e829b5c98ab32503abad49eac`. `git status --porcelain` was empty
before the first command and after every command. Dependencies were installed
by the setup step's frozen offline install; this gate ran no install.

`git log --oneline cd14388ed7..HEAD` lists 15 commits; `git diff --stat` for
the range is 75 files, 6924 insertions, 2807 deletions. The range lands the
rc-contract D4/D5 citation widening (`f63809382b`), the refreshed release
artifacts (`0156f2458e`, `341c8fa87e`), wave 7 (`docs-served-llms`,
`cli-refuse-before-boot`), and wave 8 (`polish-2` with
`scripts/browser-contract.mjs` as the browser-safe list's new home,
`init-scaffold-launch` with the credentials-doctor model line and the
failed-launch settlement). Every file in that range typechecks and lints clean
below.

### Precondition: `apps/ui` devkit projection

`apps/ui check` is `node scripts/ensure-devkit.mjs && tsc --noEmit`.
`ensure-devkit.mjs` projects the Electrobun 2.0.1 SDK into the gitignored
`apps/ui/.hutch/devkit` (`apps/ui/.gitignore:35`) with `electrobun prepare`,
and `apps/ui/tsconfig.json` extends the projected tsconfig. `electrobun
prepare` blocks while the source tree's `electrobun dev` holds Hutch's release
locks; that process tree (PID 33164, elapsed over 8 h at 16:17 UTC, visible in
`concurrent-processes.txt`) was still alive. The setup therefore copied
`/Users/williamcory/smithers/apps/ui/.hutch/devkit` into
`<clean-checkout-4>/apps/ui/.hutch/devkit`, the same documented setup state
the `cd14388ed7` and `163fdf4bf5` runs used. `projection.json` (sha256
`6fcd6e741ade98add0fbc6d49ac0219072744a7a20444a8cd8398b45f394f571`) pins
`electrobun 2.0.1`, `macos/arm64`.

| Command (in `<clean-checkout-4>/apps/ui`)             | Exit | Result                                                                                                                                                                |
| ----------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env -u SMITHERS_HOME node scripts/ensure-devkit.mjs` | 0    | No output; `devkitIsFresh` accepts the copied projection against the installed `electrobun@2.0.1`; root `git status --porcelain` stays empty (`00-ensure-devkit.log`) |

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

| Count | Script                                                                | Members                                                                |
| ----- | --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 51    | `tsc -b tsconfig.json && tsc -p tsconfig.test.json --noEmit`          | every `packages/*` with a `check` script except `packages/build/infra` |
| 3     | `tsc --noEmit`                                                        | `apps/server`, `apps/shared`, `apps/tui`                               |
| 2     | `tsc -p tsconfig.json --noEmit`                                       | `e2e`, `examples`                                                      |
| 1     | `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit` | `apps/review`                                                          |
| 1     | `tsc -b tsconfig.json --force`                                        | `packages/build/infra`                                                 |
| 1     | `node scripts/ensure-devkit.mjs && tsc --noEmit`                      | `apps/ui`                                                              |

`lint` script variants observed in `02-pnpm-lint.log`: 50 members run
`eslint src --max-warnings=0 && dprint check`; `packages/build` runs
`eslint src infra terraform/modules/cache/service --max-warnings=0 && dprint check`.

The `PACKAGE.ts` graph is exercised as well, because rc-contract section 9 names
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

| # | Command                                                                                                                                             | Exit | Wall  | Final output lines                                                                                                                                                                                                                                                                                                                                                                       |
| - | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | `env -u SMITHERS_HOME corepack pnpm -r --no-bail --if-present run check`                                                                            | 0    | 200 s | `Scope: 63 of 64 workspace projects`; 59 `<member> check: Done` lines; zero lines other than the `check$` echo and `check: Done` per member (`01-pnpm-check.log`, 119 lines)                                                                                                                                                                                                             |
| 2 | `env -u SMITHERS_HOME corepack pnpm -r --no-bail --if-present run lint`                                                                             | 0    | 178 s | `Scope: 63 of 64 workspace projects`; 51 `<member> lint: Done` lines; one benign note, described below (`02-pnpm-lint.log`, 104 lines)                                                                                                                                                                                                                                                   |
| 3 | `env -u SMITHERS_HOME corepack pnpm exec smithers-build lint '//:ci' --ui plain`                                                                    | 0    | 6 s   | `1 targets: 0 hit, 1 ran, 0 failed, 0 skipped (62ms)`; `ok: true` (`03-smithers-build-lint-ci.log`)                                                                                                                                                                                                                                                                                      |
| 4 | `env -u SMITHERS_HOME corepack pnpm exec smithers-build lint '//:tsconfig' --ui plain`                                                              | 0    | 2 s   | `1 targets: 0 hit, 1 ran, 0 failed, 0 skipped (19ms)`; `ok: true` (`04-smithers-build-lint-tsconfig.log`)                                                                                                                                                                                                                                                                                |
| 5 | `env -u SMITHERS_HOME corepack pnpm exec smithers-build lint '//:knownFiles' --ui plain`                                                            | 0    | 4 s   | `1 targets: 0 hit, 1 ran, 0 failed, 0 skipped (1.0s)`; `ok: true` (`05-smithers-build-lint-knownFiles.log`)                                                                                                                                                                                                                                                                              |
| 6 | `env -u SMITHERS_HOME corepack pnpm exec smithers-build lint '//packages/...' --ui plain`                                                           | 0    | 60 s  | `106 targets: 0 hit, 106 ran, 0 failed, 0 skipped (55.8s)`; `ok: true`; rows: 51 `Dprint`, 51 `EsLint`, 1 `DepsLint` (`//packages/engine:dependencyPolicy`), 3 `TsBuild` (`//packages/{plan,flow,engine}:lib`, the `dependencyPolicy` deps) (`06-smithers-build-lint-packages.log`)                                                                                                      |
| 7 | `env -u SMITHERS_HOME node scripts/generate-known-files.mjs`, then `git status --short known-files.d.ts` and `git diff --quiet -- known-files.d.ts` | 0    | 1 s   | Generator exit 0. Blob before and after the rewrite: `c8e74a6dca257b199894761ad2e83830368273f3`, equal to `HEAD:known-files.d.ts`; 11450 lines before and after; line 2 reads `// The 4677 workspace files below follow the same .gitignore and host-state rules as globs.`; `git status --short` prints nothing; `git diff --quiet` exits 0 (`07-generate-known-files-idempotency.log`) |
| 8 | `env -u SMITHERS_HOME corepack pnpm run test:jsdoc`                                                                                                 | 0    | 1 s   | `tests 5`, `pass 5`, `fail 0`, `cancelled 0`, `skipped 0` (`08-pnpm-test-jsdoc.log`)                                                                                                                                                                                                                                                                                                     |
| 9 | `env -u SMITHERS_HOME corepack pnpm exec smithers-build query '//...' --ui plain`                                                                   | 0    | 1 s   | `targets[446]` (reference listing of every label the graph declares at this commit; unchanged from `cd14388ed7`) (`09-smithers-build-query.txt`)                                                                                                                                                                                                                                         |

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
is `packages/build lint: Multiple projects found, consider using a single`tsconfig`with`references`to speed up, or use`noWarnOnMultipleProjects`to
suppress this warning`. It is the typescript-eslint projectService performance
note for a package that lints three tsconfig roots, not an eslint rule
warning; the package exits 0 under `--max-warnings=0`. The same note was
recorded at `9c464343f0`, `20b32c6316`, `163fdf4bf5`, and `cd14388ed7`.

In command 6, `grep -n "failed\|error"` matches six lines: the four
`//packages/errors:{fmt,lint}` rows (the package is named `errors`), the
summary `0 failed`, and the counts block `failed: 0`. No target failed.

## What changed since the prior run

At `cd14388ed7` the same nine commands passed with `known-files.d.ts` at 11428
lines and 4667 registered files. The 15 commits since add tracked files for
wave 7 and wave 8 (`scripts/browser-contract.mjs` and its tests among them)
and regenerate the registry (`5cc98912d0`), so it now has 11450 lines and
registers 4677 files; `//:knownFiles` (command 5) and the idempotency check
(command 7) agree that the checked-in blob equals the regenerated blob.
`//:ci` and `//:tsconfig` still match their checked-in files. The package
graph gained no lint targets (106 both runs) and `query '//...'` still lists
446 labels. The gate covers every surface the range touched: `packages/cli`,
`packages/control`, `packages/agent`, and `packages/database` (wave 7 and 8
code lanes) typecheck and lint through commands 1, 2, and 6; the new and
edited `scripts/*.mjs` files are registered by commands 5 and 7; the docs and
release-artifact edits are text with no lint surface here and are validated by
the docs gate.

## Post-run tree state

`git status --porcelain` printed zero lines after every command and at driver
end. The gate wrote nothing tracked: `tsc -b` emits into gitignored `dist/`
(`.gitignore:5`), `eslint` without `--fix` and `dprint check` mutate nothing,
`smithers-build` writes only the gitignored `.flows/` cache (`.gitignore:90`),
and the one deliberate rewrite of `known-files.d.ts` reproduced the HEAD blob
byte for byte. `apps/ui/.hutch/devkit` (gitignored) remains in place for later
gates that typecheck or build `apps/ui`. HEAD is still
`341c8fa87e2dadbe80d0f0d3258dae112a7d03d3` at 16:25:40 UTC. The gate created
no pack copies or docs builds, so nothing needed removal; free disk stayed at
12 GiB.

## Raw logs

`format-lint-typecheck-logs/` beside this file: `00-ensure-devkit.log`,
`01-pnpm-check.log`, `02-pnpm-lint.log`, `03-smithers-build-lint-ci.log`,
`04-smithers-build-lint-tsconfig.log`, `05-smithers-build-lint-knownFiles.log`,
`06-smithers-build-lint-packages.log`,
`07-generate-known-files-idempotency.log`, `08-pnpm-test-jsdoc.log`,
`09-smithers-build-query.txt`, one `.exit` file per numbered command,
`driver.log`, and `concurrent-processes.txt`. The driver script is
`/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/flt-driver-2.sh`
(the `flt-driver.sh` command set split into three foreground phases so no step
outlives its shell). The superseded runs' logs are in
`format-lint-typecheck-logs-cd14388ed7/`,
`format-lint-typecheck-logs-163fdf4bf5/`, and
`format-lint-typecheck-logs-20b32c6316/`.

## Verdict

PASS. From the clean checkout at `341c8fa87e`: typecheck 59 of 59, eslint plus
dprint 51 of 51 through pnpm and 106 of 106 lint targets through the `PACKAGE.ts`
graph, `//:ci`, `//:tsconfig`, `//:knownFiles`, the `known-files.d.ts`
regeneration idempotency check, and `test:jsdoc` all exit 0 with a clean tree
after every step. No blockers remain for this gate.
