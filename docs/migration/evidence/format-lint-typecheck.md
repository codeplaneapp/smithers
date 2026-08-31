# Phase 7 gate: format-lint-typecheck

Verdict: PASS

This file supersedes the run recorded at `20b32c6316` in
`migration/clean-checkout-2` (verdict FAIL, cause: stale `known-files.d.ts`).
Its logs are preserved in `format-lint-typecheck-logs-20b32c6316/` beside this
file. This run validates `163fdf4bf5` in `migration/clean-checkout-3`.

Every command exits 0: typecheck for all 59 workspace members with a `check`
script, dprint plus eslint for all 51 members with a `lint` script, the same
103 package lint targets through the `BUILD.ts` graph, the three root
generated-file drift targets (`//:ci`, `//:tsconfig`, `//:knownFiles`), the
`known-files.d.ts` regeneration idempotency check, and `test:jsdoc`. The single
failure of the prior run, `//:knownFiles`, is closed by commit `163fdf4bf5`,
whose only change is the regenerated `known-files.d.ts` (42 insertions, 10
deletions, the diff the prior evidence predicted).

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2 (build 25C56), Darwin 25.2.0, arm64, 16 cores, 64 GiB |
| Date | 2026-08-31 07:25 to 07:33 UTC (2026-08-31 00:25 to 00:33 PDT) |
| git | 2.50.1 (Apple Git-155) |
| Node | v24.18.0 (`/Users/williamcory/.nvm/versions/node/v24.18.0/bin/node`); rc-contract floor `>=22.19.0` |
| corepack | 0.35.0 |
| pnpm | 11.21.0, selected by corepack from `packageManager: pnpm@11.21.0` |
| Bun | 1.4.0. Not used by this gate. |
| typescript (resolved in the checkout) | 6.0.3 |
| eslint / typescript-eslint | 9.39.1 / 8.65.0 |
| dprint | 0.55.2 |
| @effect/language-service (tsc plugin) | 0.87.1 |
| electrobun (`apps/ui`) | 2.0.1 |
| Host load | 19.2 at start, 4.3 to 21.6 during the run; another Phase 7 gate ran `pnpm -r run test` in `clean-checkout-2` for the whole window. No process had `clean-checkout-3` as its cwd or in its command line. |

`SMITHERS_HOME` was unset in the shell and additionally stripped from every
pnpm, node, and smithers-build invocation with `env -u SMITHERS_HOME`.

## Checkout

`/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-3`
(written as `<clean-checkout-3>` below). HEAD
`163fdf4bf55bb86984a0b3cf9ddf4b0d7e836c5c`, `chore(build): regenerate
known-files.d.ts for the files the UI commit added`, authored 2026-08-31
00:11:52 PDT. It equals HEAD in `/Users/williamcory/smithers`.
`git diff --stat 20b32c6316 HEAD` is `known-files.d.ts | 52 +++---` (42
insertions, 10 deletions), so the only delta from the previously validated
commit is the regenerated registry. Submodule `vendor/jj` at
`47589ada70c12b3e829b5c98ab32503abad49eac`. `git status --porcelain` was empty
before the first command and after every command. Dependencies were installed
by the clean-install gate; this gate ran no install.

### Precondition: `apps/ui` devkit projection

`apps/ui check` is `node scripts/ensure-devkit.mjs && tsc --noEmit`.
`ensure-devkit.mjs` projects the Electrobun 2.0.1 SDK into the gitignored
`apps/ui/.hutch/devkit` with `electrobun prepare`, and `apps/ui/tsconfig.json`
extends the projected tsconfig. `electrobun prepare` blocks in this checkout
because a Hutch lock is held by an `electrobun dev` session in the maintainer
tree. The setup for `<clean-checkout-3>` therefore copied
`/Users/williamcory/smithers/apps/ui/.hutch/devkit` into
`<clean-checkout-3>/apps/ui/.hutch/devkit` (electrobun 2.0.1, gitignored by
`apps/ui/.gitignore:35`). `projection.json` in the copy pins
`electrobun 2.0.1`, `macos/arm64`, `sourceManifestSha256 e7978b03...`.

| Command (in `<clean-checkout-3>/apps/ui`) | Exit | Result |
| --- | --- | --- |
| `env -u SMITHERS_HOME node scripts/ensure-devkit.mjs` | 0 | No output; `devkitIsFresh` accepts the copied projection against the installed `electrobun@2.0.1`; `git status --porcelain` stays empty (`00-ensure-devkit.log`) |

This is the documented setup state for the checkout. It is a function of the
toolchain, not of the repository, and it changes no tracked file.

## What the gate covers

Root `package.json`: `check` is `pnpm --recursive --if-present run check`,
`lint` is `pnpm --recursive --if-present run lint`. There is no separate root
format script: per rc-contract section 9 the formatter is dprint per package,
and every package `lint` script is `eslint src --max-warnings=0 && dprint check`
(51 tracked `dprint.json` files, one per package; `packages/build` lints
`src infra terraform/modules/cache/service`). The workspace has 64 projects;
`-r` recurses into 63 (the private root is excluded). `--if-present` skips:

- No `check` script (4): `apps/bug-worker`, `apps/status-site`, `packages/ui`,
  `packages/ui-styleguide`. 63 - 4 = 59 projects typechecked.
- No `lint` script (12): `apps/bug-worker`, `apps/review`, `apps/server`,
  `apps/shared`, `apps/status-site`, `apps/tui`, `apps/ui`, `e2e`, `examples`,
  `packages/build/infra`, `packages/ui`, `packages/ui-styleguide`.
  63 - 12 = 51 projects linted.

`check` script variants observed in `01-pnpm-check.log`: 51 run
`tsc -b tsconfig.json && tsc -p tsconfig.test.json --noEmit`; `apps/ui` runs
`node scripts/ensure-devkit.mjs && tsc --noEmit`; `apps/server`, `apps/shared`,
`apps/tui` run `tsc --noEmit`; `apps/review` runs
`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit`; `e2e`
and `examples` run `tsc -p tsconfig.json --noEmit`; `packages/build/infra` runs
`tsc -b tsconfig.json --force`.

`BUILD.ts` graph (`smithers-build query '//...'`, `09-smithers-build-query.txt`):
444 targets, 111 with the `lint` kind:

| Group | Targets | Run here |
| --- | --- | --- |
| Root generated-file drift: `//:ci` (GithubCiGen), `//:tsconfig` (Tsconfig), `//:knownFiles` (Generate) | 3 | yes; `//:ci` and `//:knownFiles` are steps of the required CI `test` job (`BUILD.ts:141,146`; `.github/workflows/ci.yml:89-90`; pinned at `packages/flows/test/vitestCoverageIsolation.test.ts:479`) |
| Package `fmt` (Dprint) and `lint` (EsLint), 51 packages each; `//packages/engine:dependencyPolicy` (DepsLint) | 103 | yes, as `lint '//packages/...'` |
| `//crates/flows-jj:cargoFmt`, `cargoClippy` (CargoLint) | 2 | no: the `rust` CI job, outside this gate |
| `//lint:{durableIdentityGuard,docsReferenceSync,jsdocTruthfulness}` (LlmLint) | 3 | no: diff-against-`origin/main` model reviews, not a workspace lint |

`pnpm run test:jsdoc` (the `eslint.jsdoc.js` convention test named in
rc-contract section 9) is included as supporting evidence.

## Commands and results

All commands ran from `<clean-checkout-3>` unless a directory is named, each in
the foreground, serially, with `uptime` checked before the long steps. Logs are
in `format-lint-typecheck-logs/` beside this file.

| # | Command | Exit | Result |
| --- | --- | --- | --- |
| 0 | `env -u SMITHERS_HOME node scripts/ensure-devkit.mjs` (in `apps/ui`) | 0 | No output; projection accepted (`00-ensure-devkit.log`) |
| 1 | `env -u SMITHERS_HOME corepack pnpm -r --no-bail --if-present run check` | 0 | `Scope: 63 of 64 workspace projects`; 59 `check: Done`; final line `e2e check: Done`; zero `error TS`, zero `ELIFECYCLE`; 07:26:22 to 07:28:43 UTC (`01-pnpm-check.log`, 119 lines) |
| 2 | `env -u SMITHERS_HOME corepack pnpm -r --no-bail --if-present run lint` | 0 | `Scope: 63 of 64 workspace projects`; 51 `lint: Done`; final line `packages/build-cli lint: Done`; zero eslint problems, zero dprint findings; 07:28:55 to 07:30:48 UTC (`02-pnpm-lint.log`, 104 lines) |
| 3 | `env -u SMITHERS_HOME corepack pnpm exec smithers-build lint '//:ci' --ui plain` | 0 | `//:ci  ran  19ms`; `1 targets: 0 hit, 1 ran, 0 failed, 0 skipped (35ms)`; `ok: true` (`03-smithers-build-lint-ci.log`) |
| 4 | `env -u SMITHERS_HOME corepack pnpm exec smithers-build lint '//:tsconfig' --ui plain` | 0 | `//:tsconfig  ran  15ms`; `1 targets: 0 hit, 1 ran, 0 failed, 0 skipped (17ms)`; `ok: true` (`04-smithers-build-lint-tsconfig.log`) |
| 5 | `env -u SMITHERS_HOME corepack pnpm exec smithers-build lint '//:knownFiles' --ui plain` | 0 | `//:knownFiles  ran  647ms`; `1 targets: 0 hit, 1 ran, 0 failed, 0 skipped (649ms)`; `ok: true` (`05-smithers-build-lint-knownFiles.log`) |
| 6 | `env -u SMITHERS_HOME corepack pnpm exec smithers-build lint '//packages/...' --ui plain` | 0 | `106 targets: 0 hit, 106 ran, 0 failed, 0 skipped (43.7s)`; `ok: true`; rows: 51 Dprint, 51 EsLint, 1 DepsLint, plus the 3 `lib` TsBuild deps of `//packages/engine:dependencyPolicy` (`06-smithers-build-lint-packages.log`) |
| 7 | `env -u SMITHERS_HOME node scripts/generate-known-files.mjs && git status --short known-files.d.ts` | 0 | Prints nothing (0 bytes captured, `07-generate-known-files-idempotency.log`). Blob before and after the rewrite: `4d181535e2627514bdd0abdb382743055c0bc786`, equal to `HEAD:known-files.d.ts`; 11398 lines; line 2 reads `// The 4653 workspace files below follow the same .gitignore and host-state rules as globs.`; `git diff --quiet -- known-files.d.ts` exits 0 |
| 8 | `env -u SMITHERS_HOME corepack pnpm run test:jsdoc` | 0 | `tests 5`, `suites 0`, `pass 5`, `fail 0` (`08-pnpm-test-jsdoc.log`) |

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

One benign line in command 2 (`02-pnpm-lint.log`): `packages/build lint:
Multiple projects found, consider using a single tsconfig with references ...
noWarnOnMultipleProjects`. It is the typescript-eslint projectService
performance note for a package that lints three tsconfig roots, not an eslint
warning; the package exits 0 under `--max-warnings=0`. The same note was
recorded at `9c464343f0` and `20b32c6316`.

## What changed since the prior run

At `20b32c6316`, command 5 failed with `known-files.d.ts drifted from its
generated form: 11367 line(s) checked in, 11399 regenerated` because that
commit added 14 tracked files and deleted 3 without regenerating the registry.
Commit `163fdf4bf5` regenerates it: the checked-in file now has 11398 lines by
`wc -l` (the lint reports 11399 because `packages/targets/src/Compose.ts:241-242`
splits the buffer on `"\n"`, which counts the empty string after the trailing
newline), its header counts 4653 workspace files, and the drift lint, the generator, and `git` agree that the
tracked content equals the generated content. Command 7 proves the
regeneration is idempotent at this commit: rewriting the file from the current
tree produces the same blob `4d181535e2...` and an empty `git status --short`.

All other results are unchanged from the prior run: the same 59 packages
typecheck, the same 51 packages lint, the same 103 package targets pass through
the graph, and `//:ci` and `//:tsconfig` match their checked-in files.

## Post-run tree state

`git status --porcelain` is empty after every command. The gate wrote nothing
tracked: `tsc -b` emits into gitignored `dist/` (`.gitignore:7`), `eslint`
without `--fix` and `dprint check` mutate nothing, `smithers-build` writes only
the gitignored `.flows/` cache (`.gitignore:90`), and the one deliberate
rewrite of `known-files.d.ts` reproduced the HEAD blob byte for byte.
`apps/ui/.hutch/devkit` (gitignored) remains in place for later gates that
typecheck or build `apps/ui`. HEAD is still
`163fdf4bf55bb86984a0b3cf9ddf4b0d7e836c5c` at 07:32:52 UTC.

## Raw logs

`format-lint-typecheck-logs/` beside this file: `00-ensure-devkit.log`,
`01-pnpm-check.log`, `02-pnpm-lint.log`, `03-smithers-build-lint-ci.log`,
`04-smithers-build-lint-tsconfig.log`, `05-smithers-build-lint-knownFiles.log`,
`06-smithers-build-lint-packages.log`,
`07-generate-known-files-idempotency.log`, `08-pnpm-test-jsdoc.log`,
`09-smithers-build-query.txt`. The superseded run's logs are in
`format-lint-typecheck-logs-20b32c6316/`.

## Verdict

PASS. From the clean checkout at `163fdf4bf5`: typecheck 59 of 59, eslint plus
dprint 51 of 51 through pnpm and 103 of 103 package targets through the
`BUILD.ts` graph, `//:ci`, `//:tsconfig`, `//:knownFiles`, the
`known-files.d.ts` regeneration idempotency check, and `test:jsdoc` all exit 0.
No blockers remain for this gate.
