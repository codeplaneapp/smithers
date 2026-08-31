# Phase 7 gate: unit-tests

Verdict: PASS

This file supersedes the 2026-08-30 16:06 evidence taken at `9c464343f0` in `migration/clean-checkout` (that directory no longer exists). Every command below ran in `migration/clean-checkout-2` at `20b32c6316`.

The full recursive fan-out completes from the clean checkout with `Summary: 2 fails, 61 passes` (Run 2, 63 of 63 projects, 11,545 tests). The five failing tests all need live external state the repository does not control: a funded OpenAI seat (`examples` example 12), a running Docker daemon (`packages/build-cli`, three tests), and a host without `mise` on PATH (`packages/build-cli`, one test). Each is proven environmental below and matches the Phase 2 and Phase 3 baselines. Every other suite passes at package level, including the real-backend ones that ran live here: Gemini (`packages/model`, 240/240), the local Ollama agent smoke (example 13), the e2e fault harness (40/40), and `packages/cli` (608/608). No product defect surfaced.

The first attempt at the fan-out (Run 1) did not finish: `apps/ui`'s `bun test src` stalled for 7 min 44 s with the Bun event loop idle, this gate terminated it, and pnpm aborted the remainder. The stall did not recur in five further whole-suite runs, including Run 2 under the identical command, nor in 149 per-file runs. It is recorded as an unreproduced runtime stall with a falsifiable follow-up, not as a blocker.

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2 (build 25C56), Darwin 25.2.0, arm64, 16 cores, 64 GB |
| Node | v24.18.0 (`/Users/williamcory/.nvm/versions/node/v24.18.0/bin/node`); rc-contract floor is `>=22.19.0` |
| corepack | 0.35.0, selecting pnpm from `packageManager: pnpm@11.21.0` |
| pnpm | 11.21.0 |
| Bun | 1.4.0-canary.1+6618e7f7e (`bun --version` prints `1.4.0`) |
| git | 2.50.1 (Apple Git-155) |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-2`, branch `v1/rc0-migration`, HEAD `20b32c6316487497301db74ec70cbe951428ef53`, submodule `vendor/jj` at `47589ada70`; `git status --porcelain` empty before the first run and after the last |
| Install state | The clean-install gate's frozen installs (`00-clean-install.md`); no package `dist/` existed when the first fan-out started, and no build step ran before or between the test runs |
| Date | 2026-08-31 06:58 to 07:27 UTC (2026-08-30 23:58 PT onward) |
| Shell env | `SMITHERS_HOME` unset for every invocation (`env -u SMITHERS_HOME`). `OPENAI_API_KEY` and `GEMINI_API_KEY` set, so the live-seat suites ran instead of skipping. `docker` CLI at `/usr/local/bin/docker`, daemon down. `mise` 2026.8.14 at `/opt/homebrew/bin/mise`. Ollama serving `qwen2.5:7b` at `http://localhost:11434` |
| Host load | Load averages 2.85 / 2.68 / 3.86 when the first fan-out started; 12.61 / 23.77 / 20.18 at 00:10 PT during it (a sibling lane's `pnpm -r run lint` fan-out started in this checkout at 00:08 PT and a `pnpm run start` for `apps/ui` in the source tree was running throughout); 3.93 / 13.66 / 17.57 at the start and 11.43 / 12.47 / 15.24 at the end for the second fan-out |

The `apps/ui` Electrobun devkit projection (`apps/ui/.hutch/devkit/projection.json`, product `electrobun 2.0.1`) existed by 00:02 PT, written by a sibling lane after the clean-install gate recorded it missing. `apps/ui`'s `test` script (`bun test src`) does not run `ensure-devkit.mjs`, so the projection is not an input to this gate.

## Commands and results

Scope line for every fan-out: `Scope: 63 of 64 workspace projects` (the root `smithers@0.0.0` is excluded; 62 members declare a `test` script and `codex-plugin` is not a workspace member).

### Run 1: full fan-out, terminated after an `apps/ui` stall

```sh
cd <clean-checkout-2>
env -u SMITHERS_HOME corepack pnpm -r --no-bail --if-present run test
```

| Item | Value |
| --- | --- |
| Window | 06:58:17Z to 07:12:07Z |
| Exit code | 143 (SIGTERM propagated from the child this gate terminated; pnpm printed no `Summary` line) |
| Projects reported | 60 of 63: 58 `Done`, `examples` `Failed`, `apps/ui` `Failed` |
| Projects never started | `packages/cli`, `packages/build-cli`, `e2e`. pnpm starts a project only after its workspace dependencies finish: `packages/cli` depends on `@smthrs/migrate`, whose `Done` is the line before the termination in the log, and `e2e` depends on `@smthrs/cli` |
| Log | `<scratchpad>/unit-tests-full.log` (1,983 lines) |

`apps/ui`'s `bun test src` (PID 80842) printed its version banner at about 00:04:40 PT and nothing else. At 07:12:07Z, after 7 min 44 s, it was at 0.0% CPU, state `S`, with no child processes; its main thread was parked in `kevent64` (the Bun event loop waiting for I/O) with every `Bun Pool` thread in `__ulock_wait2`; it held three `/dev/ptmx` masters and `/dev/ttys006`, which no other process held. This gate sent it SIGTERM (`kill -TERM 80842`, that PID only). pnpm recorded `apps/ui test: Failed` and exited 143 without running `packages/cli`, `packages/build-cli`, or `e2e`: with `--no-bail`, pnpm still aborts the fan-out when a script dies by signal. `packages/build-cli`, `e2e`, and `apps/ui` were then run at package level (below), and the whole fan-out was repeated (Run 2), which covers `packages/cli` (608 passed).

Bun's own timeouts rule out a JavaScript-level wait as the mechanism. A probe in the scratchpad (`bun-hook-probe/`) confirms that Bun 1.4.0-canary.1 fails a never-resolving test body after 5,000 ms and a never-resolving `afterAll` hook after 5,000 ms, and `apps/ui/src/bun/Pty.ts` bounds every kill path (`killGraceMs` 300 ms plus a 1,000 ms race). The stall therefore sat below the test runner, in the runtime's event loop, with PTY descriptors from `Bun.spawn({ terminal })` still open.

### Run 2: full fan-out, complete

Same command, same checkout, started 07:19:47Z after every package-level run above had finished and the checkout was idle (no vitest, bun, or pnpm process had `<clean-checkout-2>` as its working directory). A watchdog polled every 15 s for a `bun test src` child of this fan-out in `apps/ui` older than 480 s; it never fired.

| Item | Value |
| --- | --- |
| Window | 07:19:47Z to 07:26:49Z (7 min 2 s) |
| Exit code | 1 |
| Summary line | `Summary: 2 fails, 61 passes` |
| Projects reported | 63 of 63: 61 `Done`, `examples` `Failed`, `packages/build-cli` `Failed` |
| Failing tests | The same five as the package-level runs: `examples` example 12 (`You have no credits remaining`), `packages/build-cli` three Docker tests (`docker daemon did not answer "docker info"`) and the Mise refusal test (`argv[2]: /opt/homebrew/bin/mise`) |
| `apps/ui` | `1224 pass`, `0 fail`, `Ran 1224 tests across 149 files. [48.63s]`, `Done` |
| Tests executed | 11,545 across the 62 suites (53 vitest projects, 9 `bun test` projects), 5 failed, 20 skipped by their own gates |
| Load averages | 3.93 / 13.66 / 17.57 at start, 11.43 / 12.47 / 15.24 at end |
| Log | `<scratchpad>/unit-tests-full-2.log` (2,482 lines) |

Run 2 is the complete reading for this gate. Its two failing projects and five failing tests are the ones `docs/migration/phase2-baseline.md` section 2.1 and `phase3-validation.md` already classify environmental (`Summary: 2 fails, 55 passes` and `2 fails, 56 passes` there; the project count grew to 63 with `e2e`, `packages/cli`, and the other rc.0 members).

### Package-level runs for the suites Run 1 never finished

All three ran from their package directories with `env -u SMITHERS_HOME`.

| Package | Command | Exit | Result |
| --- | --- | --- | --- |
| `packages/build-cli` | `corepack pnpm run test` (vitest, coverage on) | 1 | `Test Files 1 failed \| 51 passed (52)`, `Tests 4 failed \| 816 passed \| 1 skipped (821)`, 107.72 s. All four failures are environmental (classification 2 and 3 below) |
| `e2e` | `corepack pnpm run test` (`vitest run ci/ harness/`) | 0 | `Test Files 8 passed (8)`, `Tests 40 passed (40)`, 7.84 s |
| `apps/ui` | `bun test src` (300 s cap) | 0 | `1224 pass`, `0 fail`, `Ran 1224 tests across 149 files. [90.59s]` |
| `apps/ui` | `bun test <file>` for each of the 149 test files, 90 s cap each (`ui-perfile.tsv`) | 0 for all 149 | 1,224 passed, 0 failed; slowest file `src/bun/TargetGraph.integration.test.ts` at 24.76 s; `src/bun/Pty.test.ts` 9 passed in 0.37 s |
| `apps/ui` | `bun test src` three more times with a 240 s stall watchdog (`ui-repeat.tsv`) | 0, 0, 0 | `1224 pass` each time in 43.76 s, 39.80 s, 40.22 s; the watchdog never fired |

### Per-project results

Run 2 tallies (the complete fan-out) for all 62 suites. Run 1's tallies for the 60 projects it reported are identical test for test; `unit-tests-full.log` holds them.

| Project | Runner | Result | Tests |
| --- | --- | --- | --- |
| `apps/bug-worker` | bun test | Done | 22 passed, 0 failed (22 tests across 2 files, 240.00ms) |
| `apps/review` | bun test | Done | 569 passed, 0 failed (570 tests across 69 files, 29.27s) |
| `apps/server` | bun test | Done | 402 passed, 0 failed (402 tests across 16 files, 4.56s) |
| `apps/shared` | bun test | Done | 120 passed, 0 failed (120 tests across 11 files, 138.00ms) |
| `apps/status-site` | bun test | Done | 24 passed, 0 failed (24 tests across 2 files, 19.00ms) |
| `apps/tui` | bun test | Done | 26 passed, 0 failed (29 tests across 7 files, 61.63s) |
| `apps/ui` | bun test | Done | 1224 passed, 0 failed (1224 tests across 149 files, 48.63s) |
| `examples` | vitest | Failed | 1 failed | 58 passed (59) |
| `packages/agent` | vitest | Done | 422 passed (422) |
| `packages/artifacts` | vitest | Done | 161 passed (161) |
| `packages/build-cli` | vitest | Failed | 4 failed | 816 passed | 1 skipped (821) |
| `packages/build/infra` | vitest | Done | 45 passed (45) |
| `packages/build` | vitest | Done | 46 passed (46) |
| `packages/canonical` | vitest | Done | 101 passed (101) |
| `packages/capability` | vitest | Done | 176 passed (176) |
| `packages/chain` | vitest | Done | 206 passed (206) |
| `packages/cli` | vitest | Done | 608 passed (608) |
| `packages/control` | vitest | Done | 229 passed (229) |
| `packages/core` | vitest | Done | 104 passed (104) |
| `packages/create-app` | vitest | Done | 93 passed (93) |
| `packages/crypto` | vitest | Done | 22 passed (22) |
| `packages/database` | vitest | Done | 117 passed | 2 skipped (119) |
| `packages/engine-store` | vitest | Done | 799 passed (799) |
| `packages/engine` | vitest | Done | 224 passed (224) |
| `packages/errors` | vitest | Done | 10 passed (10) |
| `packages/evals` | vitest | Done | 20 passed (20) |
| `packages/flow` | vitest | Done | 352 passed (352) |
| `packages/flows` | vitest | Done | 403 passed (403) |
| `packages/fs` | vitest | Done | 15 passed (15) |
| `packages/gateway` | vitest | Done | 94 passed (94) |
| `packages/harness` | vitest | Done | 1043 passed | 1 skipped (1044) |
| `packages/integrations` | vitest | Done | 307 passed | 7 skipped (314) |
| `packages/jj` | vitest | Done | 152 passed | 1 skipped (153) |
| `packages/journal` | vitest | Done | 156 passed (156) |
| `packages/kernel` | vitest | Done | 433 passed (433) |
| `packages/keys` | vitest | Done | 25 passed (25) |
| `packages/mcp` | vitest | Done | 33 passed (33) |
| `packages/memory` | vitest | Done | 114 passed (114) |
| `packages/migrate` | vitest | Done | 374 passed | 6 skipped (380) |
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
| `packages/testing` | vitest | Done | 123 passed | 2 skipped (125) |
| `packages/time-travel` | vitest | Done | 312 passed (312) |
| `packages/triggers` | vitest | Done | 37 passed (37) |
| `packages/ui-styleguide` | bun test | Done | 55 passed, 0 failed (55 tests across 5 files, 103.00ms) |
| `packages/ui` | bun test | Done | 926 passed, 0 failed (926 tests across 85 files, 9.72s) |

Spot checks against the suites earlier baselines called load-sensitive: `packages/sync` 205/205 (ServerSoak included), `packages/engine-store` 799/799, `packages/engine` 224/224, `packages/run-store` 131/131, `packages/database` 117 passed, 2 skipped. No package tripped a coverage threshold; the log has no `ERROR: Coverage for` line.

Live backends that ran instead of skipping: `packages/model` `test/GeminiChatCompletions.integration.test.ts` ran with the key present and passed (`Test Files 21 passed (21)`, `Tests 240 passed (240)`; the superseded evidence saw HTTP 429 from an exhausted free-tier window, which had reset). `examples/test/13-agent-live-smoke-local.test.ts` ran against the local Ollama daemon and passed inside the fan-out (the `examples` tally has no skipped test) and again alone with the verbose reporter: `✓ answers a question through the local agent stack, and decodes every time 20666ms`, `Tests 1 passed (1)`.

## Failure classification

### 1. `examples` `12-agent-live-smoke` (1 of 59): ENVIRONMENT, OpenAI seat has zero credits

`test/12-agent-live-smoke.test.ts > runs the assembled agent stack against a real OpenAI seat` failed with `/harness/HarnessError: The cell frame failed`, `Caused by: Error: You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.` Package result: `Test Files 1 failed | 33 passed (34)`, `Tests 1 failed | 58 passed (59)`.

Proof:

- The cause is the provider's billing response, quoted verbatim above from the run log. `docs/migration/phase2-baseline.md` section 2.1 records the same test failing with the same message and classifies it environmental.
- The test is gated on the key: `const hasKey = process.env.OPENAI_API_KEY !== undefined && ...`, `it.effect.skipIf(!hasKey)`. Re-run without it, `env -u SMITHERS_HOME -u OPENAI_API_KEY corepack pnpm exec vitest run test/12-agent-live-smoke.test.ts --coverage.enabled=false` in `examples`, exits 0 with `Tests 1 skipped (1)`.
- The other 58 tests in the package, including the live local-model smoke (example 13), pass.

### 2. `packages/build-cli` `Docker package execution` (3 of 821): ENVIRONMENT, no Docker daemon

`builds an OCI archive through CAS and restores it on a cache hit`, `acquires, exec-probes, initializes, and releases a Docker service`, `refuses an outward push before credentials or effects`. Each assertion output embeds the cause: `docker daemon did not answer "docker info": failed to connect to the docker API at unix:///Users/williamcory/.orbstack/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /Users/williamcory/.orbstack/run/docker.sock: connect: no such file or directory`.

Proof: `docker info` on this host prints that same error and exits 1 (CLI installed, no daemon). `phase2-baseline.md` section 2.1 classifies these three tests environmental for the same reason. The generated CI workflow runs them on ubuntu runners where a daemon exists.

### 3. `packages/build-cli` `plans a typed Mise refusal from the declared config when mise is absent` (1 of 821): ENVIRONMENT, `mise` is on this host's PATH

The test expects the plan to contain `host binary`, `mise`, and `not present on PATH`. The plan instead resolved the real binary: `argv[2]: /opt/homebrew/bin/mise,"--version"` (`test/ChainExecution.test.ts:253`).

Proof: `which mise` prints `/opt/homebrew/bin/mise`; `mise --version` prints `2026.8.14 macos-arm64 (2026-08-25)`. The fixture requires a host without `mise`; `.github/workflows/ci.yml` installs none, so the test is green in CI, and it passed in the Phase 2 baseline on this host before `mise` was installed. Same finding as the superseded evidence.

Upstream nit, not gate-blocking: the fixture is not hermetic. Masking `mise` from `PATH` inside the fixture workspace would make it pass on any developer machine.

### 4. `apps/ui` `bun test src` stall in Run 1: NOT A PRODUCT DEFECT ON THE EVIDENCE; a nondeterministic runtime stall, observed 1 time in 6 whole-suite runs, root cause unproven

Observed once, in Run 1, under the conditions recorded above (host load average above 20 on 16 cores, three sibling pnpm test children, a concurrent lint fan-out in the same checkout). Not a credential, Docker, or wrangler dependency: `apps/ui`'s suite reaches no external service. Not reproduced in any of the five subsequent whole-suite runs (four standalone `bun test src` runs and Run 2 under the gate's own command), and none of the 149 files fails or stalls alone. Bun's 5 s test and hook timeouts, verified live, did not fire, which places the wait inside the runtime rather than in test code.

Falsifiable follow-up for the owner of `apps/ui`: run `bun test src` under load with `--timeout` unchanged and a 10-minute external watchdog that captures `sample <pid>` and `lsof -p <pid>`; a recurrence with PTY descriptors open and the main thread in `kevent64` after `src/bun/Pty.test.ts` has finished implicates `Bun.spawn({ terminal })` teardown in Bun 1.4.0-canary.1, which is the pinned toolchain (rc-contract section 9 pins CI Bun at `1.3.14`, so a CI run on the pinned version is the other half of the check).

## Test hygiene observations, not gate-blocking

- A suite in the fan-out created `<clean-checkout-2>/.flows/` at the repository root (`control.db`, `engine.db`, `cache/`) at 00:00 PT, two minutes into Run 1. The directory is git-ignored so the tree stays clean, but a unit suite writing engine state into the checkout root rather than a temp directory is a hygiene defect to trace (candidates: the `packages/cli` suites, whose `Project.ts`, `Init.ts`, and `NodeControl.ts` resolve `.flows`).
- `pnpm -r --no-bail run test` does not survive a signal-terminated script: Run 1 lost `packages/cli`, `packages/build-cli`, and `e2e`. Any future watchdog should record and let the fan-out finish, or expect to re-run the remainder.

## Verification commands

| Command | Exit | Result |
| --- | --- | --- |
| `env -u SMITHERS_HOME corepack pnpm -r --no-bail --if-present run test` (Run 1) | 143 | 60 of 63 reported; `apps/ui` terminated by this gate after a 7 min 44 s stall |
| `env -u SMITHERS_HOME corepack pnpm -r --no-bail --if-present run test` (Run 2) | 1 | `Summary: 2 fails, 61 passes`; 63 of 63 reported; `apps/ui` `Done` in 48.63 s |
| `corepack pnpm run test` in `packages/build-cli` | 1 | `Tests 4 failed \| 816 passed \| 1 skipped (821)`; Docker x3, mise x1 |
| `corepack pnpm run test` in `e2e` | 0 | `Tests 40 passed (40)` |
| `bun test src` in `apps/ui`, four whole runs | 0, 0, 0, 0 | `1224 pass, 0 fail` each |
| `bun test <file>` in `apps/ui`, 149 files | 0 x 149 | 1,224 passed, 0 failed |
| `env -u OPENAI_API_KEY corepack pnpm exec vitest run test/12-agent-live-smoke.test.ts --coverage.enabled=false` in `examples` | 0 | `Tests 1 skipped (1)` |
| `corepack pnpm exec vitest run test/13-agent-live-smoke-local.test.ts --reporter=verbose --coverage.enabled=false` in `examples` | 0 | `Tests 1 passed (1)`, 20.7 s against Ollama `qwen2.5:7b` |
| `docker info` | 1 | `failed to connect to the docker API at unix:///Users/williamcory/.orbstack/run/docker.sock` |
| `which mise && mise --version` | 0 | `/opt/homebrew/bin/mise`, `2026.8.14 macos-arm64` |
| `bun test hang.test.ts` / `bun test hangtest.test.ts` (scratchpad probes) | 1, 1 | `a beforeEach/afterEach hook timed out` after 5.01 s; `this test timed out after 5000ms` |
| `git -C <clean-checkout-2> status --porcelain` after every run | 0 | empty; HEAD still `20b32c6316` |

Supporting files in `/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/`: `unit-tests-full.log`, `unit-tests-full.exit`, `unit-tests-full.time`, `apps-ui-hang-kill.log`, `bun-80842.sample`, `unit-tests-full-2.log`, `unit-tests-full-2.exit`, `unit-tests-full-2.time`, `unit-tests-full-2.load`, `remaining-packages-build-cli.log`, `remaining-e2e.log`, `ui-whole.log`, `ui-perfile.tsv`, `ui-repeat.tsv`, `ui-repeat-{1,2,3}.log`, `verify-ex12-nokey.log`, `verify-ex13.log`, `bun-hook-probe/`.

## Verdict

PASS. Run 2 is a complete fan-out over all 63 workspace projects: 61 pass, and the two that fail do so only on the five tests that require a funded OpenAI seat, a Docker daemon, or a `mise`-free PATH, each proven by the provider's own error text, the `docker info` probe, or the resolved binary path in the assertion output, and each already recorded environmental in the Phase 2 and Phase 3 baselines. Suites that reach real backends ran against them and passed. The tree is unchanged at `20b32c6316` after every run.

Follow-ups for other lanes, none gate-blocking: the unreproduced `apps/ui` runtime stall (section 4, with the recurrence check to run), the non-hermetic `mise` fixture in `packages/build-cli`, the suite that writes `.flows/` into the checkout root, and pnpm's abort-on-signal behavior under `--no-bail`.
