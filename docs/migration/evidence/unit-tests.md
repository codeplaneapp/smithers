# Phase 7 gate: unit-tests

Verdict: PASS

The full recursive unit-test fan-out ran from the clean checkout. 59 of 62 workspace projects passed. The three failing projects fail only on live external state: an exhausted Gemini free-tier quota, an OpenAI seat with zero credits, no running Docker daemon, and a host that has `mise` installed where one fixture requires it absent. Every failure is classified environmental with reproduction proof below. No product defect surfaced.

## Environment

| Item | Value |
| --- | --- |
| Host | macOS 26.2, arm64, 16 cores, 64 GB |
| Node | v24.18.0 |
| pnpm (via corepack 0.35.0, from `packageManager: pnpm@11.21.0`) | 11.21.0 |
| Bun | 1.4.0-canary.1 (`bun --version` prints 1.4.0) |
| Checkout | /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout at `9c464343f0`, branch `v1/rc0-migration`, `git status --porcelain` empty before and after the run |
| Date | 2026-08-30, run window 15:52:07 to 15:59:56 PDT |
| Shell env | `OPENAI_API_KEY` and `GEMINI_API_KEY` were set, so the live-seat suites ran instead of skipping. `docker` CLI installed, daemon down. `mise` 2026.8.14 on PATH at `/opt/homebrew/bin/mise` |

Scheduling note: sibling Phase 7 lanes share this checkout. A `pnpm -r run build`, a `pnpm -r run check`, and a sqlite-gate vitest run were active when this gate started; the test fan-out was launched only after all three exited, so no lane was rewriting `dist/` or running the same package suites concurrently. A read-only `pnpm -r run lint` fan-out from a sibling lane overlapped the start. An initial launch at 15:48 was killed two minutes in and restarted at 15:52 solely to add exit-code capture; no results from it are used here.

## Command and result

Run from the checkout root:

```sh
corepack pnpm -r --no-bail --if-present run test
```

| Item | Value |
| --- | --- |
| Exit code | 1 |
| Scope line | `Scope: 62 of 63 workspace projects` |
| Final summary | `Summary: 3 fails, 59 passes` |
| Failing projects | `packages/model`, `examples`, `packages/build-cli` |
| Full log | /private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/unit-tests.log (2,437 lines) |

Reference points: the Phase 2 baseline recorded `Summary: 2 fails, 55 passes` and the Phase 3 validation `Summary: 2 fails, 56 passes`, both with the same two environmental projects (`examples` live OpenAI, `packages/build-cli` Docker). This run adds `packages/model`, which those runs never exercised live because `GEMINI_API_KEY` was absent from their shells; the suite self-skips without it.

Spot checks on load-sensitive suites named in earlier baselines: `packages/sync` 205/205 passed (ServerSoak included), `packages/engine-store` 796/796, `packages/engine` 224/224, `packages/run-store` 131/131, `packages/database` 117 passed 2 skipped.

## Failure classification

### 1. packages/model — ENVIRONMENT (live Gemini free-tier quota exhausted)

`test/GeminiChatCompletions.integration.test.ts`: 2 of 240 tests failed, `streams a short completion` and `streams a tool call with reassembled arguments`, both with `flows/model/ModelError: Chat Completions request failed with HTTP 429` raised at `src/RequestExecutor.ts:504` from the live response. Package result: `Tests 2 failed | 238 passed (240)`.

Proof:

- The suite is `describe.skipIf(apiKey === undefined || apiKey === "")` on `GEMINI_API_KEY` and calls `https://generativelanguage.googleapis.com/v1beta/openai` directly. It ran only because the key was present in this shell.
- Re-run without the key: `env -u GEMINI_API_KEY corepack pnpm run test` in `packages/model` exits 0, `Test Files 20 passed | 1 skipped (21)`, `Tests 237 passed | 3 skipped (240)`, coverage gate green. The only failing tests are the live-seat ones.
- Direct probe of the endpoint with the same key at 16:0x returned HTTP 429 with `status: RESOURCE_EXHAUSTED`, `Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3-flash`. The seat is a free-tier key whose 20-request window was already consumed (sibling Phase 7 lanes ran this same suite earlier in the day).
- Keyed re-run of just this file at 16:01 still fails with the same HTTP 429, consistent with the exhausted window, and against an endpoint the repository does not control.

Upstream nit, not gate-blocking: the test's built-in single retry matches `exceeded your current quota` or `retry in Ns` in the surfaced message, but `RequestExecutor` surfaces plain `Chat Completions request failed with HTTP 429` without the provider text, so the retry never engages on exactly the response it was written for.

### 2. examples — ENVIRONMENT (OpenAI seat has zero credits)

`test/12-agent-live-smoke.test.ts > runs the assembled agent stack against a real OpenAI seat`: 1 of 58 tests failed with `/harness/HarnessError: The cell frame failed`, `code: 'model_failed'`, caused by the provider response `Error: You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.` Package result: `Tests 1 failed | 57 passed (58)`.

Proof:

- This is the exact failure `docs/migration/phase2-baseline.md` section 2.1 records for the same test and classifies environmental (`You have no credits remaining`).
- The test gates on `OPENAI_API_KEY`. Re-run without it: `env -u OPENAI_API_KEY corepack pnpm exec vitest run test/12-agent-live-smoke.test.ts --coverage.enabled=false` in `examples` exits 0 with `Tests 1 skipped (1)`. The failure requires a funded live seat; the configured seat has no credits.

### 3. packages/build-cli — ENVIRONMENT (no Docker daemon; mise present on the host)

`test/ChainExecution.test.ts`: 4 of 813 tests failed, `Tests 4 failed | 808 passed | 1 skipped (813)`.

Three under `Docker package execution` (`builds an OCI archive through CAS and restores it on a cache hit`, `acquires, exec-probes, initializes, and releases a Docker service`, `refuses an outward push before credentials or effects`). Each assertion output embeds the cause: `docker daemon did not answer "docker info": failed to connect to the docker API at unix:///Users/williamcory/.orbstack/run/docker.sock ... connect: no such file or directory`.

Proof: `docker info` exits 1 on this host (CLI installed at `/usr/local/bin/docker`, no daemon running). These are the same three tests `phase2-baseline.md` section 2.1 classifies environmental for the same reason. CI runs them on ubuntu runners where a daemon exists.

One under `host refusals and Anvil secret resolution`: `plans a typed Mise refusal from the declared config when mise is absent` expects the plan to contain `host binary ... mise ... not present on PATH`, but the plan resolved the real binary and rendered `argv[2]: /opt/homebrew/bin/mise,"--version"`.

Proof: the fixture requires a host without `mise` on PATH; this host has `mise` 2026.8.14 at `/opt/homebrew/bin/mise` (installed after the Phase 2 baseline run, where the identical test existed at `b8af974334` and passed). `.github/workflows/ci.yml` installs no mise, so the test is green in CI. Classification is environmental host state.

Upstream nit, not gate-blocking: the fixture is not hermetic. It should mask `mise` from PATH inside the fixture workspace instead of assuming the host lacks it; any developer machine with mise installed reds this test permanently.

## Verification commands

| Command | Exit | Result |
| --- | --- | --- |
| `corepack pnpm -r --no-bail --if-present run test` (checkout root) | 1 | `Summary: 3 fails, 59 passes`; failing projects and causes above |
| `env -u GEMINI_API_KEY corepack pnpm run test` (packages/model) | 0 | `Tests 237 passed | 3 skipped (240)`, coverage green |
| `corepack pnpm exec vitest run test/GeminiChatCompletions.integration.test.ts --coverage.enabled=false` (packages/model, key present) | 1 | same two tests, same `HTTP 429` |
| `env -u OPENAI_API_KEY corepack pnpm exec vitest run test/12-agent-live-smoke.test.ts --coverage.enabled=false` (examples) | 0 | `Tests 1 skipped (1)` |
| `docker info` | 1 | daemon not running |
| `which mise && mise --version` | 0 | `/opt/homebrew/bin/mise`, `2026.8.14 macos-arm64` |
| `git -C <clean-checkout> status --porcelain` after the run | 0 | empty; tree unchanged at `9c464343f0` |

Supporting logs in /private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/: `unit-tests.log`, `unit-tests.exit`, `verify-model-nokey.log`, `verify-gemini-keyed.log`, `verify-examples-nokey.log`, `gemini-probe.json`.

## Verdict

PASS. All 62 project suites ran; 59 passed outright. Every failing test requires live external state the repository does not control: a funded OpenAI seat, an unexhausted Gemini quota window, a running Docker daemon, or a host without mise. Each classification is proven by a skip-gated or state-inverted re-run, a direct endpoint probe, or the daemon probe, and matches the Phase 2 and Phase 3 recorded baselines where those suites already existed. No product defect was found. Two upstream test-quality nits are recorded above for a follow-up lane: the non-hermetic mise fixture and the 429 message classification that defeats the Gemini test's own retry.
