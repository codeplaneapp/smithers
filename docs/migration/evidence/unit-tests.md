# Phase 7 gate: unit-tests

Verdict: PASS

This file supersedes the 2026-08-31 12:00 UTC evidence taken at `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba` in this same checkout. The superseded file is kept beside this one as `unit-tests-prev-cd14388ed7.md` and its logs as `unit-tests-logs-prev-cd14388ed7/`. Every command below ran in `migration/clean-checkout-4` at `341c8fa87e2dadbe80d0f0d3258dae112a7d03d3`, the wave 7 and wave 8 head.

The full recursive fan-out completes from the clean checkout in one attempt with `Summary: 3 fails, 60 passes` (63 of 63 workspace projects, 14,745 tests: 14,713 passed, 7 failed, 25 skipped by their own gates). All seven failing tests are environmental, proven from the provider's or host's own responses: a funded OpenAI seat (`examples` example 12, `You have no credits remaining`), a running Docker daemon (`packages/build-cli`, three tests), a host without `mise` on `PATH` (`packages/build-cli`, one test), and, new since the superseded run, the Gemini free-tier daily quota (`packages/model`, two tests, HTTP 429; a direct probe of the same endpoint returns `RESOURCE_EXHAUSTED` with quotaId `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, limit 20, exhausted). The first three groups are the same five tests the superseded evidence, `docs/migration/phase2-baseline.md` section 2.1, and `docs/migration/phase3-validation.md` classify environmental. Every surface the delta commits touched is green: `packages/cli` 716 passed (refuse-before-boot and init-scaffold-launch tests included), `packages/control` 232, `packages/agent` 429, `packages/integrations` 309 passed (ReadmeCommands included), and `smithers-build test '//scripts/...'` reports 22 targets, 0 failed, with `//scripts:docsUnit`, `//scripts:npmDedupe`, `//scripts:releasePack`, and `//scripts:releaseSmoke` all run and green on the built tree. No product defect surfaced.

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2, Darwin 25.2.0, arm64, 16 cores, 64 GiB |
| Node | v24.18.0; rc-contract section 1 floor is `>=22.19.0`, CI pins 22.19.0 |
| corepack | 0.35.0, selecting pnpm from `packageManager: pnpm@11.21.0` |
| pnpm | 11.21.0 |
| Bun | 1.4.0 (`bun --version`); CI pins 1.3.14 |
| git | 2.50.1 (Apple Git-155) |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4`, HEAD `341c8fa87e2dadbe80d0f0d3258dae112a7d03d3`, submodule `vendor/jj` at `47589ada70`; `git status --porcelain` empty before the fan-out and after every run |
| Install state | The clean-install gate's frozen offline installs at this HEAD. No package `dist/` existed when the test fan-out started (`ls -d packages/*/dist` matched nothing) and the build fan-out ran only after all tests had finished, so tests ran from source exactly as in the superseded run. The `apps/ui` Electrobun devkit projection (`apps/ui/.hutch/devkit/`, electrobun 2.0.1, gitignored) is present, copied from `/Users/williamcory/smithers/apps/ui/.hutch/devkit` by the setup step because `electrobun prepare` blocks on the hutch lock another session holds; `projection.json` `product.version` 2.0.1 equals the installed electrobun 2.0.1, so `ensure-devkit.mjs` is a no-op |
| Date | 2026-08-31 16:18 to 16:41 UTC (09:18 to 09:41 PDT) |
| Shell env | `SMITHERS_HOME` unset and stripped from every invocation (`env -u SMITHERS_HOME`). `OPENAI_API_KEY` and `GEMINI_API_KEY` set, so the live-seat suites ran instead of skipping. `ANTHROPIC_API_KEY` and `GOOGLE_API_KEY` unset. `docker` CLI 29.4.0 (orbstack context), daemon down (`docker info` exit 1). `mise` 2026.8.14 at `/opt/homebrew/bin/mise`. Ollama serving `qwen2.5:7b` at `http://localhost:11434` |
| Host load | 11.49 / 6.44 / 6.03 when the test fan-out started, 11.39 / 23.27 / 17.20 when it ended; 2.14 / 6.47 / 10.85 when the `//scripts/...` run (and `//scripts:docsUnit` inside it) started, satisfying the under-40 requirement for the spawn-bound docs suite. The source tree's `electrobun dev` (`/Users/williamcory/smithers/apps/ui`, pids 33164/33196/33202, running since 00:44 PDT) held the hutch lock throughout |

## Delta since the superseded evidence

`cd14388ed7..341c8fa87e` is 15 commits, 75 files, +6,924/-2,807: the D4/D5 contract citations (`f63809382b`), the release-artifact refresh (`0156f2458e`), wave 7 (`docs-served-llms`, `cli-refuse-before-boot`), wave 8 (`polish-2`, `init-scaffold-launch`), and the release-notes pointer commit (`341c8fa87e`). Test files changed: `packages/agent/test/{AgentSession,AgentSessionFailures}.test.ts`, `packages/cli/test/{Bin,EndToEnd,Init,Unsupported}.test.ts`, `packages/control/test/{ControlContract,ControlLiveList}.test.*`, `packages/integrations/test/ReadmeCommands.test.ts`, `scripts/{check-llms,docs-contract,pack-release}.test.mjs`. The per-project tallies moved accordingly: `packages/cli` 626 to 716 passed plus 1 new skipped (717), `packages/control` 230 to 232, `packages/agent` 428 to 429, `packages/integrations` 307 to 309 passed (316). Every added test passes. The `scripts/*.test.mjs` files run under `//scripts/...` below, not in the fan-out.

## Commands and results

Scope line for both fan-outs: `Scope: 63 of 64 workspace projects` (the root `smithers@0.0.0` is excluded; all 63 members declare a `test` script).

### Full test fan-out

```sh
cd <clean-checkout-4>
env -u SMITHERS_HOME corepack pnpm -r --no-bail --if-present run test
```

| Item | Value |
| --- | --- |
| Window | 16:18:42Z to 16:28:07Z (9 min 25 s) |
| Exit code | 1 |
| Summary line | `Summary: 3 fails, 60 passes` |
| Projects reported | 63 of 63: 60 `Done`; `packages/model`, `examples`, `packages/build-cli` `Failed` |
| Failing tests | 7: `packages/model` two `GeminiChatCompletions.integration` streams (`HTTP 429`); `examples` example 12 (`You have no credits remaining`); `packages/build-cli` three `Docker package execution` tests (`docker daemon did not answer "docker info"`) and `plans a typed Mise refusal from the declared config when mise is absent` (`argv[2]: /opt/homebrew/bin/mise`) |
| Tests | 14,745 across 63 suites (54 vitest projects, 9 `bun test` projects): 14,713 passed, 7 failed, 25 skipped by their own gates (vitest 21: `database` 2, `harness` 1, `integrations` 7, `jj` 1, `migrate` 6, `testing` 2, `build-cli` 1, `cli` 1; bun 4: `apps/tui` 3, `apps/review` 1) |
| Coverage | No package tripped a threshold; the log has no `ERROR: Coverage for` line |
| `apps/ui` | `1226 pass`, `0 fail`, `Ran 1226 tests across 149 files. [88.80s]`, `Done`; the stall recorded once at `20b32c6316` did not recur |
| Log | `unit-tests-logs/01-full-fanout.log` (2,491 lines), `01-full-fanout.meta`, `01-per-project.md` |

### Package-level runs

Every run started from its package directory after the fan-out had exited, with `env -u SMITHERS_HOME`.

| Package | Command | Exit | Result |
| --- | --- | --- | --- |
| `packages/model` | `corepack pnpm exec vitest run test/GeminiChatCompletions.integration.test.ts --coverage.enabled=false` (key present) | 1 | `Tests 2 failed \| 1 passed (3)`, both `HTTP 429`; reproduces the fan-out |
| `packages/model` | same, `env -u GEMINI_API_KEY` | 0 | `Test Files 1 skipped (1)`, `Tests 3 skipped (3)` |
| `examples` | `env -u OPENAI_API_KEY corepack pnpm exec vitest run test/12-agent-live-smoke.test.ts --coverage.enabled=false` | 0 | `Tests 1 skipped (1)` |
| `examples` | same with the key present | 1 | `Tests 1 failed (1)`, cause `Error: You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.` |
| `packages/build-cli` | `corepack pnpm run test` | 1 | `Test Files 1 failed \| 51 passed (52)`, `Tests 4 failed \| 816 passed \| 1 skipped (821)`; the same four tests as the fan-out |

Logs: `unit-tests-logs/02-pkg-*.log` (exit code and timestamps inline) and `02-gemini-curl-probe.log`.

### Build fan-out and the scripts targets

```sh
env -u SMITHERS_HOME corepack pnpm -r --if-present run build          # 16:31:38Z, exit 143 (below)
env -u SMITHERS_HOME corepack pnpm exec smithers-build test '//scripts/...'   # 16:37:25Z, exit 0
```

The build fan-out ran 16:31:38Z to 16:34:15Z and printed `build: Done` for 48 projects. `apps/ui`'s `build:web` (vite) completed (`✓ built in 676ms`) and its `electrobun build` child (pid 52019) then received a SIGTERM from outside this session at 16:34:15Z (`sh: line 1: 52019 Terminated: 15 electrobun build`), which failed `apps/ui build` with exit 143 and ended the run. A controlled 120-second probe afterwards (`03-electrobun-build-probe.log`) reran `electrobun build` in `apps/ui` and sampled it every 15 s: the `electrobun.cjs`/`hutch-engine` pair sat at 0.0% CPU with zero output for the full 120 s, the documented hang on the hutch global lock that the source tree's live `electrobun dev` holds; the probe SIGKILLed it and the one leftover `hutch-engine` child (pid 53725) was killed by hand. This is the environment condition the gate instructions name, recorded, not a product defect; the native `apps/ui` bundle is not an input to any `//scripts/...` target.

Of the 50 projects that declare a `build` script, 48 built in the fan-out, `apps/ui` failed as above, and `packages/cli`'s queued build was cancelled by pnpm's fail-fast. `packages/cli/dist` already existed, created at 16:22:25Z by its own test suite during the test fan-out. To close the gap, `corepack pnpm run build` in `packages/cli` ran afterwards (exit 0, `03-build-cli-pkg.log`) and the rebuilt `dist` tree is byte-identical to what the tests had produced (aggregate md5 `ae0ca6814dee7acdd92012a7883c8db3` before and after), so the scripts targets below packed and smoked exactly what a fresh build produces.

The scripts run completed in 57.3 s at host load 2.14: `22 targets: 0 hit, 22 ran, 0 failed, 0 skipped`, including `//scripts:docsUnit` (32.7 s, the twelve docs `node --test` suites with the new `docs-deploy` and served-llms tests), `//scripts:npmDedupe` (6.3 s), `//scripts:npmDedupeUnit` (9.4 s), `//scripts:releasePack` (24.5 s, packs every publishable package into `dist/release-packs`), `//scripts:releaseSmoke` (23.9 s, installs the packed tarballs into a scratch project and imports every entry point ESM and CJS, which covers the wave 8 `dist/cjs/package.json` and memory `.sql` packing fixes), `//scripts:browserContract` (the relocated `scripts/browser-contract.mjs` list, 28 browser entry points), `//scripts:docs`, `//scripts:llms`, and the five `//scripts/repo-contract:*` suites. Log: `04-scripts-targets.log`, `04-scripts-targets.meta`.

### Per-project results (test fan-out)

| Project | Runner | Result | Tests |
| --- | --- | --- | --- |
| `apps/bug-worker` | bun test | Done | 22 passed, 0 failed (Ran 22 tests across 2 files. [625.00ms]) |
| `apps/review` | bun test | Done | 569 passed, 0 failed, 1 skipped (Ran 570 tests across 69 files. [42.37s]) |
| `apps/server` | bun test | Done | 402 passed, 0 failed (Ran 402 tests across 16 files. [5.93s]) |
| `apps/shared` | bun test | Done | 120 passed, 0 failed (Ran 120 tests across 11 files. [255.00ms]) |
| `apps/status-site` | bun test | Done | 24 passed, 0 failed (Ran 24 tests across 2 files. [28.00ms]) |
| `apps/tui` | bun test | Done | 26 passed, 0 failed, 3 skipped (Ran 29 tests across 7 files. [61.90s]) |
| `apps/ui` | bun test | Done | 1226 passed, 0 failed (Ran 1226 tests across 149 files. [88.80s]) |
| `e2e` | vitest | Done | 40 passed (40) |
| `examples` | vitest | Failed | 1 failed \| 58 passed (59) |
| `packages/agent` | vitest | Done | 429 passed (429) |
| `packages/artifacts` | vitest | Done | 161 passed (161) |
| `packages/build-cli` | vitest | Failed | 4 failed \| 816 passed \| 1 skipped (821) |
| `packages/build/infra` | vitest | Done | 45 passed (45) |
| `packages/build` | vitest | Done | 46 passed (46) |
| `packages/canonical` | vitest | Done | 101 passed (101) |
| `packages/capability` | vitest | Done | 176 passed (176) |
| `packages/chain` | vitest | Done | 206 passed (206) |
| `packages/cli` | vitest | Done | 716 passed \| 1 skipped (717) |
| `packages/control` | vitest | Done | 232 passed (232) |
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
| `packages/integrations` | vitest | Done | 309 passed \| 7 skipped (316) |
| `packages/jj` | vitest | Done | 152 passed \| 1 skipped (153) |
| `packages/journal` | vitest | Done | 156 passed (156) |
| `packages/kernel` | vitest | Done | 433 passed (433) |
| `packages/keys` | vitest | Done | 25 passed (25) |
| `packages/mcp` | vitest | Done | 33 passed (33) |
| `packages/memory` | vitest | Done | 114 passed (114) |
| `packages/migrate` | vitest | Done | 374 passed \| 6 skipped (380) |
| `packages/model` | vitest | Failed | 2 failed \| 238 passed (240) |
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
| `packages/ui-styleguide` | bun test | Done | 55 passed, 0 failed (Ran 55 tests across 5 files. [120.00ms]) |
| `packages/ui` | bun test | Done | 926 passed, 0 failed (Ran 926 tests across 85 files. [11.48s]) |

Live backends that ran instead of skipping: `examples/test/13-agent-live-smoke-local.test.ts` against the local Ollama daemon (the `examples` tally has no skipped test), and `packages/model`'s Gemini suite ran with the key present, which is exactly why its quota failure surfaced. The load-sensitive suites earlier baselines named all passed: `packages/sync` 205/205 (`ServerSoak` included), `packages/engine-store` 821/821, `packages/engine` 224/224, `packages/run-store` 131/131.

## Failure classification

### 1. `packages/model` `GeminiChatCompletions.integration` (2 of 240): ENVIRONMENT, the Gemini free-tier daily quota is exhausted

`test/GeminiChatCompletions.integration.test.ts > OpenAIChatCompletions over Gemini > streams a short completion` and `> streams a tool call with reassembled arguments` failed with `flows/model/ModelError: Chat Completions request failed with HTTP 429` from `src/RequestExecutor.ts:504` (`01-full-fanout.log` lines 1286 to 1311). New relative to the superseded evidence, where the same suite passed 240/240.

Proof:

- The suite is key-gated: `describe.skipIf(apiKey === undefined || apiKey === "")` at line 51 on `GEMINI_API_KEY`; without the key the file skips (`02-pkg-model-gemini-nokey.log`, `Tests 3 skipped (3)`, exit 0). With the key the package-level rerun reproduces both failures (`02-pkg-model-gemini-key.log`).
- A direct probe of the identical endpoint the route builds (`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`, model `gemini-3-flash-preview`) at 16:29:04Z returned `HTTP 429` with status `RESOURCE_EXHAUSTED`: `Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3-flash`, quotaId `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, quotaValue `20` (`02-gemini-curl-probe.log`). The seat's 20-requests-per-day free-tier quota for this model is spent; other sessions share this machine and this key. This is the provider refusing by quota, the same class as the OpenAI credits failure below.
- The suite's own retry helper (lines 37 to 49) anticipates exactly this: "The free tier can answer 429 when two suite runs share a quota window." A per-day exhaustion still fails after its single retry.

Upstream nit, not gate-blocking: the retry helper never fired here (both tests failed in under 2.4 s, below the 55 to 70 s retry delay) because it matches `exceeded your current quota` or `retry in Ns` in the error message, and the surfaced `ModelError` message is the generic `Chat Completions request failed with HTTP 429` without the provider text. The compat endpoint wraps its error body in a JSON array (`[{"error":{...}}]`, see the probe log), which the executor's classifier appears not to parse into `classifiedMessage`. Worth a look in `packages/model/src/RequestExecutor.ts`; it would not have changed this verdict, since the daily quota stays exhausted across a retry.

### 2. `examples` `12-agent-live-smoke` (1 of 59): ENVIRONMENT, the OpenAI seat has zero credits

`test/12-agent-live-smoke.test.ts > runs the assembled agent stack against a real OpenAI seat` failed with `Error [/harness/HarnessError]: The cell frame failed`, `[cause]: Error: You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.` (`01-full-fanout.log` lines 1871 to 1986). The cause is the provider's billing response, reproduced by the package-level rerun with the key present (`02-pkg-ex12-key.log`) and gated off without it (`02-pkg-ex12-nokey.log`, `Tests 1 skipped (1)`, exit 0; the gate is `it.effect.skipIf(!hasKey)` at line 7). Same failure, same message, and same classification as the superseded evidence and `phase2-baseline.md` section 2.1. The other 58 tests, the live local-model smoke (example 13) included, pass.

### 3. `packages/build-cli` `Docker package execution` (3 of 821): ENVIRONMENT, no Docker daemon

`test/ChainExecution.test.ts` `describe.sequential("Docker package execution")`: `builds an OCI archive through CAS and restores it on a cache hit`, `acquires, exec-probes, initializes, and releases a Docker service`, `refuses an outward push before credentials or effects`. Each assertion embeds the cause: `docker daemon did not answer "docker info": failed to connect to the docker API at unix:///Users/williamcory/.orbstack/run/docker.sock ... connect: no such file or directory` (`01-full-fanout.log` lines 2348, 2364, 2396). `docker info` on this host exits 1 with that same error (CLI 29.4.0 installed, daemon down). The package-level rerun reproduces all three (`02-pkg-build-cli.log`). Recorded environmental in `phase2-baseline.md` section 2.1, `phase3-validation.md`, and the superseded evidence; the generated CI workflow runs them on ubuntu runners with a daemon.

### 4. `packages/build-cli` `plans a typed Mise refusal from the declared config when mise is absent` (1 of 821): ENVIRONMENT, `mise` is on this host's `PATH`

The test expects the plan to contain `host binary`, `mise`, and `not present on PATH`; the plan instead resolved the real binary, `argv[2]: /opt/homebrew/bin/mise,"--version"` (`01-full-fanout.log` line 2421). `which mise` prints `/opt/homebrew/bin/mise` and `mise --version` prints `2026.8.14 macos-arm64 (2026-08-25)`. The fixture requires a host without `mise`; CI installs none, so the test is green there. Same finding and classification as the superseded evidence, and its upstream nit stands: masking `mise` from `PATH` inside the fixture would make it hermetic.

### No other failure

The remaining 60 projects report `Done` with zero failing tests, and the 22 `//scripts/...` targets report 0 failed. No failure needed a credential other than the OpenAI and Gemini seats, and none touched wrangler.

## Test hygiene observations, not gate-blocking

- The checkout-root `.flows/` (git-ignored) again gained `control.db`, `engine.db`, a `cache/` entry, and a knip snapshot during the runs, matching the superseded evidence's finding; its trace narrowed the writers to `packages/{flows,targets,agent,kernel}` with attribution unproven under concurrent lanes, and that follow-up stands unchanged.
- `pnpm -r --no-bail run test` still aborts the fan-out when a script dies by signal (superseded evidence). No signal was sent during this fan-out; the behavior surfaced instead in the build fan-out, where the externally SIGTERMed `electrobun build` ended the `-r` run and cancelled `packages/cli`'s queued build, closed above by the explicit rebuild and byte-identical hash.
- Cleanup for the shared disk: `dist/release-packs` (9.2 MB, the `//scripts:releasePack` product) was deleted after the run; `//scripts:docs` created no `docs/dist`; no `smthrs-release-pack-*` or `smthrs-release-smoke-*` scratch directories remain in the temp root; 13 GiB free at the end.

## Verification commands

| Command | Exit | Result |
| --- | --- | --- |
| `env -u SMITHERS_HOME corepack pnpm -r --no-bail --if-present run test` | 1 | `Summary: 3 fails, 60 passes`; 63 of 63 reported; 9 min 25 s |
| `corepack pnpm exec vitest run test/GeminiChatCompletions.integration.test.ts --coverage.enabled=false` in `packages/model` | 1 | `Tests 2 failed \| 1 passed (3)`, both `HTTP 429` |
| same, `env -u GEMINI_API_KEY` | 0 | `Tests 3 skipped (3)` |
| `curl` the Gemini compat chat-completions endpoint with the same key | n/a | `HTTP 429`, `RESOURCE_EXHAUSTED`, free-tier daily quota `20` exhausted for `gemini-3-flash` |
| `env -u OPENAI_API_KEY corepack pnpm exec vitest run test/12-agent-live-smoke.test.ts --coverage.enabled=false` in `examples` | 0 | `Tests 1 skipped (1)` |
| same with the key present | 1 | `Tests 1 failed (1)`, `You have no credits remaining` |
| `corepack pnpm run test` in `packages/build-cli` | 1 | `Tests 4 failed \| 816 passed \| 1 skipped (821)`; Docker x3, mise x1 |
| `docker info` | 1 | daemon down (orbstack socket absent) |
| `which mise && mise --version` | 0 | `/opt/homebrew/bin/mise`, `2026.8.14` |
| `env -u SMITHERS_HOME corepack pnpm -r --if-present run build` | 143 | 48 `Done`; `apps/ui` vite step built, `electrobun build` SIGTERMed externally; `packages/cli` cancelled, rebuilt explicitly (exit 0, dist byte-identical, md5 `ae0ca6814dee7acdd92012a7883c8db3`) |
| 120 s probe of `electrobun build` in `apps/ui` | n/a | 0.0% CPU, zero output for 120 s on the hutch lock the source tree's `electrobun dev` holds; killed, leftover `hutch-engine` killed |
| `env -u SMITHERS_HOME corepack pnpm exec smithers-build test '//scripts/...'` | 0 | `22 targets: 0 hit, 22 ran, 0 failed, 0 skipped (57.3s)`; `docsUnit` 32.7 s at load 2.14, `npmDedupe` 6.3 s, `releasePack` 24.5 s, `releaseSmoke` 23.9 s |
| `git -C <clean-checkout-4> status --porcelain` after every run | 0 | empty; HEAD still `341c8fa87e` |

Raw logs and scripts in `unit-tests-logs/` beside this file: `01-full-fanout.log`, `01-full-fanout.meta`, `01-per-project.md`, `02-pkg-{model-gemini-key,model-gemini-nokey,ex12-key,ex12-nokey,build-cli}.log`, `02-gemini-curl-probe.log`, `03-build-fanout.{log,meta}`, `03-electrobun-build-probe.log`, `03-build-cli-pkg.log`, `04-scripts-targets.{log,meta}`, `parse.mjs`. The superseded run's logs remain in `unit-tests-logs-prev-cd14388ed7/`.

## Verdict

PASS. One complete fan-out over all 63 workspace projects at `341c8fa87e`: 60 pass, and the three that fail do so only on the seven tests that require a funded OpenAI seat, an unexhausted Gemini free-tier quota, a Docker daemon, or a `mise`-free `PATH`, each proven by the provider's own error text, a direct endpoint probe, the `docker info` probe, or the resolved binary path in the assertion output. Five of the seven were already recorded environmental in the Phase 2 and Phase 3 baselines and the superseded evidence; the two Gemini quota failures are the same class, proven fresh here. Package-level reruns reproduce all seven and nothing else. The built tree's `//scripts/...` targets, `//scripts:docsUnit`, `//scripts:npmDedupe`, `//scripts:releasePack`, and `//scripts:releaseSmoke` included, run 22 for 22 green. The tree is unchanged after every run.

Follow-ups for other lanes, none gate-blocking: the non-hermetic `mise` fixture in `packages/build-cli`; the `.flows/` writer attribution; and the new observation that `packages/model`'s Gemini 429 retry helper cannot fire because `RequestExecutor` drops the provider's quota text for the array-wrapped compat error body.
