# Phase 7 gate: examples

Verdict: FAIL

One published example, `examples/src/13-agent-live-smoke-local.ts`, fails
reproducibly with its documented prerequisites satisfied. Everything else
passes: the deterministic suite is 57 of 57 tests green, and the other two
suite-excluded live smokes complete against real providers.

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2 (Darwin 25.2.0), arm64 |
| Node | v24.18.0 |
| pnpm (corepack, from `packageManager: pnpm@11.21.0`) | 11.21.0 |
| Bun | 1.4.0 |
| jj | 0.39.0 (`/opt/homebrew/bin/jj`) |
| Ollama | daemon live on `http://localhost:11434`; models pulled: `qwen2.5-coder:1.5b`, `qwen2.5:3b` |
| Credentials in the shell | `OPENAI_API_KEY` (seat has no credits), `GEMINI_API_KEY` (working) |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout` |
| HEAD | `9c464343f0cfada6aa36f0a08144ed7cf1f0ce14` (`v1/rc0-migration`), `git status --porcelain` empty |
| Date | 2026-08-30 |

Real backends throughout: real SQLite files under temp directories, real engine
restarts, a real spawned MCP server process, real process groups for the
containment example, a real loopback control server, a real local Ollama model,
and the real Gemini endpoint. No mocks.

## What ran

The published example set is `examples/src/*.ts`: 38 scripts plus the shared
helper `durable-layer.ts` and the two on-disk flow projects `16-project/` and
`24-project/`. The sanctioned executor is the vitest suite (`examples/BUILD.ts`:
"the tests are what keep them runnable"); 33 test files import and execute 35
of the scripts, and the two project directories are read off disk by examples
16 and 24. Three scripts are excluded from the deterministic suite by design
and carry their own `import.meta.url` self-run blocks: 13, 14, and 15. Both
executors ran.

### 1. Suite, credentials present

```
cd <clean-checkout> && corepack pnpm run test:examples
```

Exit 1. Final lines:

```
 Test Files  1 failed | 32 passed (33)
      Tests  1 failed | 57 passed (58)
   Duration  15.22s
```

The one failure is `test/12-agent-live-smoke.test.ts > runs the assembled
agent stack against a real OpenAI seat`: `HarnessError` `code: 'model_failed'`,
cause `Error: You have no credits remaining. Add credits to continue using the
API at https://platform.openai.com/settings/organization/billing/.` This is the
exact environmental failure `docs/migration/phase2-baseline.md` section 2.1
names for this seat. Environmental, not a blocker.

### 2. Suite, no OpenAI credential (the shipped CI condition)

```
cd <clean-checkout> && env -u OPENAI_API_KEY corepack pnpm run test:examples
```

Exit 0. Final lines:

```
 Test Files  32 passed | 1 skipped (33)
      Tests  57 passed | 1 skipped (58)
```

A verbose re-run (`env -u OPENAI_API_KEY corepack pnpm exec vitest run
--reporter=verbose`, exit 0) lists every one of the 57 tests green and test 12
skipped; the listing is in the log files named below.

### 3. Direct runs of the three suite-excluded live smokes

Run from `<clean-checkout>/examples` with `node src/<file>` (Node 24 type
stripping; the self-run block fires on direct execution).

| Script | Exit | Final output |
| --- | --- | --- |
| `15-model-layer-smoke.ts` (local Ollama, default `qwen2.5-coder:1.5b`) | 0 | `ANSWER: Paris` |
| `14-agent-live-smoke-gemini.ts` (real Gemini OpenAI-compatible endpoint, `GEMINI_API_KEY`) | 0 | `RESULT: {"answer":"Paris"}` |
| `13-agent-live-smoke-local.ts` (local Ollama agent stack) | 1, twice | `FAILED: { _tag: '/harness/HarnessError', code: 'model_failed', message: 'The agent action "examples/LiveSmokeLocal" ended without a completed answer' }` |

## Per-example results

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
| 12-agent-live-smoke | test 12 (1, live OpenAI) | FAIL, environmental: seat has no credits; named in phase2-baseline 2.1; skips cleanly without the key |
| 13-agent-live-smoke-local | direct run, twice | FAIL: `model_failed`, no completed answer (blocker below) |
| 14-agent-live-smoke-gemini | direct run | PASS (real hosted provider) |
| 15-model-layer-smoke | direct run | PASS (real local model) |
| 16-fan-out-fan-in + 16-project/ | test 16 (4) | PASS |
| 17-review-loop | test 17 (3) | PASS |
| 18-approval-and-signal | test 18 (1) | PASS |
| 19-cancel-and-child-cleanup | test 19 (2, kills a real process group) | PASS |
| 20-child-flows | test 20 (1) | PASS |
| 21-cache-and-compensation | test 21 (3) | PASS |
| 22-mcp-server + 22-mcp-tools | test 22 (2; the test spawns 22-mcp-server as a real MCP process) | PASS |
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
| durable-layer (shared helper) | imported by 22 of the examples above | PASS by exercise |

Numbers 23 and 27-29 do not exist in the published set; the gaps are numbering
gaps, not missing files.

## Blocker: example 13

`examples/src/13-agent-live-smoke-local.ts` exits 1 on both of two runs with
its documented prerequisites satisfied (Ollama daemon live, models pulled).
The agent loop runs, the model answers over the wire, and the run ends with
`HarnessError` `model_failed`: the model never completes the harness's
structured-answer convention.

Cause, verified in the source: the file's header instructs `ollama pull
qwen2.5:3b`, but line 85 pins the seat to `local:qwen2.5-coder:1.5b`, a 1.5B
model. The repository itself documents that a model this small cannot finish
the convention: example 14's header exists "to get a witnessed, real,
successful completion once a local model proves too small to finish the
harness's own convention", and example 15's header says the convention "is
simply the wrong bar for a model small enough to run for free". The stack
itself is proven healthy by 14 (same agent stack, real hosted provider, PASS)
and 15 (same model layer, same local model, PASS).

Fix lane options, smallest first: point the seat at `qwen2.5:3b` to match the
header and verify it completes; or state in the header and in the self-run
block that a sub-completion exit is the documented outcome for this seat; or
drop the script from the published set. Not fixed here; this checkout stays
clean.

## Logs

- `/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/examples-suite.log` (with key, exit 1)
- `.../examples-suite-nokey.log` (no key, exit 0)
- `.../examples-suite-verbose.log` (no key, verbose, exit 0)
- `.../ex13.log`, `.../ex13b.log`, `.../ex14.log` (direct runs)

## Verdict

FAIL. The deterministic published suite is fully green from the clean checkout
(57 of 57, exit 0 under the shipped CI condition), examples 14 and 15 complete
against real providers, and example 12's failure is the baseline-named
credit exhaustion. Example 13 alone fails deterministically as shipped, so the
"execution of all published examples" requirement is not met until its seat
and header agree on a model that completes.
