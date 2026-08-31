# Phase 7 verify: cli-lifecycle (round 1)

Verdict: PASS. Zero blocker/major findings. One minor ownership finding.

Worktree `.../migration/wt/cli-lifecycle`, branch `phase7/cli-lifecycle`, HEAD
`0fa6148b4b` on base `d7c5a3e503`. Installed `corepack pnpm install
--frozen-lockfile --offline` exit 0 (2m34s), no lockfile change. Worktree clean
before and after; teardown done. `apps/ui/.hutch/devkit` copied from the main
checkout only to run `apps/ui` `check` (gitignored), removed at teardown. Loads
1.9–9.0 throughout, never near the 40 guard; no suite needed an isolated rerun.
Commits authored `lane <lane@local>`.

## (1) RED-CHECK OVERLAY — every named test fails at base, passes at HEAD

Overlaid the pre-fix source with `git show d7c5a3e503:<path>` (new tests left in
tree), ran, restored. Every quoted assertion reproduced verbatim.

| Overlay (base src) | Test | Base | HEAD |
| --- | --- | --- | --- |
| AgentSession.ts | CompletedRunPersistsAcrossProcesses (3 cases) | FAIL `expected 'suspended' to be 'completed'`; `…'interrupt-released'…`; `expected 'failed' to be 'completed'` | PASS |
| AgentSession.ts | AgentSessionFailures "drives a run whose control row cannot be read" | FAIL `expected 1 to be greater than 1` | PASS |
| Command.ts | ControlSurface approve/deny/resume (7 cases) | FAIL `expected 7 to be {1,130,+0}` | PASS |
| Command.ts | Bin "exits 1 from run --resume … already settled failed" | FAIL `expected +0 to be 1` | PASS |
| ControlError.ts+ControlLive.ts+bin.ts | EngineWaits "renders the refusal as the failure it is" | FAIL `expected 'shipped' to be '/control/NoMatchingWait'` | PASS |
| ControlError.ts+ControlLive.ts+bin.ts | Bin "names the refusal and says what is open" | FAIL `expected 'go:' to be 'NoMatchingWait: no wait point named "…'` | PASS |
| ControlError.ts only (bin.ts errorName kept) | same Bin signal case | FAIL `expected 'NoMatchingWait:' to be 'NoMatchingWait: no wait point named "…'` | PASS |
| bin.ts (Logger.LogToStderr removed) | Bin "exits 1 for a run that settled failed" + "writes one JSON document…" | FAIL `expected […(30)] to have a length of 1 but got 30` | PASS |

Named at HEAD, all green: agent CompletedRunPersistsAcrossProcesses+AgentSessionFailures
37/37; control EngineWaits 7/7; cli ControlSurface 28/28; cli Bin
"an attached launch's exit status" + "signal … parked on something else" 7 run,
46 skipped, 0 fail. The errorName-only overlay proves the `message` getter /
field rename is load-bearing, not just the bin.ts change.

The two Bin `failed`-settlement D1 pins ("leaves a terminal engine row",
"is not claimed…") are green at both base and HEAD — the fixer discloses this
honestly; they are process-boundary regression pins, red-first through the agent
cross-process test. See (2): I reproduced the stronger *completed*-run symptom
directly with the real binary, which the fixer's provider-free host could not.

## (2) ORIGINAL SYMPTOM — reproduced at base, gone at HEAD (real binary, real seat)

Real `gpt-5.6-luna` via `SMITHERS_OPENAI_AUTH=chatgpt`, detached processes, real
`.flows` SQLite. Recipe from smoke.md.

D1 completed-run, HEAD: `up hello` (run-1), `up hello -d` (run-2), and a third
executor `up hello` (run-3) each leave engine row `completed`, `finished_at_ms`
set, decisions `created > claimed-and-activated > transitioned` (NO
`interrupt-released`); `-d --json` stdout is exactly the one-line receipt (no
WARN). A later process does not touch earlier completed rows.
D1 base overlay (AgentSession.ts@base): `up hello` (run-6) leaves
`suspended|released` + `interrupt-released` and logs the smoke's WARN — the exact
defect, on a completed run.

D1 second half (released row, terminal control row), HEAD: staged a real failed
run's engine row to `suspended`/`released` (no result) with control row `failed`;
a `serve` process reclaimed and settled it — engine → `completed` with
`finished_at_ms`, control stays `failed`, `turn-opened` count unchanged at 1 (no
re-execution), no WARN, and `gc --dry-run` now lists it in `engine.db`. Two
executor processes over the same project did not re-drive or re-bill it.

D2, HEAD: `up hello -d --json` → 174-byte single-line JSON on stdout, 0 bytes
stderr. Removing `Logger.LogToStderr` makes the pin bite (30 stdout lines).

D3, HEAD: `signal run-4 '{"name":"go",…}'` against a real timer-parked run →
exit 1, stdout empty, stderr `NoMatchingWait: no wait point named "go" is open on
run run-4. Read \`smithers status run-4\` …`. Base → `go:`.

D4, HEAD: `run --resume run-1` (completed) → `Terminal completed` exit 0;
ControlSurface + Bin cover approve/deny/resume→{0,1,130}.

smoke.md 2b, 3, cancel-then-exit (clean HEAD, fresh project):
- 2b durable 75s timer: parked, child gone ~1s, resumed after deadline →
  `woke.txt=DONE`, both rows `completed`, no `interrupt-released`, no re-bill.
- 3 approval: parked on approval, `approve` → `decision.txt=approved`, both rows
  `completed`. Confirms `settledAlready` does not short-circuit suspended runs.
- cancel-then-exit: `up canceller -d`, `cancel run-5` → `Terminal cancelled`
  exit 0; engine pid + `sh` + `sleep 300` children all gone ~1s after cancel;
  journal `cancel-requested`/`cancelled`/`interrupted{cancelled}`; both rows
  `cancelled`.

## (3) Gates and ownership

- agent check/lint/circular exit 0; test 30 files / 428 tests, coverage 100%
  stmts (1273/1273), branches (592/592), funcs (433/433), lines (1146/1146).
- control check/lint/circular exit 0; test 27 files / 230 tests, above thresholds.
- cli check/lint/circular exit 0; test 36 files / 626 tests, above thresholds.
- check-docs exit 0 (16 checks); check-llms exit 0 (12 artifacts current).
- `generate-known-files.mjs` regenerates byte-identical; `smithers-build lint
  '//:knownFiles'` exit 0. `generate-docs-pages.mjs` idempotent (no diff).
- flows vitestCoverageIsolation 264/264 green (allowlist unchanged).
- apps/ui `check` exit 0 with the copied devkit projection.
- check-single-effect-version exit 0 (4.0.0-rc.108, 63 sources).
- Existing pins green: EngineParkAcrossProcesses, FailedRunPersistsAcrossProcesses,
  ApprovalResumeAcrossCompositions, engine-store InterruptReleaseReclaim.
- No test dropped or weakened: the only removed test lines are the
  `describe`/helper block for "an attached launch's exit status" being hoisted
  above the describe so the new `signal` describe can share `launch`/`stageUnservableSeat`;
  every prior `it` is retained.
- pnpm-lock.yaml, bun.lock, package.json, all manifests untouched.
- Invariants held: one cancellation path (Control.cancel → requestCancel →
  settleInterrupted unchanged; the guard fires only on crash-recovery of an
  already-terminal control row, not on cancellation); journal determinism and
  ownership fencing intact; capability-closed host unchanged.

Ownership: the diff touches `packages/control/src/ControlLive.ts` (1 line),
which is NOT in the declared ownedPaths (which lists
`packages/control/src/ControlError.ts` only). See finding F1.

## (4) Clean worktree

`git status --short` empty before overlays, after each restore, and after
teardown. HEAD `0fa6148b4b`, branch `phase7/cli-lifecycle`. All five edited src
files match committed HEAD (no lingering overlay).

## Findings

### F1 (minor). One line edited outside declared ownedPaths

`packages/control/src/ControlLive.ts:826` changed `name:` → `waitName:` at the
sole `NoMatchingWait` construction site. This file is not in the lane's
ownedPaths (`packages/control/src/**` is not listed; only `ControlError.ts`).
The edit is a mandatory consequence of the owned field rename — the package
would not compile otherwise — and the concurrent wave-6 lane (release-hygiene)
does not touch ControlLive.ts, so there is no merge collision. Flag for the
landing orchestrator; no code change required. (The rename is one of two valid
D3 shapes; the `_tag`-rendering shape in bin.ts alone would have avoided the
out-of-scope edit, but the chosen shape is cleaner and correct.)

## Observation (not a finding)

For a reclaimed released row whose control row is terminal, the engine row
reaches `completed` even when the control row reads `failed`/`cancelled`, so the
two rows diverge. This is deliberate, documented by the fixer, and a strict
improvement over the row staying `suspended`/`released` forever and never being
collected; `status`/`ps`/outcome all read the control row, which is preserved.
