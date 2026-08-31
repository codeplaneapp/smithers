# Phase 7 gate: examples

Verdict: PASS

Every published example executes from the clean checkout at `cd14388ed7`.
The vitest suite is 58 of 58 tests green under the shipped CI condition
(exit 0), the declared `//examples:suite` target passes, the examples
workspace typechecks, all 38 scripts evaluate directly under Node, and the
self-running live smokes (13, 14, 15) complete against a real local model and
a real hosted provider. The one non-green result is example 12, whose OpenAI
seat has no credits; that test skips cleanly without the key and is the
environmental entry `docs/migration/phase2-baseline.md` section 2.1 names.

This file supersedes the 2026-08-31 06:58 UTC evidence taken at `20b32c6316`
in `migration/clean-checkout-2` (that directory no longer exists). The
superseded file is kept beside this one as `examples-prev-20b32c6316.md` with
its logs in `examples-logs-prev-20b32c6316/`. `git diff --stat
20b32c6316..cd14388ed7 -- examples/` is empty: no example, test, or fixture
changed between the two runs, so the two PASS readings measure the same
example set against a moved tree (20 commits, all outside `examples/`).

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2 (build 25C56), Darwin 25.2.0, arm64 |
| Date | 2026-08-31 11:59:37 to 12:05:49 UTC (2026-08-31 04:59 to 05:05 PT) |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4` (written `<clean-checkout-4>` below), the shared clone recorded in `00-clean-install.md` |
| HEAD | `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba` on `v1/rc0-migration`, equal to `v1/rc0-migration` in `/Users/williamcory/smithers`; `git status --porcelain` empty before and after every run; submodule `vendor/jj` at `47589ada70` with a clean working tree |
| Install | the frozen `corepack pnpm install --frozen-lockfile` recorded in `00-clean-install.md`; no build step (workspace `exports` point at `src/`, for example `packages/flow/package.json:37`) |
| git | 2.50.1 (Apple Git-155) |
| Node | v24.18.0 (rc-contract section 1 floor `>=22.19.0`) |
| corepack / pnpm | 0.35.0 / 11.21.0 (from `packageManager: pnpm@11.21.0`) |
| Bun | 1.4.0 (`1.4.0-canary.1`); not used by this gate, the examples suite is Node-only (`examples/BUILD.ts`, `ci/BUILD.ts`) |
| jj | 0.39.0 |
| Ollama | 0.17.7, daemon live on `http://localhost:11434`; pulled: `qwen2.5:7b`, `qwen2.5:3b`, `qwen2.5-coder:1.5b` |
| Credentials in the shell | `OPENAI_API_KEY` set (seat has no credits), `GEMINI_API_KEY` set (working), `ANTHROPIC_API_KEY` unset |
| Docker | daemon down; not needed by any example |
| Free disk | 12 GiB |
| Host load | load average 11.62 at the start, 92.25 at its peak during run 2, 49.00 at the end. Two other Phase 7 gates were executing in `<clean-checkout-4>` at the same time (the `e2e/` fault suite, PID 81046, and the `packages/flows` vitest suite, PID 89252). The examples write only under per-test temp directories, so they share no state with those suites. |

`SMITHERS_HOME` was unset in the calling shell and additionally stripped
(`env -u SMITHERS_HOME`) from every command.

Real backends throughout: real SQLite files under temp directories through
`NodeRuntime.storage` (`examples/src/durable-layer.ts`), real engine restarts,
a real spawned MCP server process (22), real process groups killed and reaped
(19, 37), a real loopback control server (24), a real esbuild browser bundle
(09), a real local Ollama model (13, 15), and the real Gemini endpoint (14).
No mocks.

## What ran

The published example set is `examples/src/*.ts`: 38 numbered scripts, the
shared helper `durable-layer.ts`, and the two on-disk flow projects
`16-project/flows/gate/flow.ts` and `24-project/flows/ship/flow.mdx`.
`docs/pages/examples.md` names `pnpm run test:examples` as the way to run
them, and `examples/BUILD.ts` states the rule ("the tests are what keep them
runnable"): 34 test files import and execute 36 of the scripts, and the two
project directories are read off disk by examples 16 and 24. Examples 13, 14,
and 15 also carry `import.meta.url` self-run blocks; 14 and 15 have no test
file, and 12 and 13 skip in the suite when their prerequisite (a funded
`OPENAI_API_KEY`; the `qwen2.5:7b` model on the local daemon) is absent.
`22-mcp-server.ts` and `37-host-containment-host.ts` are helper programs that
their paired examples spawn as separate processes. Every executor ran.

### 1. Suite, credentials as found in the shell

```
cd <clean-checkout-4> && env -u SMITHERS_HOME corepack pnpm run test:examples
```

Exit 1. Started 11:59:50 UTC, finished 12:00:35 UTC. Final lines:

```
 Test Files  1 failed | 33 passed (34)
      Tests  1 failed | 58 passed (59)
   Duration  41.82s (transform 110.18s, setup 0ms, import 239.88s, tests 62.25s, environment 3ms)
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @smthrs/examples@0.0.0 test: `vitest run`
```

The one failure is `test/12-agent-live-smoke.test.ts > runs the assembled
agent stack against a real OpenAI seat` (5475 ms): `HarnessError`
`code: 'model_failed'`, `Caused by: Error: You have no credits remaining. Add
credits to continue using the API at
https://platform.openai.com/settings/organization/billing/.` The request
reached OpenAI and the provider refused it on billing. Environmental; named
in `phase2-baseline.md` section 2.1 for this same seat. Test 13 passed in
this run (12 is the only failure).

### 2. Suite, no OpenAI credential (the shipped CI condition)

```
cd <clean-checkout-4> && env -u SMITHERS_HOME -u OPENAI_API_KEY corepack pnpm --filter @smthrs/examples exec vitest run --reporter=verbose
```

Exit 0. Started 12:01:13 UTC, finished 12:02:09 UTC. Final lines:

```
 Test Files  33 passed | 1 skipped (34)
      Tests  58 passed | 1 skipped (59)
   Duration  54.37s (transform 73.89s, setup 0ms, import 169.02s, tests 69.70s, environment 3ms)
```

The verbose listing names every one of the 58 tests green; `12` is the one
`↓` (skipped) line. `test/13-agent-live-smoke-local.test.ts > answers a
question through the local agent stack, and decodes every time` passed in
47155 ms, three sequential decodes against `qwen2.5:7b` while the host load
average was above 60. The same test took 25575 ms in the superseded run on a
host with load average 2.6. Its budget is `testTimeout: 60_000`
(`examples/vitest.config.ts`). See "Observations".

### 3. The declared target

```
cd <clean-checkout-4> && env -u SMITHERS_HOME -u OPENAI_API_KEY pnpm exec smithers-build test '//examples/...' --no-cache --full-output
```

Exit 0. Started 12:02:30 UTC, finished 12:03:30 UTC. Final lines:

```
//examples:suite  ran  47.9s
1 targets: 0 hit, 1 ran, 0 failed, 0 skipped (47.9s)
ok: true
```

The structured block reports `counts: hit 0, ran 1, failed 0, skipped 0`,
`ok: true`, result key `c7382704b61a6ce11070557daf5be43bbe28e06ea8789b7aa40e524db76d3be2`.
`--no-cache` forces the target to run rather than replay a hit.

### 4. Typecheck of the examples workspace

```
cd <clean-checkout-4> && env -u SMITHERS_HOME corepack pnpm --filter @smthrs/examples run check
```

Exit 0 (`tsc -p tsconfig.json --noEmit`, 17 s). Every script and test
compiles under the workspace `tsconfig.json` (`strict`,
`exactOptionalPropertyTypes`, `erasableSyntaxOnly`).

### 5. Direct runs of the self-running live smokes

Run from `<clean-checkout-4>/examples` with `env -u SMITHERS_HOME node src/<file>`
(Node 24 type stripping; the self-run block fires on direct execution).

| Script | Exit | Wall time | Final output |
| --- | --- | --- | --- |
| `13-agent-live-smoke-local.ts`, run 1 (local Ollama, `qwen2.5:7b`) | 0 | 6 s | `RESULT: {"answer":"Paris"}` |
| `13-agent-live-smoke-local.ts`, run 2 | 0 | 7 s | `RESULT: {"answer":"Paris"}` |
| `14-agent-live-smoke-gemini.ts` (real Gemini OpenAI-compatible endpoint, `GEMINI_API_KEY`) | 0 | 4 s | `RESULT: {"answer":"Paris"}` |
| `15-model-layer-smoke.ts` (local Ollama, default `qwen2.5-coder:1.5b`) | 0 | 7 s | `ANSWER: Paris` |

### 6. Direct runs of the two helper programs

`22-mcp-server.ts`, driven over stdio with four newline-delimited JSON-RPC
requests (`initialize`, `tools/list`, `tools/call word_count("one two
three")`, `tools/call explode`). Exit 0 when stdin closed. It answered
`protocolVersion: "2025-06-18"`, listed `word_count`, `slugify`, and
`explode`, returned `"3"` with `isError: false`, and returned `"the tool
refused"` with `isError: true`.

`37-host-containment-host.ts <sqlite file> gate-host-1`, started in the
background over a fresh SQLite file in the scratchpad. It printed the group
pid `88535` after 5 s; at that moment the group held `bash`, `sleep`,
`sleep`, and the database held 14 `flows_*` tables, one `flows_runs` row
(`host-containment | running | gate-host-1`), and 7 journal events including
`flows.host.process-spawned.v1` under run `flows.host:gate-host-1`, so the
spawn was durable before the pid was printed, which is the property example
37 depends on. `kill -9` of the host returned exit 137 and left the group
alive; `kill -9 -88535` reaped it. That orphaned-group state is what
`test/37-host-containment.test.ts` reproduces and reaps through a second
`layerHost` (4070 ms, passed in section 2).

### 7. Direct evaluation of every other script

From `<clean-checkout-4>/examples`, `env -u SMITHERS_HOME node src/<file>`
for each of the remaining 34 scripts (01 to 12, 16 to 22-mcp-tools, 24 to
26, 30 to 39, `durable-layer.ts`). All 34 exit 0 with no output: each module
resolves its workspace imports and evaluates under Node's type stripping,
and none has top-level side effects. Per-file exit codes and wall times are
in `run6-direct-load-all.log`.

## Per-example results

Test counts and timings are from the verbose run (section 2).

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
| 22-mcp-server + 22-mcp-tools | test 22 (2; spawns 22-mcp-server as a real MCP process) and a direct stdio run of the server | PASS |
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
| 37-host-containment + 37-host-containment-host | test 37 (1; spawns the host helper and reaps its process group) and a direct kill-and-reap run of the helper | PASS |
| 38-monitor-and-alert | test 38 (1) | PASS |
| 39-agent-policies | test 39 (1) | PASS |
| durable-layer (shared helper) | imported by the persistence examples above; evaluates directly | PASS by exercise |

Numbers 23 and 27 to 29 do not exist in the published set; the gaps are
numbering gaps, not missing files.

## Observations

Neither item changes the verdict.

1. Test 13 ran at 47.2 s of its 60 s budget on a host with load average
   above 60, against 25.6 s on a quiet host. Three sequential 7B decodes
   under one 60 s `testTimeout` leave under 13 s of headroom when the
   machine is saturated. A timeout here would be a host-capacity false
   red, not an example defect; the direct runs on the same host answered in
   6 to 7 s. Input for the examples owner: either widen the budget for this
   one test or reduce it to fewer decodes.
2. `test/19-cancel-and-child-cleanup.test.ts > kills the process group a
   cancelled step was holding` logs `WARN process ledger could not journal
   flows.host.process-exited.v1 InterruptError: All fibers interrupted
   without error` on stdout while passing. The same line appears in the
   superseded run's verbose log. The ledger tries to journal the process
   exit from inside the action scope that the cancellation is tearing down,
   so the write is interrupted. The test's assertion (the group is dead)
   holds. Input for the engine owner: the exit record for a process killed
   by cancellation is not journaled.

## Residual

Example 12 is the only published example not witnessed to completion on
this host, and the cause is the OpenAI account's billing state, not the
repository. Prediction: with a funded `OPENAI_API_KEY` in the shell, section
1 exits 0 with the `12` test green. This is an operator action (add credits
or supply another key) and does not open a fix lane.

No process leaked: after every run, `pgrep -fl 'sleep 300|22-mcp-server|37-host-containment|clean-checkout-4/examples'`
found nothing. The only ignored path under `examples/` is
`examples/node_modules/`. `git status --porcelain` was empty after every run.

## Logs

`examples-logs/` beside this file:

- `00-start-utc.txt` (gate start)
- `run1-suite-withkey.log` (section 1, exit 1)
- `run2-suite-nokey-verbose.log` (section 2, exit 0, every test listed)
- `run3-smithers-build-examples.log` (section 3, target run)
- `run5-typecheck.log` (section 4)
- `run-ex13-direct-1.log`, `run-ex13-direct-2.log`, `run-ex14-direct.log`, `run-ex15-direct.log` (section 5)
- `run-ex22-mcp-server-direct.log`, `run-ex37-host-direct.log` (section 6)
- `run6-direct-load-all.log` (section 7)

## Verdict

PASS. All 38 published example scripts execute from the clean checkout at
`cd14388ed7`: 58 of 58 suite tests pass under the shipped CI condition, the
`//examples:suite` target passes, the workspace typechecks, every script
evaluates directly under Node, and examples 13, 14, and 15 complete against
a real local model and a real hosted provider. Example 12 is environmental
(OpenAI seat without credits) and skips as designed when the key is absent.
The checkout is byte-identical to HEAD after every run.
