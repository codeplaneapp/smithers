# Clean-checkout verification evidence

Sixteen of seventeen Phase 7 gates pass. One fails: `docs-generation-links`.
That failure is a release blocker until it is closed or the maintainer accepts
it in writing.

State as of 2026-08-31, after the wave-5 and wave-6 fix lanes landed. The two
engine and CLI blockers the previous round recorded are closed and re-proven
live: the smoke gate and the plue-cutover gate both turned from FAIL to PASS on
the same evidence. The one remaining failure is in the docs gate family, and
its two code defects have finished fix lanes staged on the branch
`land/wave-7`. Re-run that gate from a clean checkout after the lanes land
before reading a verdict here as final.

Every gate ran from a clean checkout, never from the maintainer tree, with real
backends and real persisted data. No mocks, no fixtures standing in for a
service. The evidence file for each gate names its exact commands, the
environment they ran in, the final output lines, and the exit codes; the copies
under [evidence/](evidence/) are those files byte for byte.

## What was validated

| Item | Value |
| --- | --- |
| Checkout | `git clone --shared` of the maintainer tree, `v1/rc0-migration`, `vendor/jj` submodule initialized: `migration/clean-checkout-4`. The Plue gate cloned `/Users/williamcory/plue` branch `smithers-rc0-cutover` to `migration/plue-clean-cutover`. |
| HEAD, every gate | `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba` |
| Plue branch tip | `976a170a64097827de8371bbf2a08930ebce7f34` on `smithers-rc0-cutover`, base `664c95c60`, unmerged |
| Submodule | `vendor/jj` at `47589ada70c1` |
| Host | macOS 26.2 (25C56), Darwin 25.2.0, arm64, 16 cores |
| Node | v24.18.0 |
| Bun | 1.4.0 (`1.4.0-canary.1+6618e7f7e`) |
| pnpm | 11.21.0, resolved by corepack 0.35.0 from `packageManager`. The Plue gate used pnpm 10.6.5, which Plue pins. |
| go / zig / jj / sqlite3 | go1.26.0, 0.15.2, 0.39.0, 3.51.0 |
| Date | 2026-08-31, 11:52Z to 13:17Z |

Every gate measured one commit, `cd14388ed7`. The maintainer tree is one
commit ahead at `f63809382b`, a docs-only contract edit that changes no
package, script, or test.

The host runs Node 24.18.0, above the `>=22.19.0` floor. CI pins Node 22.19.0
and Bun 1.3.14; the consumer fixtures also ran on Node 22.19.0, and the Bun
work here ran on 1.4.0. A full Node 22.19.0 lane is CI's job, not this one's.

Raw logs, databases, transcripts, and packed tarballs stay in the Phase 7
working directory (`migration/phase7/`), which each evidence file cites by
name. Only the evidence documents are copied into this repository.

## Verdicts

| Gate | PLAN Phase 7 line | Verdict | Headline result | Evidence |
| --- | --- | --- | --- | --- |
| clean-install | frozen installs for pnpm and Bun | PASS | Both frozen installs exit 0 from a fresh shared clone, the offline re-runs exit 0, and no install changes a tracked file | [00-clean-install.md](evidence/00-clean-install.md) |
| format-lint-typecheck | formatting, lint, and typecheck | PASS | Typecheck for all 59 members with a `check` script, dprint plus eslint for all 51 with a `lint` script, 106 lint targets through the build graph, the three root generated-file drift targets, and `test:jsdoc` all exit 0 | [format-lint-typecheck.md](evidence/format-lint-typecheck.md) |
| unit-tests | package-level and full unit tests | PASS | `Summary: 2 fails, 61 passes` across 63 of 63 projects and 14,649 tests; the five failing tests all need live external state | [unit-tests.md](evidence/unit-tests.md) |
| sqlite-persistence-crash | real SQLite persistence and crash/restart suites | PASS | 1,543 tests across 191 files, 0 failures, every coverage threshold held; the 18-case end-to-end fault matrix ran inside budget with all seven crash-family cases green | [sqlite-persistence-crash.md](evidence/sqlite-persistence-crash.md) |
| browser-bundling | browser bundling for advertised browser-safe entry points | PASS | 28 of 28 browser-safe entries bundle; 7 of 7 Node-only entries fail on their documented `node:` builtin; the final line matches the Phase 2 baseline verbatim | [browser-bundling.md](evidence/browser-bundling.md) |
| cli-e2e | CLI end-to-end tests using the working-tree CLI | PASS | 626 of 626 tests across 36 files pass against the working-tree CLI, exit 0, and the negative sweep refuses 127 of 127 removed invocations | [cli-e2e.md](evidence/cli-e2e.md) |
| integrations-real-backend | real-backend integration tests for every integration in the RC | PASS | GitHub and Linear pass their contract suites against `api.github.com` and `api.linear.app`. Telegram is ENV-SKIP with no token on this host and is not an rc.0 release-smoke integration. | [integrations-real-backend.md](evidence/integrations-real-backend.md) |
| docs-generation-links | documentation generation and link checks | **FAIL** | `vocs build`, `check-llms`, and `check-docs` pass with zero dead internal links. The gate fails on two defects the docs gate family exposed and one dead external link, all three listed below. | [docs-generation-links.md](evidence/docs-generation-links.md) |
| exports-types-sync | package export/type synchronization checks | PASS | Both export maps agree with each other and with the files on disk for all 40 published packages; 581 public subpaths resolve and 155 blocked subpaths refuse under Node require, Node import, and Bun | [exports-types-sync.md](evidence/exports-types-sync.md) |
| dependency-cycles-names | dependency-cycle and duplicate-package-name checks | PASS | Zero import cycles across the 51 packages that declare the check; all 64 project names unique | [dependency-cycles-names.md](evidence/dependency-cycles-names.md) |
| npm-pack | npm pack/dry-run inspection for every public package | PASS | 40 of 40 tarballs pack from a built clean checkout and pass every completeness check (`failures: 0`) | [npm-pack.md](evidence/npm-pack.md) |
| consumer-fixtures | installation into clean Node and Bun consumer fixtures | PASS | The 40 tarballs install into fresh Node and Bun projects and run the README quick start to `Hello, Ada.` under Node 24.18.0, Node 22.19.0, and Bun 1.4.0 | [consumer-fixtures.md](evidence/consumer-fixtures.md) |
| examples | execution of all published examples | PASS | 58 of 58 suite tests green under the shipped CI condition, all 38 scripts evaluate under Node, and the three self-running live smokes complete against real providers | [examples.md](evidence/examples.md) |
| migration-tool | migration workflow tests against representative 0.x projects | PASS | 374 tests pass and 6 skip across 29 files, over six byte-for-byte 0.x fixtures including Plue's pack; the skips need model credentials the tool refuses to pick for you | [migration-tool.md](evidence/migration-tool.md) |
| plue-cutover | clean builds, real-backend contract tests, and import scans in `../plue` | PASS | Every Plue cutover item that runs without the live stack and without the published registry passes against the clean Smithers checkout and the 40 tarballs packed from it. The live-stack items stay ENV-SKIP until the version is on the registry. | [plue-cutover.md](evidence/plue-cutover.md) |
| scans | secret, generated-file, stale-version, and obsolete-import scans | PASS | All five sweeps pass with every hit classified; a fresh clone's first `smithers ls` and `smithers doctor` print nothing on stderr and no `0.x` row | [scans.md](evidence/scans.md) |
| smoke | the manual smoke test, eight items | PASS | All eight items execute end to end against two real SQLite files, a real model seat, a real gateway, the built UI in headless Chrome, and the real GitHub and Linear APIs. Every run row is terminal with `finished_at_ms` set and `owner_pid` NULL. | [smoke.md](evidence/smoke.md) |

## Records that are not gates

| File | What it is |
| --- | --- |
| [hardening-notes.md](evidence/hardening-notes.md) | Rules learned during the round that later work should keep |
| [smoke-prev-20b32c6316.md](evidence/smoke-prev-20b32c6316.md) | The superseded 2026-08-31 smoke at `20b32c6316` (FAIL), kept because the current run cites its four blockers one by one |
| [plue-cutover-prev-20b32c6316.md](evidence/plue-cutover-prev-20b32c6316.md) | The superseded 2026-08-31 07:47Z plue-cutover round (FAIL), kept for the same reason |
| [fix-engine-park-report.md](evidence/fix-engine-park-report.md) | Fix lane `phase7/engine-park`, landed in `6199b80c24`. Closes the durable-park blockers the 2026-08-30 smoke recorded. |
| [fix-known-files-report.md](evidence/fix-known-files-report.md) | Fix lane `phase7/known-files`, landed in `71d2e259d2`. Closes the `known-files.d.ts` reproducibility blocker. |
| [fix-polish-report.md](evidence/fix-polish-report.md) | Fix lane `phase7/polish`, landed in `91f62c4192`. Closes the example 13 failure and three smaller findings. |
| [fix-e2e-matrix-report.md](evidence/fix-e2e-matrix-report.md) | Fix lane `phase7/e2e-matrix`, landed in `02bfb27585`. Makes the end-to-end fault matrix a workspace member and gates it in CI. |
| [fix-plue-jsx-report.md](evidence/fix-plue-jsx-report.md) | Plue lane, commit `93abe834f`. Closes the Path D JSX runtime blocker. |
| [fix-plue-ci-attached-report.md](evidence/fix-plue-ci-attached-report.md) | Plue lane, commit `976a170a6`. Launches both CI pipelines attached, which closes Plue's half of the exit-code blocker. |
| [fix-cli-exit-code-report.md](evidence/fix-cli-exit-code-report.md) | Fix lane `phase7/cli-exit-code`, landed in `4a803f193d`. An attached launch now exits with the run's terminal status. |
| [fix-engine-failed-persist-report.md](evidence/fix-engine-failed-persist-report.md) | Fix lane `phase7/engine-failed-persist`. Records a run's terminal result in the engine store so no later process steals and replays it. |
| [fix-cli-lifecycle-report.md](evidence/fix-cli-lifecycle-report.md) | Fix lane `phase7/cli-lifecycle`, landed in `ca22977386`. Extends the terminal-status exit code to `run --resume`, `approve`, and `deny`, and routes the runtime logger to stderr. |
| [fix-release-hygiene-report.md](evidence/fix-release-hygiene-report.md) | Fix lane `phase7/release-hygiene`, landed in `b22c47e5f5`. Closes the `check-npm-dedupe` failure and declares the gate as a target. |
| [fix-cli-refuse-before-boot-report.md](evidence/fix-cli-refuse-before-boot-report.md) | Fix lane `phase7/cli-refuse-before-boot`, commit `a506d60231`, staged on `land/wave-7`. Refuses a removed verb before the control plane boots. |
| [fix-docs-served-llms-report.md](evidence/fix-docs-served-llms-report.md) | Fix lane `phase7/docs-served-llms`, commit `510621c763`, staged on `land/wave-7`. Serves the curated llms bundles instead of vocs' own. |

## The one failing gate

`docs-generation-links` fails on three findings. The three checks the gate
itself names are green: `vocs build` emits 174 routes with zero dead-link
warnings, `pnpm docs:llms` rewrites 12 artifacts with 0 bytes changed and
`check-llms` confirms them, and `check-docs` resolves all 504 internal links.

### 1. Every removed-verb refusal opens two SQLite databases before it prints

`//scripts:docsUnit`, a target the required CI `test` job runs through
`smithers-build test '//scripts/...'`, is red in three of three runs on this
host. The cause is in the CLI, not in the docs. `packages/cli/src/bin.ts`
short-circuits only `--help` and `--version`; every other invocation resolves
`NodeControl.config` and runs the command tree under
`Effect.provide(NodeControl.layer(...))`, and a removed verb's refusal is a
hidden subcommand inside that layer. From an empty directory,
`node packages/cli/src/bin.ts ui` prints the correct refusal and leaves behind
`.flows/engine.db` and `.flows/control.db`; `--version` from the same directory
creates nothing.

`scripts/docs-removals.test.mjs` spawns 75 invocations 8 at a time with
`cwd: repoRoot` and a 15,000 ms bound, so 8 processes contend on the same two
SQLite files and either exceed the bound or surface `disk I/O error`. The claim
the test makes is true: a harness with the same data, a 120 s bound, and 4-way
concurrency reports all 75 refusals printing their documented sentence, median
spawn 7,486 ms, 0 of 75 over the 15,000 ms bound.

Fix lane `phase7/cli-refuse-before-boot` is done, commit `a506d60231`, staged
on `land/wave-7`.

### 2. The built site serves vocs' llms bundles, not the curated ones

vocs' built-in llms plugin writes its own `docs/dist/public/llms-full.txt`
(1,432,111 bytes, 44 historical 0.x changelog bodies, 40 JSX `<Task` tags, 8
`smithers oneshot` mentions, no version stamp). `docs-deploy.yml` uploads that
directory, so smithers.sh serves it rather than the 957,481-byte bundle
`check-llms` guards. The shipped skill
(`claude-plugin/skills/smithers/SKILL.md`) tells agents to read
`https://smithers.sh/llms-full.txt` first, which is the file with the JSX in
it.

Fix lane `phase7/docs-served-llms` is done, commit `510621c763`, staged on
`land/wave-7`.

### 3. Five pages link to a repository that does not exist

`https://github.com/smithersai/plugins` returns 404 from five pages. The
plugins repository is a maintainer prerequisite in release contract section 10,
not a code change in this repository. Create the repository or change the five
links before the docs site is deployed.

Cutover-order dependencies, not defects: 169
`github.com/smithersai/smithers/blob/main` links and 70
`smithers.sh/migration/1.0` links resolve only after this branch lands on
`main` and the vocs site is deployed.

## Two defects the smoke gate recorded and this round closed

Both were release blockers in the previous round. Both are re-proven closed
against the real binary, in `smoke.md` sections 1, 4, 6, and "D1 regression",
and in `plue-cutover.md` S1 and S2.

- A run's terminal result is now recorded in the engine store when the
  launching process owns the executor. The engine row settles `completed` or
  `failed` with `finished_at_ms` set and no `interrupt-released` decision, and
  a later executor process adds nothing to earlier rows. The plue-cutover gate
  re-measured the failed-run half over four runs and four process boots: no
  steal, no re-execution, no second model call.
- An attached `smithers up` or `smithers run` exits with the run's terminal
  status: 0 completed, 1 failed, 130 cancelled, 3 waiting-approval. `--json`
  stdout is exactly the receipt with 0 bytes on stderr, because the runtime
  logger now writes to stderr.

## The release gate that used to have no owner

`node scripts/check-npm-dedupe.mjs` failed in the previous round on a
peer-dependency disagreement between `@smthrs/kernel` and `@smthrs/testing`,
and it was declared in no `BUILD.ts`. Both halves are closed by the
release-hygiene lane (`b22c47e5f5`). Re-measured in `clean-checkout-4` at
`cd14388ed7`:

```
resolving 40 workspace packages with npm arborist (registry metadata)...
ok: effect@4.0.0-rc.108 (single copy)
ok: 3 optional peers absent from default install
resolved package count: 97 (budget 925)
EXIT=0
```

It is now `//scripts:npmDedupe` with a unit test at `//scripts:npmDedupeUnit`,
so `smithers-build test '//scripts/...'` selects it the way release contract
R-35 requires.

## Environmental results, classified and not blocking

- `unit-tests` and `examples`: five failing tests, all needing live external
  state. The live OpenAI seat answers `no credits remaining` for example 12
  (the Phase 2 baseline records the same failure, and the test skips cleanly
  without the key); `packages/build-cli` needs a running Docker daemon (three
  tests) and a host without `mise` on `PATH` (one test).
- `sqlite-persistence-crash`: one red test, case 22's terminal-redaction half.
  rc.0 ships no redacting logger, `e2e/fault-gaps.md` row 22 keeps the test
  red on purpose rather than skipping or inverting it, and the `e2e-faults` CI
  job is advisory for that reason. It is a documented rc.0 limitation, and
  ruling R-12 makes closing it a maintainer decision before publication.
- `integrations`: Telegram is ENV-SKIP. No `TELEGRAM_BOT_TOKEN` exists on this
  host, and the release contract does not make Telegram a release-smoke
  integration.
- `clean-install`: the `apps/ui` Electrobun devkit projection did not complete,
  because a concurrent `electrobun dev` in the maintainer tree holds Hutch's
  release locks. The postinstall step is soft and no gate depended on it.
- `plue-cutover`: the live-stack items (plue-consumer-contract section 13 items
  3, 5, 6, 7, 8, and the live half of 10) stay ENV-SKIP because `@smthrs/*`
  `1.0.0-rc.0` is unpublished, no API listens on `localhost:4000`, and Docker
  is down. Those items unblock after publication, not before. Plue's `ci-fast`
  tier is separately red at its own base revision for reasons that predate the
  cutover (Postgres-backed tests under `-short`, two dashboard assertions);
  that is a Plue mainline condition, recorded as P3.
- Bun does not satisfy a nested exact `@smthrs/*@1.0.0-rc.0` edge from a root
  `file:` tarball, so the Bun consumer fixture adds overrides mapping each of
  the 40 names to its tarball. Once the version is on the registry, a Bun
  consumer following the README install line resolves normally.

The Phase 2 baseline recorded `Summary: 2 fails, 55 passes` and Phase 3
recorded `2 fails, 56 passes`. This round is `2 fails, 61 passes` over 63
projects and 14,649 tests.

## Observations recorded for the release notes

The smoke gate recorded eight, none of them blockers: a timer park is labelled
`waiting-approval` by `ps` and `status`; the `smithers init` template ships no
`model:` line; `logs --follow` on a settled run never exits; `ps` without
`--json` prints pretty JSON rather than a table; `status` token totals after a
resume count the replayed turn again while the engine makes no second model
call; `GET /projections` with no name answers 404 with an empty body;
`up --remote` returns after admission rather than settlement; and command boot
time rose from about 3 s to about 10 s under a 1-minute load average of 10 to
20 without losing a lease.

## What this round did not cover

- CI's own pinned toolchain. These gates ran on Node 24.18.0 and Bun 1.4.0
  (with a Node 22.19.0 consumer-fixture lane); the required CI lanes pin Node
  22.19.0 and Bun 1.3.14.
- Windows, which the release contract lists as unsupported.
- Publishing. Nothing was published to any registry, and the migration-tool
  gate never ran `--apply` against a real project.
- Plue mainline. The cutover lives on the unmerged branch
  `smithers-rc0-cutover`; Plue's `664c95c60` still carries the full 0.x
  surface.
- The plugins repository, which release contract section 10 holds as a
  maintainer prerequisite rather than a gate in this repository.
- The `land/wave-7` lanes. Both are complete with recorded red runs, and
  neither is measured by a gate in this table.
