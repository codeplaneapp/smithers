# Phase 7 gate: smoke

Verdict: FAIL

Two of the eight PLAN Phase 7 smoke items pass only halfway. A run that parks
on a durable wait (a `wait` longer than 60 s, or an in-run `ask` approval) is
never continued after the parking process exits: the engine row is finalized
`cancelled` at exit, and every resumer (`smithers run --resume`, `smithers
approve`) accepts the request, flips the control row to a non-terminal status,
and then hangs forever with no output. The rows then cannot be cancelled again
because `cancel` and `down` replay the earlier receipt. The other six items
pass against the working-tree CLI, real SQLite files, a real model seat, a real
gateway, and real GitHub and Linear APIs.

## Environment

| Item | Value |
| --- | --- |
| Clean checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout` |
| HEAD | `9c464343f0cfada6aa36f0a08144ed7cf1f0ce14` (`v1/rc0-migration`) |
| Smoke project (databases) | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/phase7/smoke-db` with `.flows/control.db` (245,760 bytes at the end) and `.flows/engine.db` (356,352 bytes) |
| Node | v24.18.0 |
| pnpm | 11.24.0 on PATH; `corepack pnpm` resolves 11.21.0 from `packageManager` |
| Bun | 1.4.0 |
| CLI | `node --no-warnings <checkout>/packages/cli/src/bin.ts` run with `cwd` = the smoke project (the same invocation `packages/cli/test/EndToEnd.test.ts` uses); `--version` prints `smithers v1.0.0-rc.0` |
| Model seat | `openai:gpt-5.6-luna` through `SMITHERS_OPENAI_AUTH=chatgpt` and the Codex session at `~/.codex/auth.json`. `OPENAI_API_KEY` is exported but the account answers `credit_balance_exhausted`; `ANTHROPIC_API_KEY` is not exported. |
| Integrations | `GITHUB_TOKEN` from `gh auth token`; `LINEAR_API_KEY` exported |
| Date | 2026-08-30, 16:31 to 17:25 PDT |
| Host load | 1-minute load average 3.9 at the start |

Artefacts: `phase7/smoke-artifacts/` holds the plan card, the run-2 and run-3
event dumps, the stderr of the failing commands, the serve banner, the UI
screenshot, and `final-db-state.json` (both `flows_runs` tables, event counts,
clock deadlines, messages, grants).

## Setup

```
mkdir -p smoke-db/.flows
node --no-warnings $CK/packages/cli/src/bin.ts init hello --json
```

```
{"created":true,"flowFile":".../smoke-db/flows/hello/flow.mdx","gitignore":"skipped","name":"hello","stateDirectory":".../smoke-db/.flows"}
```

Exit 0. `init` created both SQLite files. `doctor` (exit 0) reported
`registry: 4 flows discovered`, `control.db: 4 migrations applied, latest
1002`, `engine.db: 8 migrations applied, latest 4001`, `node: v24.18.0`,
`jj: /opt/homebrew/bin/jj`, `providers: OPENAI_API_KEY, CEREBRAS_API_KEY`, and
a `warn smithers 0.x` line for `/Users/williamcory/smithers.db`.

Two environment traps were hit before the first run and are recorded because
each cost a real operator the same time:

1. Without a project marker in `smoke-db`, `smithers --version` hung for more
   than 10 minutes (`sample` showed the event loop inside `fs.stat`
   callbacks). `Project.root` walked up to `~`, which holds both `.flows/`
   and the `~/flows` repository, and discovery scanned that tree. `--version`
   does not need discovery. Creating `smoke-db/.flows/` pins the root and
   `--version` answers in 1.1 s.
2. The first run (run-1) failed inside the engine's snapshot boundary with
   `@smthrs/jj/JjError: jj snapshot: Internal error: Object
   881e9dd212dc34ee037c6d2287a70f71fe59978c of type commit not found`. `jj`
   walked up from the project to `/Users/williamcory/.jj`, a corrupt colocated
   repository at `$HOME`. `jj git init --colocate` inside `smoke-db` contained
   the snapshot boundary to the project and every later run passed the
   boundary. The engine snapshots whatever repository encloses the project;
   nothing pins it to the project root.

Flow files written under `smoke-db/flows/` (markdown flows per the
`smithers init` template, with a `model:` frontmatter line because a markdown
flow without one fails `SeatUnresolved`): `hello` (write `result.txt`),
`sleeper` (`wait` 150 s then write `woke.txt`), `sleeper2` (`wait` 45 s then
write `woke2.txt`), `asker` (`ask` then write `decision.txt`), `canceller`
(`bash` `echo smoke-cancel-marker started; sleep 300; echo never`).
`smithers ls --json` listed all five (exit 0).

## 1. Create and run a flow: PASS

```
plan hello --json                         # exit 0, prints the PlanCard and approval payload
run '<approval payload>' --json           # exit 3
{"_tag":"Parked","planId":"plan-1","receiptId":"approve:plan-1","status":"waiting-approval"}
approve '<approval payload>' --scope run --json   # exit 0
{"_tag":"Accepted","receiptId":"approve:plan-1"}
SMITHERS_OPENAI_AUTH=chatgpt run '<approval payload>' --json   # exit 0, run-1
```

run-1 failed at the jj snapshot boundary (trap 2 above). After `jj git init
--colocate`:

```
SMITHERS_OPENAI_AUTH=chatgpt up hello --json
{"_tag":"Accepted","receiptId":"approve:plan-2","runId":"run-2"}
```

Exit 0 in 7.0 s wall clock. `result.txt` contains `OK`. `logs run-2 --json`
holds 36 events; `control.agent.model-settled` records a real model call
(`durationMillis: 3247`, `inputTokens: 5722`, `outputTokens: 121`,
`reasoningTokens: 82`) whose cell was
`await ctx.call("write", { path: "result.txt", content: "OK" })`, followed by
`control.agent.cell-call-started {"flowName":"write"}` and
`control.run.completed {"status":"completed"}`. `ps` reports `run-2 hello
completed`.

The unapproved `run` exiting 3 and the approved `run` launching is the
plan-level approval gate working across processes.

## 2. Restart a process during execution: PASS for an in-memory wait, FAIL for a durable park

### 2a. SIGKILL during a 45 s wait (`sleeper2`, run-4): PASS

```
SMITHERS_OPENAI_AUTH=chatgpt up sleeper2 -d --json
{"detached":true,"logFile":".../.flows/logs/run-4.log","runId":"run-4"}
```

Ten seconds later the journal showed `control.agent.cell-call-started
{"flowName":"wait","input":{"seconds":45}}` and the engine row was
`('run-4', 'running', owner_pid 5506, heartbeat 1788134868520)`.

```
kill -9 5506
```

`ps -p 5506` reported the pid dead. The engine row stayed `('run-4',
'running', 5506, heartbeat 1788134879556)`, the control row `running`,
`woke2.txt` absent.

```
SMITHERS_OPENAI_AUTH=chatgpt run --resume run-4 --json
{"_tag":"Accepted","receiptId":"cli:resume:run-4","runId":"run-4"}
```

Exit 0 after 1 min 5 s. `woke2.txt` contains `DONE`. Journal after the kill,
from `engine.db`:

```
1788134893029 control.run.resume
1788134910076 flows.engine.run-decision {decision: stolen-and-activated, previousStatus: running, owner: {pid: 5612}}
1788134910430 control.agent.turn-opened
1788134910430 control.agent.model-settled   (same millisecond: replayed from the journal, no model call)
1788134910431 control.agent.cell-call-started {"seconds": 45, "reason": "phase7 kill smoke"}
1788134955235 flows.engine.attempt-finished  (44.8 s later: the wait re-executed)
1788134955439 control.agent.cell-call-started {"path": "woke2.txt", "content": "DONE"}
1788134956010 control.run.completed {"status": "completed"}
```

Both `flows_runs` rows read `completed`. `status run-4` prints `Verdict
completed`, `2 turns · 3 calls (0 refused, 1 duplicate)`, `Tokens 11,526 in /
370 out`; the transcript shows `[+00:44] run.resume` between turn 1 and the
replayed turn 2.

### 2b. Durable park on a 150 s wait (`sleeper`, run-3): FAIL

`DurableClock.sleep` runs waits of 60 s or less in memory and schedules an
engine clock above that, so this is the only path that exercises a durable
timer park.

```
SMITHERS_OPENAI_AUTH=chatgpt up sleeper -d --json
{"detached":true,"logFile":".../.flows/logs/run-3.log","runId":"run-3"}
```

Within 5 s the model called `wait` with `{seconds: 150}`. Journal:

```
flows.engine.clock-scheduled {clockName: "harness/wait/run-3/0/aedde841.../0", dueAtMs: 1788133788575}
control.agent.aborted {"reason": "Cell frame interrupted"}
control.run.waiting-approval {"runId": "run-3"}
flows.engine.interrupted {"outcome": "cancelled", "interruptedAtMs": 1788133638596, "owner": {"pid": 3765}}
```

The detached process exited on its own at the park. `ps` reported
`waiting-approval` (the harness writes that status for every suspension, timer
included), `status run-3` printed `Verdict waiting-approval — a permission gate
is pending`, and `engine.db` read:

```
flows_runs:            ('run-3', 'cancelled', waiting_reason NULL, owner NULL)
flows_clock_deadlines: ('run-3', due_at_ms 1788133788575, completed_at_ms 1788133638596)
```

The deadline row was stamped completed at the interrupt time, 150 s before it
fell due, and the run row was finalized `cancelled` rather than left
`suspended`.

Resume, started after the deadline had passed:

```
SMITHERS_OPENAI_AUTH=chatgpt run --resume run-3 --json
```

The command journaled `control.run.resume` at 1788133935601, flipped the
control row to `running`, and then produced nothing: no stdout, empty stderr,
0.0 % CPU, `sample` showed the event loop idle in `kevent`, and no further
journal event for run-3 for 14 minutes until the process was killed by hand.
`woke.txt` was never written. The engine row stayed `cancelled`.

## 3. Resume a durable wait by delivering the awaited input: FAIL

The plan-level gate in section 1 delivers an approval and launches. The in-run
gate does not continue.

```
SMITHERS_OPENAI_AUTH=chatgpt up asker -d --json
{"detached":true,"logFile":".../.flows/logs/run-5.log","runId":"run-5"}
```

19 s later `ps` reported `waiting-approval`. The journal held
`control.approval.requested` with `question: "Ship the phase7 smoke release?"`
and the exact payload:

```
{"target":{"_tag":"Node","runId":"run-5","requestId":"ask/run-5/87caea8e...","digest":"87caea8e...","envelope":{"capabilities":[],"flows":["ask"],"budget":{}}},"scope":"run","idempotencyKey":"approve:ask/run-5/87caea8e..."}
```

followed by `control.agent.permission-required`, `control.agent.suspended`,
`control.run.waiting-approval`, and `flows.engine.interrupted {"outcome":
"cancelled"}`. The detached process exited; the engine row read `('run-5',
'cancelled')`.

```
approve '<that payload>' --json
```

The decision landed durably within 0.5 s: `control_grants` gained the row
`('ask/run-5/87caea8e...', '{"capabilities":[],"flows":["ask"],"budget":{}}',
'run', 1788135037821)` and the journal gained `control.approval.approved` and
`control.run.resumed` at 1788135037822. The `approve` process then never
returned. It was killed by the 120 s command timeout (exit 143). No
`decision.txt`.

```
SMITHERS_OPENAI_AUTH=chatgpt run --resume run-5 --json     # bounded to 80 s, then killed
```

Journaled `control.run.resume` at 1788135207442, control row `running`,
engine row `cancelled`, no further event, no output. The approval is
delivered; the run is never continued.

### Consequence: the parked rows cannot be terminated

```
cancel run-3 --json   -> {"_tag":"Terminal","runId":"run-3","status":"cancelled"}      (first time, before the resume attempt)
cancel run-3 --json   -> {"_tag":"AlreadyApplied","receiptId":"cli:cancel:run-3"}     (after the row regressed to running)
cancel run-5 --json   -> {"_tag":"Terminal","runId":"run-5","status":"cancelled"}
down --json           -> both receipts AlreadyApplied
```

After each of these the control rows read `run-3 running`, `run-5 running`
(`flows_runs`), and `ps` prints them as `accepted`. Later CLI processes that
compose an executor take up the standing resume delegation again and rewrite
the status, which is how run-3 went from `cancelled` back to `running` and why
run-5 read `running` seconds after its `Terminal cancelled` receipt. `cancel`
and `down` key on `cli:cancel:<runId>`, so the replayed receipt masks the
regressed row and no CLI command can reach a terminal state for either run.
`gc --older-than 0s --dry-run` lists `run-1, run-2, run-4, run-6` for
`control.db`; run-3 and run-5 stay.

## 4. Deliver a signal: PASS

Against run-6 (`canceller`) while its shell child was alive:

```
signal run-6 '{"name":"go","payload":{"attempt":1}}' --json
{"_tag":"Accepted","receiptId":"cli:signal:run-6:d4476500","runId":"run-6"}
signal run-6 '{"name":"go","payload":{"attempt":1}}' --json
{"_tag":"AlreadyApplied","receiptId":"cli:signal:run-6:d4476500","runId":"run-6"}
signal run-6 '{"name":"go","payload":{"attempt":2}}' --json
{"_tag":"Accepted","receiptId":"cli:signal:run-6:6bbf2c01","runId":"run-6"}
```

All exit 0. `control_run_messages` holds exactly two rows for run-6, one per
distinct payload; the replay appended nothing.

## 5. Cancel a run and prove terminal state and child cleanup: PASS, with one caveat

```
SMITHERS_OPENAI_AUTH=chatgpt up canceller -d --json
{"detached":true,"logFile":".../.flows/logs/run-6.log","runId":"run-6"}
```

8 s later the process tree held the engine (pid 10105), the shell
`/bin/sh -c echo smoke-cancel-marker started; sleep 300; echo never` (pid
10263, ppid 10105, pgid 10263), and `sleep 300` (pid 10264, ppid 10263).

```
cancel run-6 --json
{"_tag":"Terminal","runId":"run-6","status":"cancelled"}
```

Exit 0. Six seconds later pids 10263 and 10264 were gone, no `sleep 300`
survived, `ps -axo pid,ppid` showed no orphan of either under ppid 1, and both
rows read `cancelled` with `cancel_requested_at_ms` set on the engine row.

Caveat: the detached engine process 10105 itself stayed alive at 0.1 to 1.2 %
CPU with ppid 1 for 4 min 33 s after its only run was cancelled, until it was
killed by hand with SIGKILL. A detached `run` whose run has settled should
exit.

## 6. Inspect journal and events with the CLI: PASS

```
status run-4          # exit 0
Verdict   completed — {"bytesWritten":4,"created":true,"path":"woke2.txt"}
Run       run-4 · sleeper2 · openai:gpt-5.6-luna · 1m 47s
Activity  2 turns · 3 calls (0 refused, 1 duplicate) · edits 1/1
Tokens    11,526 in / 370 out
Output    {"bytesWritten":4,"created":true,"path":"woke2.txt"}

logs run-4            # exit 0; transcript with turn headers, model usage, cell text, calls, and the run.resume line
events run-4          # alias of logs --json; 53 events for run-4
output run-4 result   # exit 0
result success
{"bytesWritten":4,"created":true,"path":"woke2.txt"}
```

Direct reads of the SQLite files match the CLI (`final-db-state.json`):
`flows_journal_events` per run: run-1 19, run-2 36, run-3 27, run-4 53, run-5
26, run-6 25, plus two events per plan.

## 7. Gateway and UI against the run: PASS for the gateway and the UI seam; the web bundle needs its Worker

```
serve --host 127.0.0.1 --port 7351
smithers serve listening on http://127.0.0.1:7351
  /rpc  /rpc/ws  /projections  /projections/ws  /sync  /sync/ws  /health
  auth  none (loopback only)

curl -i http://127.0.0.1:7351/health
HTTP/1.1 200 OK
{"workspaceHash":"ad528ba4146165d9","gatewayId":"cli-11996","protocolVersion":"1","version":"1.0.0-rc.0"}
```

From a different directory with no project of its own:

```
ps --remote http://127.0.0.1:7351 --json
[(run-1, hello, failed), (run-2, hello, completed), (run-3, sleeper, accepted), (run-4, sleeper2, completed), (run-5, asker, accepted), (run-6, canceller, cancelled)]
status run-4 --remote http://127.0.0.1:7351        # the same diagnosis card as locally, exit 0
logs run-6 --remote http://127.0.0.1:7351 --json   # 25 events, last flows.engine.interrupted
```

Raw HTTP: `GET /projections` with no projection name answered 404 with an
empty body; `POST /rpc` with body `{}` answered `500 Internal Server Error`
rather than a 400.

UI seam, the app's own end-to-end proof (real gateway over real SQLite, the
Worker's relay, `createGatewaySeam` unmodified):

```
cd apps/ui && corepack pnpm run proof:gateway
...
5. approve: one call, no second resume
  ok  the decision was accepted
  ok  the decision was ONE relayed call
  ok  the gateway resumed the run on the caller's behalf
8. cancel
  ok  the cancel is durable: the run reads cancelled
Relayed procedures: List, Plan, Approval.Submit, Run, Projection.Snapshot, Projection.Snapshot, Approval.Submit, Projection.Snapshot, Projection.Snapshot, Cancel, Projection.Snapshot
PROOF PASSED
```

Exit 0 in 1.9 s. The script's own header says `Run it with: bun
apps/ui/scripts/gateway-run-proof.ts`; under Bun it exits with
`@smthrs/database/UnsupportedDatabase unsupported_runtime`, and under plain
Node it fails on the extensionless import `state/controller/gateway`. Only the
declared `tsx` script runs it.

Web bundle: `apps/ui/dist` (built 2026-08-30T22:50:32Z at this HEAD by an
earlier gate) served statically on 127.0.0.1:7352. `index.html` and the three
entry assets answered 200. Loaded in headless Google Chrome through Playwright
1.62.1 (screenshot `smoke-artifacts/ui-static.png`): the page title is
`Smithers` and the body renders the app's error card `Smithers failed to
start Error: load runtime bootstrap: Runtime bootstrap failed with HTTP 404`.
The bundle requested `GET /api/bootstrap` (404 from the static host) and
`POST /api/client-errors` (501). Those routes belong to the product Worker in
`apps/server`; the bundle does not talk to `smithers serve` directly, so a
static host cannot boot it. That is the designed shape and not counted as a
failure; the seam proof above is the UI-to-gateway evidence.

## 8. Exercise one real integration: PASS

```
cd packages/integrations
GITHUB_TOKEN="$(gh auth token)" corepack pnpm exec vitest run test/GitHubLive.test.ts --coverage.enabled=false
 Test Files  1 passed (1)
      Tests  4 passed (4)
   Duration  1.66s

corepack pnpm exec vitest run test/LinearLive.test.ts --coverage.enabled=false
 Test Files  1 passed (1)
      Tests  4 passed (4)
   Duration  1.11s
```

Both exit 0, both against api.github.com and api.linear.app with the
credentials named in the environment table. No ENV-SKIP.

## Final state

`ps --json` at the end: run-1 failed, run-2 completed, run-3 accepted, run-4
completed, run-5 accepted, run-6 cancelled. `control.db flows_runs`: run-3
and run-5 `running`. `engine.db flows_runs`: run-4 `completed`, every other
row `cancelled` (including run-2, whose control row is `completed`, because
the executing process finalizes the engine row at exit). Files in the project:
`result.txt` (`OK`), `woke2.txt` (`DONE`); `woke.txt` and `decision.txt` were
never written. The gateway, the static server, and the lingering engine were
stopped; no `bin.ts` process remained.

## Blockers for the fix lane

1. A durable park is finalized at process exit. When the process that parked a
   run (timer above the 60 s in-memory threshold, or an in-run `ask`) exits,
   `flows.engine.interrupted {"outcome":"cancelled"}` is journaled, the
   engine `flows_runs` row becomes `cancelled` with no `waiting_reason`, and
   the clock deadline row is stamped completed at the interrupt time.
   Contrast run-4, where SIGKILL left the row `running` and resume worked.
2. Every resumer hangs silently on such a row. `run --resume` and `approve`
   journal their event, write the control row to `running`, then block forever
   at 0 % CPU with no stdout, no stderr, and no warning. The approval decision
   itself is durable; the run never continues.
3. Stale resume delegations are re-driven by unrelated CLI processes, which
   rewrites a cancelled control row back to `running`, and `cancel`/`down`
   then answer `AlreadyApplied` from the `cli:cancel:<runId>` receipt. Two
   runs in this project are permanently non-terminal and `gc` skips them.
4. A detached engine whose run was cancelled keeps running (4 min 33 s
   observed, killed by hand).

Observations that are not blockers: `--version` runs registry discovery and
hangs when the resolved root is `~`; the snapshot boundary uses whatever jj
repository encloses the project; `POST /rpc {}` answers 500; the UI proof
script's documented `bun` command does not run it.
