# Phase 7 gate: unit-tests

Verdict: PASS

This file supersedes the 2026-08-31 06:58 UTC evidence taken at `20b32c6316` in `migration/clean-checkout-2` (that directory no longer exists). The superseded file is kept beside this one as `unit-tests-prev-20b32c6316.md`. Every command below ran in `migration/clean-checkout-4` at `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba`.

The full recursive fan-out completes from the clean checkout in one attempt with `Summary: 2 fails, 61 passes` (63 of 63 workspace projects, 14,649 tests: 14,620 passed, 5 failed, 24 skipped by their own gates). The five failing tests are the same five the superseded evidence, `docs/migration/phase2-baseline.md` section 2.1, and `docs/migration/phase3-validation.md` classify environmental: a funded OpenAI seat (`examples` example 12), a running Docker daemon (`packages/build-cli`, three tests), and a host without `mise` on `PATH` (`packages/build-cli`, one test). Each is proven environmental in "Failure classification" from the provider's own error text, a `docker info` probe, and the resolved binary path in the assertion output. Every other suite passes at package level, including the suites that reach real backends and ran live here: Gemini (`packages/model`, 240/240), the local Ollama agent smoke (example 13, inside the `examples` run), the e2e fault harness (40/40), and the working-tree CLI (`packages/cli`, 626/626). No product defect surfaced. The `apps/ui` stall the superseded evidence recorded once did not recur: `bun test src` completed inside the fan-out (177.73 s under a host load average above 60) and again alone (62.74 s).

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2 (build 25C56), Darwin 25.2.0, arm64, 16 cores, 64 GiB |
| Node | v24.18.0 (`/Users/williamcory/.nvm/versions/node/v24.18.0/bin/node`); rc-contract section 1 floor is `>=22.19.0`, CI pins 22.19.0 |
| corepack | 0.35.0, selecting pnpm from `packageManager: pnpm@11.21.0` |
| pnpm | 11.21.0 |
| Bun | 1.4.0-canary.1+6618e7f7e (`bun --version` prints `1.4.0`); CI pins 1.3.14 |
| git | 2.50.1 (Apple Git-155) |
| sqlite3 | `/usr/bin/sqlite3` (used only to inspect the `.flows` databases in "Test hygiene observations") |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4`, branch `v1/rc0-migration`, HEAD `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba` (equal to `v1/rc0-migration` in `/Users/williamcory/smithers`), submodule `vendor/jj` at `47589ada70`; `git status --porcelain` empty before the fan-out, after it, and after every package-level run |
| Install state | The clean-install gate's frozen installs (`00-clean-install.md`, same checkout, same HEAD). No package `dist/` existed when the fan-out started (`ls -d packages/*/dist` matched nothing) and no build step ran before or between the test runs. The `apps/ui` Electrobun devkit projection (`apps/ui/.hutch/devkit/projection.json`) is absent; `apps/ui`'s `test` script (`bun test src`) does not run `ensure-devkit.mjs`, so it is not an input to this gate |
| Date | 2026-08-31 12:00 to 12:24 UTC (05:00 to 05:24 PDT) |
| Shell env | `SMITHERS_HOME` unset in the calling shell and stripped from every invocation (`env -u SMITHERS_HOME`). `OPENAI_API_KEY` and `GEMINI_API_KEY` set, so the live-seat suites ran instead of skipping. `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, and `SMITHERS_SLOW_TESTS` unset. `docker` CLI at `/usr/local/bin/docker`, daemon down. `mise` 2026.8.14 at `/opt/homebrew/bin/mise`. Ollama serving `qwen2.5:7b` at `http://localhost:11434` |
| Host load | Load averages 49.92 / 20.88 / 12.11 when the fan-out started and 29.08 / 58.30 / 45.60 when it ended; the 1-minute average peaked at 94.63 during it. A second `pnpm -r --no-bail --if-present run test` fan-out was running in `migration/wt/_verify-6` for the whole window, a `pnpm run circular` fan-out and two `smithers-build` lanes (`//scripts:browserContract`, `check-docs`) ran in this checkout, and the source tree's `electrobun dev` (`pnpm run start` in `/Users/williamcory/smithers/apps/ui`) ran throughout |

## Delta since the superseded evidence

`20b32c6316..cd14388ed7` is 20 commits, 81 files, +9,627/-1,420. The only manifest change is `packages/testing/package.json` moving `@effect/vitest` and `vitest` to optional peers (`050a30f89f`). Test files changed or added: `apps/shared/src/{Cards,LocalApp}.test.ts`, `apps/ui/src/bun/RepoPlugin.test.ts`, `apps/ui/src/mainview/cards/RepoPluginCard.test.tsx`, `packages/agent/test/{AgentSessionFailures,CompletedRunPersistsAcrossProcesses,FailedRunPersistsAcrossProcesses}.test.ts`, `packages/cli/test/{Bin,ControlSurface}.test.ts`, `packages/control/test/EngineWaits.test.ts`, `packages/engine-store/test/{ExitEncoding,UnencodableSettlement}.test.ts`, `packages/flows/test/vitestCoverageIsolation.test.ts`, `scripts/check-npm-dedupe.test.mjs`, `scripts/docs-contract.test.mjs`, `scripts/repo-contract/fault-skips.test.mjs`. The per-project tallies moved accordingly: `packages/cli` 608 to 626, `packages/engine-store` 799 to 821, `packages/agent` 422 to 428, `packages/control` 229 to 230, `apps/ui` 1224 to 1226. Every added test passes. The `scripts/*.test.mjs` files are `node --test` targets under `//scripts/...`, not part of this fan-out.

## Commands and results

Scope line for the fan-out: `Scope: 63 of 64 workspace projects` (the root `smithers@0.0.0` is excluded; all 63 members declare a `test` script; `codex-plugin` is not a workspace member, per `phase2-baseline.md` section 5).

### Full fan-out

```sh
cd <clean-checkout-4>
env -u SMITHERS_HOME corepack pnpm -r --no-bail --if-present run test
```

| Item | Value |
| --- | --- |
| Window | 12:00:08Z to 12:13:59Z (13 min 51 s) |
| Exit code | 1 |
| Summary line | `Summary: 2 fails, 61 passes` |
| Projects reported | 63 of 63: 61 `Done`, `examples` `Failed`, `packages/build-cli` `Failed` |
| Failing tests | 5: `examples` example 12 (`You have no credits remaining`); `packages/build-cli` three `Docker package execution` tests (`docker daemon did not answer "docker info"`) and `plans a typed Mise refusal from the declared config when mise is absent` (`argv[2]: /opt/homebrew/bin/mise`) |
| Tests | 14,649 across 63 suites (54 vitest projects, 9 `bun test` projects): 14,620 passed, 5 failed, 24 skipped by their own gates (vitest 20: `database` 2, `harness` 1, `integrations` 7, `jj` 1, `migrate` 6, `testing` 2, `build-cli` 1; bun 4: `apps/tui` 3, `apps/review` 1) |
| Coverage | No package tripped a threshold; the log has no `ERROR: Coverage for` line |
| `apps/ui` | `1226 pass`, `0 fail`, `Ran 1226 tests across 149 files. [177.73s]`, `Done` |
| Watchdog | A sidecar polled every 15 s for a `bun test src` child in `apps/ui` older than 480 s (sample at 480 s, SIGTERM at 900 s); it never fired (`03-watchdog/watchdog.log` holds only the exit line) |
| Log | `unit-tests-logs/01-full-fanout.log` (2,482 lines), `01-full-fanout.meta`, `01-per-project.md` |

The fan-out ran under a host load average between 30 and 95 on 16 cores for its whole window. No test timed out and no suite failed for a load-related reason, which is consistent with the finite per-test budgets the vitest configs set (`testTimeout: 30_000` in `packages/engine/vitest.config.ts` and its siblings).

### Package-level runs

Every run started from its package directory after the fan-out had exited and with `env -u SMITHERS_HOME`.

| Package | Command | Exit | Result |
| --- | --- | --- | --- |
| `packages/build-cli` | `corepack pnpm run test` | 1 | `Test Files 1 failed \| 51 passed (52)`, `Tests 4 failed \| 816 passed \| 1 skipped (821)`, 77.08 s; the same four tests as the fan-out |
| `examples` | `env -u OPENAI_API_KEY corepack pnpm exec vitest run test/12-agent-live-smoke.test.ts --coverage.enabled=false` | 0 | `Test Files 1 skipped (1)`, `Tests 1 skipped (1)` |
| `examples` | `corepack pnpm exec vitest run test/12-agent-live-smoke.test.ts --coverage.enabled=false` (key present) | 1 | `Tests 1 failed (1)`, cause `Error: You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.` |
| `examples` | `corepack pnpm run test` | 1 | `Test Files 1 failed \| 33 passed (34)`, `Tests 1 failed \| 58 passed (59)`; the one failure is example 12; example 13 (local Ollama) passed inside the run |
| `e2e` | `corepack pnpm run test` (`vitest run ci/ harness/`) | 0 | `Test Files 8 passed (8)`, `Tests 40 passed (40)`, 5.76 s |
| `packages/cli` | `corepack pnpm run test` | 0 | `Test Files 36 passed (36)`, `Tests 626 passed (626)`, 87.60 s |
| `packages/engine-store` | `corepack pnpm run test` | 0 | `Test Files 102 passed (102)`, `Tests 821 passed (821)`, 43.05 s |
| `apps/ui` | `bun test src` | 0 | `1226 pass`, `0 fail`, `Ran 1226 tests across 149 files. [62.74s]` |

Logs: `unit-tests-logs/02-pkg-*.log` with a `.meta` file per run (exit code, start, end).

### Per-project results (fan-out)

| Project | Runner | Result | Tests |
| --- | --- | --- | --- |
| `apps/bug-worker` | bun test | Done | 22 passed, 0 failed (Ran 22 tests across 2 files. [1174.00ms]) |
| `apps/review` | bun test | Done | 569 passed, 0 failed, 1 skipped (Ran 570 tests across 69 files. [81.40s]) |
| `apps/server` | bun test | Done | 402 passed, 0 failed (Ran 402 tests across 16 files. [7.59s]) |
| `apps/shared` | bun test | Done | 120 passed, 0 failed (Ran 120 tests across 11 files. [1110.00ms]) |
| `apps/status-site` | bun test | Done | 24 passed, 0 failed (Ran 24 tests across 2 files. [89.00ms]) |
| `apps/tui` | bun test | Done | 26 passed, 0 failed, 3 skipped (Ran 29 tests across 7 files. [62.83s]) |
| `apps/ui` | bun test | Done | 1226 passed, 0 failed (Ran 1226 tests across 149 files. [177.73s]) |
| `e2e` | vitest | Done | 40 passed (40) |
| `examples` | vitest | Failed | 1 failed \| 58 passed (59) |
| `packages/agent` | vitest | Done | 428 passed (428) |
| `packages/artifacts` | vitest | Done | 161 passed (161) |
| `packages/build-cli` | vitest | Failed | 4 failed \| 816 passed \| 1 skipped (821) |
| `packages/build/infra` | vitest | Done | 45 passed (45) |
| `packages/build` | vitest | Done | 46 passed (46) |
| `packages/canonical` | vitest | Done | 101 passed (101) |
| `packages/capability` | vitest | Done | 176 passed (176) |
| `packages/chain` | vitest | Done | 206 passed (206) |
| `packages/cli` | vitest | Done | 626 passed (626) |
| `packages/control` | vitest | Done | 230 passed (230) |
| `packages/core` | vitest | Done | 104 passed (104) |
| `packages/create-app` | vitest | Done | 93 passed (93) |
| `packages/crypto` | vitest | Done | 22 passed (22) |
| `packages/database` | vitest | Done | 117 passed \| 2 skipped (119) |
| `packages/engine-store` | vitest | Done | 821 passed (821) |
| `packages/engine` | vitest | Done | 224 passed (224) |
| `packages/errors` | vitest | Done | 10 passed (10) |
| `packages/evals` | vitest | Done | 20 passed (20) |
| `packages/flow` | vitest | Done | 352 passed (352) |
| `packages/flows` | vitest | Done | 403 passed (403) |
| `packages/fs` | vitest | Done | 15 passed (15) |
| `packages/gateway` | vitest | Done | 94 passed (94) |
| `packages/harness` | vitest | Done | 1043 passed \| 1 skipped (1044) |
| `packages/integrations` | vitest | Done | 307 passed \| 7 skipped (314) |
| `packages/jj` | vitest | Done | 152 passed \| 1 skipped (153) |
| `packages/journal` | vitest | Done | 156 passed (156) |
| `packages/kernel` | vitest | Done | 433 passed (433) |
| `packages/keys` | vitest | Done | 25 passed (25) |
| `packages/mcp` | vitest | Done | 33 passed (33) |
| `packages/memory` | vitest | Done | 114 passed (114) |
| `packages/migrate` | vitest | Done | 374 passed \| 6 skipped (380) |
| `packages/model` | vitest | Done | 240 passed (240) |
| `packages/notifications` | vitest | Done | 53 passed (53) |
| `packages/observability` | vitest | Done | 28 passed (28) |
| `packages/patterns` | vitest | Done | 266 passed (266) |
| `packages/plan` | vitest | Done | 186 passed (186) |
| `packages/platform-browser` | vitest | Done | 70 passed (70) |
| `packages/platform-bun` | vitest | Done | 17 passed (17) |
| `packages/platform-node` | vitest | Done | 138 passed (138) |
| `packages/plugin` | vitest | Done | 50 passed (50) |
| `packages/registry` | vitest | Done | 319 passed (319) |
| `packages/run-store` | vitest | Done | 131 passed (131) |
| `packages/sandbox` | vitest | Done | 92 passed (92) |
| `packages/scorers` | vitest | Done | 9 passed (9) |
| `packages/smthrs-deprecation` | vitest | Done | 2 passed (2) |
| `packages/std` | vitest | Done | 283 passed (283) |
| `packages/step-cache` | vitest | Done | 75 passed (75) |
| `packages/sync` | vitest | Done | 205 passed (205) |
| `packages/targets` | vitest | Done | 769 passed (769) |
| `packages/testing` | vitest | Done | 123 passed \| 2 skipped (125) |
| `packages/time-travel` | vitest | Done | 312 passed (312) |
| `packages/triggers` | vitest | Done | 37 passed (37) |
| `packages/ui-styleguide` | bun test | Done | 55 passed, 0 failed (Ran 55 tests across 5 files. [160.00ms]) |
| `packages/ui` | bun test | Done | 926 passed, 0 failed (Ran 926 tests across 85 files. [14.60s]) |

Spot checks against the suites earlier baselines called load-sensitive, all inside a fan-out whose host load average exceeded 60: `packages/sync` 205/205 (`ServerSoak` included), `packages/engine-store` 821/821, `packages/engine` 224/224, `packages/run-store` 131/131, `packages/database` 117 passed and 2 skipped.

Live backends that ran instead of skipping: `packages/model` `test/GeminiChatCompletions.integration.test.ts` (`describe.skipIf(apiKey === undefined || apiKey === "")`) ran with `GEMINI_API_KEY` present and the package reports `240 passed (240)`; `examples/test/13-agent-live-smoke-local.test.ts` (`it.effect.skipIf(!pulled)` against `http://localhost:11434`) ran against the local Ollama daemon and the `examples` tally has no skipped test.

## Failure classification

### 1. `examples` `12-agent-live-smoke` (1 of 59): ENVIRONMENT, the OpenAI seat has zero credits

`test/12-agent-live-smoke.test.ts > runs the assembled agent stack against a real OpenAI seat` failed with `Error [/harness/HarnessError]: The cell frame failed`, `[cause]: Error: You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.` (`01-full-fanout.log` lines 1869 to 1909). Package result: `Test Files 1 failed \| 33 passed (34)`, `Tests 1 failed \| 58 passed (59)`.

Proof:

- The cause is the provider's billing response, quoted verbatim from the run log and reproduced by the package-level rerun with the key present (`02-pkg-ex12-key.log`). `phase2-baseline.md` section 2.1 records the same test failing with the same message and classifies it environmental.
- The test is gated on the key: `examples/test/12-agent-live-smoke.test.ts:5` `const hasKey = process.env.OPENAI_API_KEY !== undefined && process.env.OPENAI_API_KEY !== ""`, line 7 `it.effect.skipIf(!hasKey)`. Without the key the file exits 0 with `Tests 1 skipped (1)` (`02-pkg-ex12-nokey.log`).
- The other 58 tests in the package, including the live local-model smoke (example 13), pass.

### 2. `packages/build-cli` `Docker package execution` (3 of 821): ENVIRONMENT, no Docker daemon

`test/ChainExecution.test.ts:155` `describe.sequential("Docker package execution")`: `builds an OCI archive through CAS and restores it on a cache hit` (line 156), `acquires, exec-probes, initializes, and releases a Docker service` (line 177), `refuses an outward push before credentials or effects` (line 201). Each assertion output embeds the cause: `docker daemon did not answer "docker info": failed to connect to the docker API at unix:///Users/williamcory/.orbstack/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /Users/williamcory/.orbstack/run/docker.sock: connect: no such file or directory` (`01-full-fanout.log` lines 2344, 2360, and the `refusal:` field at line 2392). The third test's plan output shows `rule: Docker.Push`, `mode: execute`, and that `refusal` string where the test expects `approval required`; the refusal is the daemon probe, upstream of the approval check.

Proof: `docker info` on this host prints that same error and exits 1 (CLI installed, no daemon). The package-level rerun reproduces all three (`02-pkg-build-cli.log`). `phase2-baseline.md` section 2.1 and `phase3-validation.md` classify these three tests environmental for the same reason. The generated CI workflow runs them on ubuntu runners where a daemon exists.

### 3. `packages/build-cli` `plans a typed Mise refusal from the declared config when mise is absent` (1 of 821): ENVIRONMENT, `mise` is on this host's `PATH`

`test/ChainExecution.test.ts:228`. The test expects the plan to contain `host binary`, `mise`, and `not present on PATH` (line 255). The plan instead resolved the real binary: `argv[2]: /opt/homebrew/bin/mise,"--version"` (`01-full-fanout.log` line 2417).

Proof: `which mise` prints `/opt/homebrew/bin/mise`; `mise --version` prints `2026.8.14 macos-arm64 (2026-08-25)`. The fixture requires a host without `mise`; `.github/workflows/ci.yml` installs none, so the test is green in CI, and it passed in the Phase 2 baseline on this host before `mise` was installed. The package-level rerun reproduces it. Same finding as the superseded evidence.

Upstream nit, not gate-blocking: the fixture is not hermetic. Masking `mise` from `PATH` inside the fixture workspace would make it pass on any developer machine.

### No other failure

The remaining 61 projects report `Done` with zero failing tests in the fan-out, and the six package-level reruns of green suites (`e2e`, `packages/cli`, `packages/engine-store`, `apps/ui`, plus the trace runs of `packages/{control,flows,kernel,targets,gateway,agent}` below) report zero failing tests. No failure needed a credential other than the OpenAI seat, and none touched wrangler.

## Test hygiene observations, not gate-blocking

### Root `.flows/` written into the checkout

`<clean-checkout-4>/.flows/` existed before the fan-out started (created 04:59 PDT by a sibling lane's `smithers-build test '//scripts:browserContract'` run in this checkout; `packages/build-cli/src/PackageDiscovery.ts:271` defaults the cache directory to `.flows`). During the fan-out it gained `control.db` and `engine.db` (both at 05:02:55 PDT), `cache/f6/...json` (a `GithubCiGen` `//:ci` cache entry stored at 12:02:33Z) and later `cache/4a/...json` (another `//:ci` entry at 12:13:50Z) and `knip-22573cd5.json` (05:14 PDT, written by `packages/targets/src/DepsLint.ts:127`). The directory is git-ignored (`.gitignore:90`), so the tree stays clean.

The two databases hold migrations only: `control.db` has 21 tables (`control_*`, `flows_*`, `memory_*`) with `flows_migrations: 4` rows and every other table empty; `engine.db` has 13 tables with `flows_migrations: 8` rows and every other table empty. That is the shape of a process that opened the checkout-root project database pair and ran nothing.

A trace that deleted both databases and ran six candidate suites one at a time (`trace-flows.sh`, results in `04-trace-flows.tsv`) saw the pair reappear during `packages/flows` (403/403, 11 s), `packages/targets` (769/769, 22 s), and `packages/agent` (428/428, 42 s), only `control.db` during `packages/kernel` (433/433, 4 s), and neither during `packages/control` (230/230) or `packages/gateway` (94/94). The attribution is not proven: stale `control.db-wal` and `control.db-shm` sidecars were present between runs although the main file had been deleted, which means another process in this checkout opened the database during the trace window (sibling lanes run the working-tree `smithers` CLI from the checkout root, and `packages/cli/src/Project.ts` resolves `.flows` there). Re-run the trace in an idle checkout to name the suite. Candidates by source: `packages/agent/test/{AgentSession,ApprovalResumeAcrossCompositions,CompletedRunPersistsAcrossProcesses,EngineParkAcrossProcesses,FailedRunPersistsAcrossProcesses}.test.ts` name `control.db`/`engine.db` directly.

### pnpm and signals

`pnpm -r --no-bail run test` still aborts the fan-out when a script dies by signal (superseded evidence, Run 1). No signal was sent this time, so the behavior was not exercised; the watchdog design stays record-then-kill at 900 s for that reason.

## Verification commands

| Command | Exit | Result |
| --- | --- | --- |
| `env -u SMITHERS_HOME corepack pnpm -r --no-bail --if-present run test` | 1 | `Summary: 2 fails, 61 passes`; 63 of 63 reported; 13 min 51 s |
| `corepack pnpm run test` in `packages/build-cli` | 1 | `Tests 4 failed \| 816 passed \| 1 skipped (821)`; Docker x3, mise x1 |
| `env -u OPENAI_API_KEY corepack pnpm exec vitest run test/12-agent-live-smoke.test.ts --coverage.enabled=false` in `examples` | 0 | `Tests 1 skipped (1)` |
| `corepack pnpm exec vitest run test/12-agent-live-smoke.test.ts --coverage.enabled=false` in `examples` | 1 | `Tests 1 failed (1)`, `You have no credits remaining` |
| `corepack pnpm run test` in `examples` | 1 | `Tests 1 failed \| 58 passed (59)` |
| `corepack pnpm run test` in `e2e` | 0 | `Tests 40 passed (40)` |
| `corepack pnpm run test` in `packages/cli` | 0 | `Tests 626 passed (626)` |
| `corepack pnpm run test` in `packages/engine-store` | 0 | `Tests 821 passed (821)` |
| `bun test src` in `apps/ui` | 0 | `1226 pass`, `0 fail`, 62.74 s |
| `corepack pnpm run test` in `packages/{control,flows,kernel,targets,gateway,agent}` (trace) | 0 x 6 | 230, 403, 433, 769, 94, 428 passed; 0 failed |
| `docker info` | 1 | `failed to connect to the docker API at unix:///Users/williamcory/.orbstack/run/docker.sock` |
| `which mise && mise --version` | 0 | `/opt/homebrew/bin/mise`, `2026.8.14 macos-arm64 (2026-08-25)` |
| `git -C <clean-checkout-4> status --porcelain` after every run | 0 | empty; HEAD still `cd14388ed7` |

Raw logs and scripts in `unit-tests-logs/` beside this file: `01-full-fanout.log`, `01-full-fanout.meta`, `01-per-project.md`, `02-pkg-{build-cli,ex12-nokey,ex12-key,examples,e2e,cli,engine-store,apps-ui}.log` with `.meta`, `03-watchdog/`, `04-trace-flows.tsv`, `04-trace-{control,flows,kernel,targets,gateway,agent}.log`, `run-full.sh`, `watchdog.sh`, `run-pkg.sh`, `trace-flows.sh`, `parse.mjs`.

## Verdict

PASS. One complete fan-out over all 63 workspace projects at `cd14388ed7`: 61 pass, and the two that fail do so only on the five tests that require a funded OpenAI seat, a Docker daemon, or a `mise`-free `PATH`, each proven by the provider's own error text, the `docker info` probe, or the resolved binary path in the assertion output, and each already recorded environmental in the Phase 2 and Phase 3 baselines and in the superseded evidence. Package-level reruns reproduce the same five failures and nothing else. Suites that reach real backends ran against them and passed. The `apps/ui` stall seen once at `20b32c6316` did not recur under heavier load. The tree is unchanged after every run.

Follow-ups for other lanes, none gate-blocking: the non-hermetic `mise` fixture in `packages/build-cli`, and the suite that writes `.flows/{control.db,engine.db}` into the checkout root (trace narrowed to `packages/{flows,targets,agent}`, attribution unproven under concurrent lanes).
