# Clean-checkout verification evidence

Fifteen of seventeen Phase 7 gates pass. Two fail, and each failure is a
release blocker until it is closed or the maintainer accepts it in writing.

State as of 2026-08-31, after the wave-4 fix lanes landed. Two defects in this
repository account for both failing gates, and both have open fix lanes, so
re-run the affected gate from a clean checkout before reading a verdict here as
final.

Every gate ran from a clean checkout, never from the maintainer tree, with real
backends and real persisted data. No mocks, no fixtures standing in for a
service. The evidence file for each gate names its exact commands, the
environment they ran in, the final output lines, and the exit codes; the copies
under [evidence/](evidence/) are those files byte for byte.

## What was validated

| Item | Value |
| --- | --- |
| Checkouts | `git clone --shared` of the maintainer tree, `v1/rc0-migration`, `vendor/jj` submodule initialized: `migration/clean-checkout-2` and `migration/clean-checkout-3`. The Plue gate cloned `/Users/williamcory/plue` to `migration/plue-clean-cutover`. |
| HEAD, most gates | `20b32c6316487497301db74ec70cbe951428ef53` |
| HEAD, format-lint-typecheck and exports-types-sync | `163fdf4bf55bb86984a0b3cf9ddf4b0d7e836c5c` |
| HEAD, scans | `41bfdcb06f0fa3a7d01b0b9e0242c663802d0f78` |
| Host | macOS 26.2 (25C56), Darwin 25.2.0, arm64 |
| Node | v24.18.0 |
| Bun | 1.4.0 (`1.4.0-canary.1+6618e7f7e`) |
| pnpm | 11.21.0, resolved by corepack 0.35.0 from `packageManager`. The Plue gate used pnpm 10.6.5, which Plue pins. |
| git | 2.50.1 (Apple Git-155) |
| Date | 2026-08-31, 06:44Z to 08:13Z |

The tree moved twice during the round. `163fdf4bf5` regenerates
`known-files.d.ts` for the files the UI commit added, and `41bfdcb06f` moves the
repository UI manifest out of `.smithers/`. Both are the closures of gate
failures from the previous round, and each gate that re-ran names the HEAD it
measured.

The host runs Node 24.18.0, above the `>=22.19.0` floor. CI pins Node 22.19.0
and Bun 1.3.14; the consumer fixtures also ran on Node 22.19.0, and the Bun
work here ran on 1.4.0. A full Node 22.19.0 lane is CI's job, not this one's.

Raw logs, databases, transcripts, and packed tarballs stay in the Phase 7
working directory (`migration/phase7/`), which each evidence file cites by
name. Only the evidence documents are copied into this repository.

## Verdicts

| Gate | PLAN Phase 7 line | Verdict | Headline result | Evidence |
| --- | --- | --- | --- | --- |
| clean-install | frozen installs for pnpm and Bun | PASS | Both frozen installs exit 0 from a fresh shared clone and change no tracked file | [00-clean-install.md](evidence/00-clean-install.md) |
| format-lint-typecheck | formatting, lint, and typecheck | PASS | Typecheck for 59 members, dprint plus eslint for 51, the same 103 targets through the build graph, and the three root generated-file lints all exit 0 | [format-lint-typecheck.md](evidence/format-lint-typecheck.md) |
| unit-tests | package-level and full unit tests | PASS | `Summary: 2 fails, 61 passes` across 63 projects and 11,545 tests; the five failing tests all need live external state | [unit-tests.md](evidence/unit-tests.md) |
| sqlite-persistence-crash | real SQLite persistence and crash/restart suites | PASS | 1,521 tests across 189 files, 0 failures; the 18-case end-to-end fault matrix ran inside budget with every crash-family case green | [sqlite-persistence-crash.md](evidence/sqlite-persistence-crash.md) |
| browser-bundling | browser bundling for advertised browser-safe entry points | PASS | 28 of 28 browser-safe entries bundle; 7 of 7 Node-only entries fail on their documented `node:` builtin | [browser-bundling.md](evidence/browser-bundling.md) |
| cli-e2e | CLI end-to-end tests using the working-tree CLI | PASS | 607 of 608 tests pass against the working-tree CLI; the one red test is a wall-clock assertion on a loaded host | [cli-e2e.md](evidence/cli-e2e.md) |
| integrations-real-backend | real-backend integration tests for every integration in the RC | PASS | GitHub and Linear pass their contract suites against `api.github.com` and `api.linear.app`. Telegram is ENV-SKIP with no token on this host and is not an rc.0 release-smoke integration. | [integrations-real-backend.md](evidence/integrations-real-backend.md) |
| docs-generation-links | documentation generation and link checks | PASS | `check-docs` (16 checks, 504 internal links), `check-llms`, `vocs build`, and the `docsUnit` group all pass; regeneration leaves the tree clean | [docs-generation-links.md](evidence/docs-generation-links.md) |
| exports-types-sync | package export/type synchronization checks | PASS | Both export maps agree with each other and with the files on disk for all 40 published packages; every non-null subpath resolves under Node and Bun and every null subpath refuses | [exports-types-sync.md](evidence/exports-types-sync.md) |
| dependency-cycles-names | dependency-cycle and duplicate-package-name checks | PASS | Zero import cycles across the 51 projects that declare the check (888 modules, 1,613 edges); all 64 project names unique | [dependency-cycles-names.md](evidence/dependency-cycles-names.md) |
| npm-pack | npm pack/dry-run inspection for every public package | PASS | 40 of 40 tarballs pack from a built clean checkout and pass every completeness check (`failures: 0`) | [npm-pack.md](evidence/npm-pack.md) |
| consumer-fixtures | installation into clean Node and Bun consumer fixtures | PASS | The 40 tarballs install into fresh Node and Bun projects and run the README quick start to `Hello, Ada.` under Node 24.18.0, Node 22.19.0, and Bun 1.4.0 | [consumer-fixtures.md](evidence/consumer-fixtures.md) |
| examples | execution of all published examples | PASS | 58 of 58 suite tests green under the shipped CI condition; the three self-running live smokes complete against real providers | [examples.md](evidence/examples.md) |
| migration-tool | migration workflow tests against representative 0.x projects | PASS | 374 tests pass and 6 skip across 29 files, over six byte-for-byte 0.x fixtures including Plue's pack; the skips need model credentials the tool refuses to pick for you | [migration-tool.md](evidence/migration-tool.md) |
| plue-cutover | clean builds, real-backend contract tests, and import scans in `../plue` | FAIL | Every Plue-side item that runs without the live stack passes. The gate fails on two rc.0 defects it exposed, both listed below. | [plue-cutover.md](evidence/plue-cutover.md) |
| scans | secret, generated-file, stale-version, and obsolete-import scans | PASS | All five sweeps pass with every hit classified; a fresh clone's first `smithers ls` and `smithers doctor` print no 0.x notice | [scans.md](evidence/scans.md) |
| smoke | the manual smoke test, eight items | FAIL | All eight items execute end to end. The gate fails on the persisted state item 1 leaves behind. | [smoke.md](evidence/smoke.md) |

## Records that are not gates

| File | What it is |
| --- | --- |
| [hardening-notes.md](evidence/hardening-notes.md) | Rules learned during the round that later work should keep |
| [smoke-prev-9c464343f0.md](evidence/smoke-prev-9c464343f0.md) | The superseded 2026-08-30 smoke run at `9c464343f0`, kept because the current run cites it. Its four durable-park blockers are fixed and re-proven. |
| [fix-engine-park-report.md](evidence/fix-engine-park-report.md) | Fix lane `phase7/engine-park`, landed in `6199b80c24`. Closes the durable-park blockers the 2026-08-30 smoke recorded. |
| [fix-known-files-report.md](evidence/fix-known-files-report.md) | Fix lane `phase7/known-files`, landed in `71d2e259d2`. Closes the `known-files.d.ts` reproducibility blocker that failed scans and exports-types-sync. |
| [fix-polish-report.md](evidence/fix-polish-report.md) | Fix lane `phase7/polish`, landed in `91f62c4192`. Closes the example 13 failure and three smaller findings. |
| [fix-e2e-matrix-report.md](evidence/fix-e2e-matrix-report.md) | Fix lane `phase7/e2e-matrix`, landed in `02bfb27585`. Makes the end-to-end fault matrix a workspace member and gates it in CI. |
| [fix-plue-jsx-report.md](evidence/fix-plue-jsx-report.md) | Plue lane, commit `93abe834f`. Closes the Path D JSX runtime blocker the 2026-08-30 plue-cutover gate recorded. |
| [fix-plue-ci-attached-report.md](evidence/fix-plue-ci-attached-report.md) | Plue lane, commit `976a170a6`, made after the plue-cutover gate ran. Launches both CI pipelines attached, which closes Plue's half of blocker 2 on its branch and leaves the rest to this repository. |

## The two blockers

Both failures are engine-store and CLI defects in this repository. Neither is a
Plue defect, and neither is environmental.

### 1. A run's terminal result is never recorded in the engine store

Found twice, independently, in the same round: the smoke gate saw it for a
`completed` run and the plue-cutover gate saw it for a `failed` one.

`packages/cli/src/Command.ts` `settled`/`awaitRun` (lines 207 to 231) returns as
soon as the control plane emits `control.run.completed`. The command's scope
then closes and the executor's driver is interrupted while `engine.execute` is
still recording the run's result. The launching process logs `WARN An agent run
lifecycle event could not be journaled` and the engine journals
`interrupt-released`. The engine row is left `suspended`/`released` with no
result, so every later process that composes an executor (`up`, `run`,
`approve`, `serve`) claims it through the ordinary reclaim path, replays the
whole agent turn, and then fails to settle it:

```
engine-store: coordinated drain failed for run-1 SchemaError: Expected JSON value
  at ["exit"]["cause"][0]["error"]        (packages/engine-store/src/internal/RunCoordinator.ts:89)
```

Measured in the smoke project after 22 minutes: two such rows, one of them
re-driven by ten separate processes; 162 journal events against 36 for an
untouched run; 16 `flows.engine.run-decision` records across 11 process ids;
`status` reporting tokens multiplied by the replay count; `gc` listing the run
for `control.db` and omitting it for `engine.db`; and the engine row reading
`running` under a process id that is already dead.

The plue-cutover gate hit the failed-run half against a real seat. Its two
retained databases show `control.db` saying `failed` and `engine.db` saying
`running`, and booting any executor against them after the heartbeat goes stale
produces `stolen-and-activated` followed by a fresh model call. That spends
money on a run the control plane has already closed.

Durable settlement is the core promise of this release. Fix lane
`phase7/engine-failed-persist` is open at `41bfdcb06f` with two recorded red
runs (`fix-engine-failed-persist-logs/01-red-exitencoding.log`, 6 of 18 tests
red; `02-red-crossprocess.log`, 2 of 2 red). No fix is committed yet.

### 2. An attached launch exits 0 for a failed settlement

`smithers up <flow> --json; echo $?` prints 0 while `smithers status <runId>`
prints `Verdict failed`. `runLaunch` in `packages/cli/src/Command.ts` (lines 372
to 392) fails only on a declined settlement, so a failed or cancelled terminal
status returns success. Release contract section 4 and section 10 both require
the exit code to carry the verdict.

The consequence outside this repository is a CI job that reports green for a red
tier. Plue's half of that is already fixed: commit `976a170a6` launches both
pipelines attached instead of with `-d`, which was the third item the
plue-cutover gate raised. The job's exit code becomes the tier's only when this
blocker closes.

`packages/cli/test/Bin.test.ts` has no failed-terminal case, which is why the
cli-e2e gate's negative sweep did not catch this. Fix lane
`phase7/cli-exit-code` is open at `41bfdcb06f` with no commit yet.

## Two further defects, recorded and not blocking

The smoke gate recorded both. Neither risks run state or money.

- Runtime warnings reach stdout inside a `--json` document.
  `packages/cli/src/bin.ts` (lines 33 to 40) states that the runtime logger
  writes to stdout and that reporting was disabled for that reason, but
  `Effect.logWarning` calls in `@smthrs/engine-store` and `@smthrs/agent` still
  reach it. A script running `JSON.parse` on the output fails whenever a
  blocker 1 row exists in the project.
- `NoMatchingWait` prints as the signal name and an empty message.
  `packages/control/src/ControlError.ts:182` declares the error with a
  `name: Schema.String` field, which shadows `Error.prototype.name`, so
  `smithers signal run-3 '{"name":"go"}'` against a timer-parked run exits 1
  with `go: ` instead of naming the reason.

## A release gate that no Phase 7 gate covers

`node scripts/check-npm-dedupe.mjs` exits 1 at `20b32c6316`. It packs the
release manifests into a throwaway fixture and lets npm's own arborist resolve
the tree an end user would get. `effect` resolves to a single copy at
`4.0.0-rc.108` and the resolved package count is 165 against a budget of 925,
but the run ends with

```
vitest must stay out of the default install (optional peer), found:
  - node_modules/vitest
```

`@smthrs/kernel` declares `vitest` an optional peer, and `@smthrs/testing`
declares `vitest: "^4.1.0"` as a plain peer with no
`peerDependenciesMeta` entry, so npm installs it into a consumer's default
tree. The two published manifests contradict each other, and the maintainer
decides which one is right.

Release contract R-35 says this gate is a `scripts/BUILD.ts` target run by
`smithers-build test '//scripts/...'`. It is declared in no `BUILD.ts`, selected
by no CI job, and named by no Phase 7 gate. The publish runbook is the only
place it runs, which is why the failure was found while preparing release
artifacts rather than during validation.

## Environmental results, classified and not blocking

- `examples`: the live OpenAI seat answers `no credits remaining` for example
  12. The Phase 2 baseline records the same failure, and the test skips cleanly
  without the key.
- `packages/build-cli`: no Docker daemon on the host (three tests), and one
  fixture requires `mise` to be absent where this host has it installed.
- `integrations`: Telegram is ENV-SKIP. No `TELEGRAM_BOT_TOKEN` exists on this
  host, and the release contract does not make Telegram a release-smoke
  integration.
- `plue-cutover`: the live-stack items stay ENV-SKIP because `@smthrs/*`
  `1.0.0-rc.0` is unpublished, no API listens on `localhost:4000`, and Docker is
  down. Those items unblock after publication, not before.
- Bun does not satisfy a nested exact `@smthrs/*@1.0.0-rc.0` edge from a root
  `file:` tarball, so the Bun consumer fixture adds overrides mapping each of
  the 40 names to its tarball. Once the version is on the registry, a Bun
  consumer following the README install line resolves normally.

The Phase 2 baseline recorded `Summary: 2 fails, 55 passes` and Phase 3 recorded
`2 fails, 56 passes`. This round is `2 fails, 61 passes` over six more projects.

## What this round did not cover

- CI's own pinned toolchain. These gates ran on Node 24.18.0 and Bun 1.4.0
  (with a Node 22.19.0 consumer-fixture lane); the required CI lanes pin Node
  22.19.0 and Bun 1.3.14.
- Windows, which the release contract lists as unsupported.
- Publishing. Nothing was published to any registry, and the migration-tool
  gate never ran `--apply` against a real project.
- Plue mainline. The cutover lives on the unmerged branch
  `smithers-rc0-cutover`; Plue's `664c95c60` still carries the full 0.x surface.
- The plugins repository, which release contract section 10 holds as a
  maintainer prerequisite rather than a gate in this repository.
