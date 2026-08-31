# Phase 7 gate: examples

Verdict: PASS

Every published example executes from the clean checkout. The vitest suite is
58 of 58 tests green under the shipped CI condition (exit 0), the declared
`//examples:suite` target passes, and the three self-running live smokes
(13, 14, 15) complete against real providers. The one non-green result is
example 12, whose OpenAI seat has no credits; that test skips cleanly without
the key and is the environmental entry `docs/migration/phase2-baseline.md`
section 2.1 already names.

This file supersedes the 2026-08-30 evidence taken at `9c464343f0` in
`migration/clean-checkout` (that directory no longer exists), which returned
FAIL on example 13. Commits `3ef462b974`, `80889a65d6`, and `387df0b195`
(`fix(examples): ...`) closed that blocker: the local smoke now runs on
`qwen2.5:7b` with greedy decoding and three corrections, and a new
`test/13-agent-live-smoke-local.test.ts` keeps it in the suite. The diff
between the two HEADs under `examples/` is exactly those two files.

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2 (build 25C56), Darwin 25.2.0, arm64; load averages 2.59 2.64 3.81 at start |
| Date | 2026-08-31 06:58 to 07:05 UTC (2026-08-30 23:58 to 2026-08-31 00:05 PT) |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-2` (written `<clean-checkout-2>` below) |
| HEAD | `20b32c6316487497301db74ec70cbe951428ef53` on `v1/rc0-migration`; `git status --porcelain` empty before and after every run; submodule `vendor/jj` at `47589ada70` |
| Install | the frozen `corepack pnpm install --frozen-lockfile` recorded in `00-clean-install.md`; no build step (workspace `exports` point at `src/`) |
| git | 2.50.1 (Apple Git-155) |
| Node | v24.18.0 (rc-contract floor `>=22.19.0`) |
| corepack / pnpm | 0.35.0 / 11.21.0 (from `packageManager: pnpm@11.21.0`) |
| Bun | 1.4.0 (`1.4.0-canary.1`); not used by this gate, the examples suite is Node-only (`examples/BUILD.ts`, `ci/BUILD.ts`) |
| jj | 0.39.0 at `/opt/homebrew/bin/jj` |
| Ollama | 0.17.7, daemon live on `http://localhost:11434`; pulled: `qwen2.5:7b`, `qwen2.5:3b`, `qwen2.5-coder:1.5b` |
| Credentials in the shell | `OPENAI_API_KEY` set (seat has no credits), `GEMINI_API_KEY` set (working), `ANTHROPIC_API_KEY` unset |
| Docker | daemon down; not needed by any example |

`SMITHERS_HOME` was unset (`env -u SMITHERS_HOME`) for every command.

Real backends throughout: real SQLite files under temp directories through
`NodeRuntime.storage` (`examples/src/durable-layer.ts`), real engine restarts,
a real spawned MCP server process (22), real process groups killed and reaped
(19, 37), a real loopback control server (24), a real esbuild browser bundle
(09), a real local Ollama model (13, 15), and the real Gemini endpoint (14).
No mocks.

## What ran

The published example set is `examples/src/*.ts`: 38 numbered scripts, the
shared helper `durable-layer.ts`, and the two on-disk flow projects
`16-project/` and `24-project/`. The sanctioned executor is the vitest suite
(`examples/BUILD.ts`: "the tests are what keep them runnable"): 34 test files
import and execute 36 of the scripts, and the two project directories are
read off disk by examples 16 and 24. Examples 13, 14, and 15 also carry
`import.meta.url` self-run blocks; 14 and 15 have no test file and 12 and 13
skip in the suite when their prerequisite (a funded `OPENAI_API_KEY`; the
`qwen2.5:7b` model on the local daemon) is absent. Both executors ran.

### 1. Suite, credentials as found in the shell

```
cd <clean-checkout-2> && env -u SMITHERS_HOME corepack pnpm run test:examples
```

Exit 1. Started 06:58:41 UTC, finished 06:59:54 UTC. Final lines:

```
 Test Files  1 failed | 33 passed (34)
      Tests  1 failed | 58 passed (59)
   Duration  69.79s (transform 68.68s, setup 0ms, import 140.65s, tests 84.57s, environment 3ms)
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @smthrs/examples@0.0.0 test: `vitest run`
```

The one failure is `test/12-agent-live-smoke.test.ts > runs the assembled
agent stack against a real OpenAI seat` (6602 ms): `HarnessError`
`code: 'model_failed'`, `Caused by: Error: You have no credits remaining. Add
credits to continue using the API at
https://platform.openai.com/settings/organization/billing/.` The request
reached OpenAI and the provider refused it on billing. Environmental; named
in `phase2-baseline.md` section 2.1 for this same seat. Test 13 passed in
this run (33 files passed; 12 is the only failure).

### 2. Suite, no OpenAI credential (the shipped CI condition)

```
cd <clean-checkout-2> && env -u SMITHERS_HOME -u OPENAI_API_KEY corepack pnpm --filter @smthrs/examples exec vitest run --reporter=verbose
```

Exit 0. Started 07:00:58 UTC, finished 07:01:31 UTC. Final lines:

```
 Test Files  33 passed | 1 skipped (34)
      Tests  58 passed | 1 skipped (59)
   Duration  31.29s (transform 53.71s, setup 0ms, import 121.79s, tests 40.88s, environment 21ms)
```

The verbose listing names every one of the 58 tests green; `12` is the one
`↓` (skipped) line. `test/13-agent-live-smoke-local.test.ts > answers a
question through the local agent stack, and decodes every time` passed in
25575 ms, which is three sequential decodes against `qwen2.5:7b`.

### 3. The declared target

```
cd <clean-checkout-2> && env -u SMITHERS_HOME -u OPENAI_API_KEY pnpm exec smithers-build test '//examples/...'
```

Exit 0. Final lines:

```
//examples:suite  ran  14.2s
1 targets: 0 hit, 1 ran, 0 failed, 0 skipped (14.2s)
ok: true
```

A second run with `--no-cache --full-output --format json` also exits 0
(`"failed": 0`, `"ok": true`, 50.0 s). `smithers-build` does not surface the
child's stdout, so the target's exact argv (`Vitest` target,
`packages/targets/src/Vitest.ts:80`) was run by hand from
`<clean-checkout-2>/examples`:

```
env -u SMITHERS_HOME -u OPENAI_API_KEY pnpm exec vitest run --config vitest.config.ts --environment node
```

Exit 0, `Test Files  33 passed | 1 skipped (34)`, `Tests  58 passed | 1
skipped (59)`, 27.24 s. Observation for the build-system owner, not a gate
result: the two `smithers-build` runs reported different result keys
(`3edbae85...` then `29ee2311...`) over an unchanged tree.

### 4. Direct runs of the three self-running live smokes

Run from `<clean-checkout-2>/examples` with `env -u SMITHERS_HOME node src/<file>`
(Node 24 type stripping; the self-run block fires on direct execution).

| Script | Exit | Wall time | Final output |
| --- | --- | --- | --- |
| `13-agent-live-smoke-local.ts`, run 1 (local Ollama, `qwen2.5:7b`) | 0 | 4 s | `RESULT: {"answer":"Paris"}` |
| `13-agent-live-smoke-local.ts`, run 2 | 0 | 5 s | `RESULT: {"answer":"Paris"}` |
| `14-agent-live-smoke-gemini.ts` (real Gemini OpenAI-compatible endpoint, `GEMINI_API_KEY`) | 0 | 6 s | `RESULT: {"answer":"Paris"}` |
| `15-model-layer-smoke.ts` (local Ollama, default `qwen2.5-coder:1.5b`) | 0 | 19 s | `ANSWER: Paris` |

## Per-example results

Test counts are from the verbose run (section 2).

| Example script | Executor | Result |
| --- | --- | --- |
| 01-define-and-run | test 01 (1 test) | PASS |
| 02-run-durably | test 02 (1) | PASS |
| 03-crash-and-resume | test 03 (1) | PASS |
| 04-retry-policy | test 04 (2) | PASS |
| 05-time-travel-fork | test 05 (1) | PASS |
| 06-time-travel-rewind | test 06 (1) | PASS |
| 07-sync-follower | test 07 (1) | PASS |
| 08-host-adapters | test 08 (1) | PASS |
| 09-browser-use | test 09 (2, includes the esbuild browser-bundle check) | PASS |
| 10-telemetry-export | test 10 (1) | PASS |
| 11-agent-step | test 11 (1) | PASS |
| 12-agent-live-smoke | test 12 (1, live OpenAI) | ENV-SKIP: fails with the key present because the seat has no credits (baseline 2.1); skips cleanly without the key |
| 13-agent-live-smoke-local | test 13 (1, three decodes against `qwen2.5:7b`) and two direct runs | PASS |
| 14-agent-live-smoke-gemini | direct run (real hosted provider) | PASS |
| 15-model-layer-smoke | direct run (real local model) | PASS |
| 16-fan-out-fan-in + 16-project/ | test 16 (4) | PASS |
| 17-review-loop | test 17 (3) | PASS |
| 18-approval-and-signal | test 18 (1) | PASS |
| 19-cancel-and-child-cleanup | test 19 (2, kills a real process group) | PASS |
| 20-child-flows | test 20 (1) | PASS |
| 21-cache-and-compensation | test 21 (3) | PASS |
| 22-mcp-server + 22-mcp-tools | test 22 (2; spawns 22-mcp-server as a real MCP process) | PASS |
| 24-control-plane-and-gateway + 24-project/ | test 24 (1, loopback control server) | PASS |
| 25-agent-tools-in-sandbox | test 25 (1) | PASS |
| 26-memory-recall | test 26 (2) | PASS |
| 30-failure-control | test 30 (2) | PASS |
| 31-bounded-loops | test 31 (7) | PASS |
| 32-intervene | test 32 (5) | PASS |
| 33-delegation-trellis | test 33 (2) | PASS |
| 34-human-task | test 34-human-task (1) | PASS |
| 34-poll | test 34-poll (1, restart across an armed clock) | PASS |
| 35-remote-cache | test 35 (2) | PASS |
| 36-detached-children | test 36 (1) | PASS |
| 37-host-containment + 37-host-containment-host | test 37 (1; spawns the host helper and reaps its process group) | PASS |
| 38-monitor-and-alert | test 38 (1) | PASS |
| 39-agent-policies | test 39 (1) | PASS |
| durable-layer (shared helper) | imported by the persistence examples above | PASS by exercise |

Numbers 23 and 27 to 29 do not exist in the published set; the gaps are
numbering gaps, not missing files.

## Residual

Example 12 is the only published example not witnessed to completion on this
host, and the cause is the OpenAI account's billing state, not the
repository. Prediction: with a funded `OPENAI_API_KEY` in the shell, run 1
exits 0 with `LIVE MODEL ANSWER: {"answer":"4"}`-shaped output. This is an
operator action (add credits or supply another key) and does not open a fix
lane.

## Logs

`examples-logs/` beside this file:

- `run1-suite-withkey.log` (section 1, exit 1)
- `run2-suite-nokey-verbose.log` (section 2, exit 0, every test listed)
- `run3-smithers-build-examples.log`, `run5-smithers-build-full.log` (section 3, target runs)
- `run4-target-argv.log` (section 3, the target's argv run by hand)
- `run-ex13-direct-1.log`, `run-ex13-direct-2.log`, `run-ex14-direct.log`, `run-ex15-direct.log` (section 4)

## Verdict

PASS. All 38 published example scripts execute from the clean checkout at
`20b32c6316`: 58 of 58 suite tests pass under the shipped CI condition, the
`//examples:suite` target passes, examples 13, 14, and 15 complete against a
real local model and a real hosted provider, and the earlier example 13
blocker is closed by the fix commits. Example 12 is environmental (OpenAI
seat without credits) and skips as designed when the key is absent. The
checkout is byte-identical to HEAD after every run.
