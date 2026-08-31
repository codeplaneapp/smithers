# Phase 7 gate: smoke

Verdict: FAIL

All eight PLAN Phase 7 smoke items execute end to end against the working-tree
CLI, two real SQLite files, a real model seat, a real gateway, the built UI, and
the real GitHub and Linear APIs. The gate fails on the persisted state the most
basic item leaves behind: a run launched by `smithers run` or `smithers up` in
the local process is reported `completed` by the control plane, but the
launching process exits before the durable engine records the completion, so
the engine row is left `suspended`/`released`. Every later process that
composes an executor (`up`, `run`, `approve`, `serve`) claims that row, replays
the run's agent turn, fails to drain it with a schema error, and leaves it for
the next process. Two such runs exist in this project after 22 minutes
(`run-1`, `run-9`); `run-1` was re-driven by ten processes. `gc` never collects
them from `engine.db`, `status` reports their tokens multiplied by the replay
count, and the warning prints on stdout in the middle of `--json` output. The
four durable-park blockers from the 2026-08-30 smoke at `9c464343f0` are fixed
and are re-proven below against the real binary.

Previous evidence at `9c464343f0` is preserved as `smoke-prev-9c464343f0.md`,
`smoke-db-prev-9c464343f0/`, and `smoke-artifacts-prev-9c464343f0/`.

## Environment

| Item | Value |
| --- | --- |
| Clean checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-2` (written as `<ck>` below), `git status --short` empty |
| HEAD | `20b32c6316487497301db74ec70cbe951428ef53` (`v1/rc0-migration`, 2026-08-30 23:33 PDT), which contains the engine-park lane (`6199b80c24`) |
| Smoke project | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/phase7/smoke-db` (written as `<smoke>`), with `.flows/control.db` (253,952 bytes at the end) and `.flows/engine.db` (602,112 bytes) |
| Artefacts | `phase7/smoke-artifacts/`: `transcript.log` (every CLI command with UTC stamp, stdout, stderr, exit code, and wall time), `sm.sh` (the runner that wrote it), `item3-asker.sh`, `plan-hello.json`, `logs-run-1.json`, `logs-run-2-before-kill.json`, `events-run-3.json`, `approval-requested-run-5.json`, `approve-run-5.out`, `serve.log`, `up9.out`/`up9.err`, `ui-local.log`, `ui-local.png`, `ui-shot.mjs`, `final-db-state.json` |
| Host | macOS 26.2 (25C56), arm64, 1-minute load 1.97 at start and 2.66 at the end |
| Node | v24.18.0 |
| Bun | 1.4.0 |
| pnpm | `corepack pnpm` 11.24.0 on PATH; vitest 4.1.9 |
| CLI | `node --no-warnings <ck>/packages/cli/src/bin.ts`, cwd `<smoke>`, the invocation `packages/cli/test/EndToEnd.test.ts` uses; `--version` prints `smithers v1.0.0-rc.0` in 0.9 s |
| Model seat | `openai:gpt-5.6-luna` through `SMITHERS_OPENAI_AUTH=chatgpt` and `~/.codex/auth.json`; `doctor` reports `openai seats use the ChatGPT session`. `ANTHROPIC_API_KEY` unset. |
| Integrations | `GITHUB_TOKEN` from `gh auth token`; `LINEAR_API_KEY` exported |
| Date | 2026-08-31, 07:56 to 08:13 UTC |

Two traps recorded by the previous smoke were avoided up front rather than
re-measured: `<smoke>/.flows/` was created before the first command so
`Project.root` does not walk up to `~`, and `jj git init --colocate` was run in
`<smoke>` so the engine's snapshot boundary is the project, not the corrupt
colocated repository at `~/.jj`.

## Setup

```
mkdir -p smoke-db/.flows && cd smoke-db && jj git init --colocate
smithers --version                                  smithers v1.0.0-rc.0            exit 0, 0.9 s
smithers init hello --json                                                          exit 0, 1.2 s
{"created":true,"flowFile":"<smoke>/flows/hello/flow.mdx","gitignore":"unchanged","name":"hello","stateDirectory":"<smoke>/.flows"}
```

The scaffolded `flow.mdx` has no `model:` line; a markdown flow without one is
not launchable (`control.run.pending`, `SeatUnresolved`), so `model:
openai:gpt-5.6-luna` was added and four more flows were written beside it:

| Flow | Body |
| --- | --- |
| `hello` | `write` `result.txt` containing `OK` |
| `sleeper2` | `wait` 45 s (below `DurableClock`'s 60 s in-memory threshold), then `write` `woke2.txt` |
| `sleeper` | `wait` 150 s (a durable engine clock), then `write` `woke.txt` |
| `asker` | `ask` "Ship the phase7 smoke release?", then `write` `decision.txt` with the answer |
| `canceller` | `bash` `echo smoke-cancel-marker started; sleep 300; echo never` |

```
smithers ls --json        {"_tag":"flows","items":[asker, canceller, hello, sleeper, sleeper2]}   exit 0, 3.1 s
smithers doctor                                                                                    exit 0, 3.1 s
ok   registry: 5 flows discovered
ok   database <smoke>/.flows/control.db: 4 migrations applied, latest 1002
ok   database <smoke>/.flows/engine.db: 8 migrations applied, latest 4001
ok   node: v24.18.0
ok   jj: /opt/homebrew/bin/jj
ok   providers: OPENAI_API_KEY, CEREBRAS_API_KEY; openai seats use the ChatGPT session
```

## 1. Create and run a flow: PASS

The documented quick start (`docs/pages/index.mdx`) was written to
`<smoke>/quickstart.ts` verbatim apart from the tag names and run against the
working-tree packages through a `node_modules` symlink to
`<ck>/examples/node_modules`:

```
node --no-warnings quickstart.ts
Hello, Ada.                                                                          exit 0
```

The CLI path, from the `running-flows` guide:

```
smithers plan hello --json                                                           exit 0
smithers run '<approval payload>' --json                                             exit 3
{"_tag":"Parked","planId":"plan-1","receiptId":"approve:plan-1","status":"waiting-approval"}
smithers approve '<approval payload>' --scope run --json                             exit 0
{"_tag":"Accepted","receiptId":"approve:plan-1"}
smithers run '<approval payload>' --json                                             exit 0, 9.5 s
{"_tag":"Accepted","receiptId":"approve:plan-1","runId":"run-1"}
```

`result.txt` contains `OK`. `status run-1` immediately afterwards: `Verdict
completed`, `1 turns · 1 calls`, `Tokens 5,741 in / 123 out`. `logs run-1
--json` holds 36 events including `control.agent.model-settled`
(`durationMillis` 5,168, a real model call), `control.agent.cell-call-started
{"flowName":"write"}`, and `control.run.completed`. The `control.db` row reads
`completed`.

The same command also printed, on stdout before the receipt, `WARN An agent run
lifecycle event could not be journaled { runId: 'run-1', status: 'completed',
cause: InterruptError ... AgentSession.ts:880 }`, and the `engine.db` row read
`suspended` with `waiting_reason` `released`. That is defect D1 below; it does
not change what the run did, and it is what fails the gate.

## 2. Restart a process during execution: PASS

### 2a. SIGKILL during an in-memory 45 s wait (`sleeper2`, run-2)

```
smithers up sleeper2 -d --json                                                       exit 0, 6.4 s
{"detached":true,"logFile":"<smoke>/.flows/logs/run-2.log","runId":"run-2"}
```

12 s later: journal seq 21 `control.agent.cell-call-started {"flowName":"wait","input":{"seconds":45}}`,
engine row `('run-2','running', owner_pid 35832, heartbeat 1788163112823)`,
`pgrep` shows pid 35832 running `bin.ts run {...plan-2...}`.

```
kill -9 35832                                       (07:58:35Z; ps -p 35832 reports dead)
engine row after the kill: ('run-2','running', owner_pid 35832, heartbeat 1788163115831); woke2.txt absent
smithers run --resume run-2 --json                                                   exit 0, 75.5 s
{"_tag":"Accepted","receiptId":"cli:resume:run-2","runId":"run-2"}
```

`woke2.txt` contains `DONE`; both `flows_runs` rows read `completed`
(`finished_at_ms` 1788163192964). Journal after the kill:

```
22 control.run.resume            1788163120582
23 flows.engine.run-decision     1788163146631  stolen-and-activated, previousStatus running, owner pid 36251
32 control.agent.turn-opened     1788163146978
33 control.agent.model-settled   1788163146978  (same millisecond: replayed from the journal, no model call)
35 control.agent.cell-call-started wait 45      1788163146978
39 control.agent.cell-call-settled {"waitedSeconds":45}   1788163191823  (44.8 s later: the in-memory wait re-executed)
40 control.agent.cell-call-started write woke2.txt
58 control.run.completed         1788163192952
59 flows.engine.run-decision     1788163192964  transitioned completed
```

The 26 s between `control.run.resume` and the steal is the
`Ownership.heartbeatStaleAfter` bound the dead owner's last heartbeat had to
age past. `status run-2`: `completed`, `2 turns · 3 calls (0 refused, 1
duplicate)`, `Tokens 11,526 in / 474 out`.

### 2b. Durable park on a 150 s timer, process gone, continued after the deadline (`sleeper`, run-3)

This is the path the previous smoke failed.

```
smithers up sleeper -d --json                                                        exit 0, 6.3 s
{"detached":true,"logFile":"<smoke>/.flows/logs/run-3.log","runId":"run-3"}
```

25 s later no `bin.ts` process was alive and the rows read:

```
engine.db flows_runs:   ('run-3','suspended', waiting_reason 'timer', waiting_wake_at_ms 1788163399709, cancel_requested_at_ms NULL, owner NULL)
control.db flows_runs:  ('run-3','suspended')
flows_clock_deadlines:  due_at_ms 1788163399709, completed_at_ms NULL
journal: 17 flows.engine.clock-scheduled, 21 cell-call-started wait 150, 22 control.agent.aborted "Cell frame interrupted",
         24 control.run.waiting-approval, 25 flows.engine.run-decision transitioned suspended
```

No `flows.engine.interrupted {"outcome":"cancelled"}` and no
`cancel_requested_at_ms`: the park is a park. `ps` still labels a timer park
`waiting-approval` (the harness writes that status for every suspension), and
`signal run-3` at this point was refused (section 4).

28 s after the deadline passed:

```
smithers run --resume run-3 --json                                                   exit 0, 4.7 s
{"_tag":"Accepted","receiptId":"cli:resume:run-3:24","runId":"run-3"}
```

`woke.txt` contains `DONE`; both rows `completed` (`finished_at_ms`
1788163431887); the clock row is stamped `completed_at_ms 1788163430669`.
Journal:

```
27 flows.engine.deferred-completed  DurableClock/harness/wait/run-3/0/...   1788163430670
28 flows.engine.run-decision        wake-scheduled, reason clock
29 flows.engine.run-decision        claimed-and-activated, previousStatus suspended, owner pid 38906
30 control.run.resume
43 control.agent.model-settled      (replayed)
46 control.agent.cell-call-settled  wait -> {"waitedSeconds":150}           1788163431042  (replayed, no second wait)
47 control.agent.cell-call-started  write woke.txt
65 control.run.completed            1788163431876
66 flows.engine.run-decision        transitioned completed
```

`status run-3`: `completed`, `3m 07s`, `2 turns · 3 calls (0 refused, 1
duplicate)`. The transcript (`logs run-3`) shows `[+00:05] run.waiting-approval`
then `[+03:06] run.resume` and the replayed turn.

## 3. Resume a durable wait by delivering the awaited input: PASS

```
smithers up asker -d --json                                                          exit 0, 6.3 s
{"detached":true,"logFile":"<smoke>/.flows/logs/run-5.log","runId":"run-5"}
```

9.1 s later the engine row read `suspended`/`approval` with `waiting_token`
`ask/run-5/87caea8e...`, the control row `suspended`, and no `bin.ts` process
was alive. Journal: `14 control.approval.requested`, `18
control.agent.permission-required`, `20 control.agent.suspended`, `21
control.run.waiting-approval`, `22 flows.engine.run-decision transitioned
suspended`.

```
smithers ps --status waiting-approval --json     [run-5 asker waiting-approval]          exit 0
smithers status run-5                                                                  exit 0
Verdict   waiting-approval — asks: Ship the phase7 smoke release?
Unblock   smithers approve '{"target":{"_tag":"Node","runId":"run-5","requestId":"ask/run-5/87caea8e...","digest":"87caea8e...","envelope":{"capabilities":[],"flows":["ask"],"budget":{}}},"scope":"run","idempotencyKey":"approve:ask/run-5/87caea8e..."}' --scope run && smithers run --resume run-5
```

The payload printed by `status` is byte-identical to the `payload` field of the
journaled `control.approval.requested` event.

```
smithers approve '<that payload>' --json                                             exit 0, 34.1 s
{"_tag":"Accepted","receiptId":"approve:ask/run-5/87caea8e...","runId":"run-5"}
```

`decision.txt` contains `approved`; both rows `completed` (`finished_at_ms`
1788163550091); `control_grants` gained `('ask/run-5/87caea8e...',
'{"capabilities":[],"flows":["ask"],"budget":{}}', 'run', 1788163519048)`.
Journal:

```
23 control.approval.approved   1788163519049
24 control.run.resumed         1788163519052
25 flows.engine.run-decision   wake-scheduled, reason operator     1788163549128   (30 s later: the park-adoption bound)
26 flows.engine.run-decision   claimed-and-activated, owner pid 40080 (the approve process itself)
40 control.agent.cell-call-settled ask -> {"answer":"approved","approved":true}
41 control.agent.cell-call-started write decision.txt
58 control.run.completed       1788163550080
59 flows.engine.run-decision   transitioned completed
```

The `&& smithers run --resume run-5` the `Unblock` line suggests was not
needed: the deciding process continued the run, which is what rc-contract
section 5.1 promises. The 30 s before the wake is `AgentSession.hostsPark`
waiting out `Ownership.heartbeatStaleAfter` before adopting a park another
process recorded.

## 4. Deliver a signal: PASS

Against `run-4` (`canceller`) while its process was alive:

```
smithers signal run-4 '{"name":"go","payload":{"attempt":1}}' --json
{"_tag":"Accepted","receiptId":"cli:signal:run-4:d4476500","runId":"run-4"}       exit 0, 3.4 s
smithers signal run-4 '{"name":"go","payload":{"attempt":1}}' --json
{"_tag":"AlreadyApplied","receiptId":"cli:signal:run-4:d4476500","runId":"run-4"} exit 0, 3.2 s
smithers signal run-4 '{"name":"go","payload":{"attempt":2}}' --json
{"_tag":"Accepted","receiptId":"cli:signal:run-4:6bbf2c01","runId":"run-4"}       exit 0, 3.4 s
```

`control_run_messages` holds exactly two rows for run-4, one per distinct
payload, and the journal holds two `control.signal.delivered` events; the
replay appended nothing. Against runs in other states:

```
smithers signal run-3 '{"name":"go","payload":{"attempt":1}}' --json   (run-3 parked on a timer)
stderr: go:                                                                          exit 1, 3.0 s
smithers signal run-1 '{"name":"go","payload":{}}' --json              (control row completed)
{"_tag":"Terminal","runId":"run-1","status":"completed"}                             exit 0
smithers signal run-7 '{"name":"go","payload":{}}' --remote http://127.0.0.1:7351 --json   (cancelled)
{"_tag":"Terminal","runId":"run-7","status":"cancelled"}                             exit 0
```

The timer-parked refusal is the documented `NoMatchingWait`, and its rendering
is defect D3. No standard agent flow parks on `WaitFor` (`StandardFlows` ships
`wait` and `ask`), so a wake-on-signal cannot be reached from a markdown flow;
that path is covered by `packages/control/test/EngineWaits.test.ts` and
`e2e/faults/case04-restart-waiting-event.test.ts`, not by this smoke.

## 5. Cancel a run and prove terminal state and child cleanup: PASS

Two runs of `canceller`. On `run-4` the cancel landed 15 s after the `bash`
cell started but the process-tree snapshot was taken before the model call had
returned, so `run-6` repeats it with the tree captured while the child was
alive.

```
smithers up canceller -d --json                                                      exit 0, 7.1 s
{"detached":true,"logFile":"<smoke>/.flows/logs/run-6.log","runId":"run-6"}
```

20.6 s later (journal seq 19 `control.agent.cell-call-started
{"flowName":"bash","input":{"mode":"unhermetic","command":"echo
smoke-cancel-marker started; sleep 300; echo never"}}`):

```
pid    ppid   pgid   command
41279      1  41279  node .../bin.ts run {...plan-6...}            (engine owner_pid for run-6)
41834  41279  41834  /bin/sh -c echo smoke-cancel-marker started; sleep 300; echo never
41835  41834  41834  sleep 300
```

```
smithers cancel run-6 --json                       (08:07:02Z)                     exit 0, 3.2 s
{"_tag":"Terminal","runId":"run-6","status":"cancelled"}
```

6 s later: no `bin.ts run`, `sh`, or `sleep 300` process; pids 41834 and 41835
gone; no process matching `sleep 300` under ppid 1. Rows: engine
`('run-6','cancelled', cancel_requested_at_ms 1788163625616, finished_at_ms
1788163626033)`, control `cancelled`. Journal: `20
control.run.cancel-requested` (principal `local`/`operator`), `21
control.run.cancelled`, `25 flows.engine.interrupted {"outcome":"cancelled"}`.
The detached engine pid 41279 exited within 6.3 s of the cancel, which closes
the previous smoke's 4 min 33 s lingering-engine caveat. A second `cancel
run-6` answers `Terminal cancelled` again; `down --json` answers
`{"cancelled":[]}`.

`run-4` (same flow): `cancel` → `Terminal cancelled`, engine pid 37710 exited
within 6.3 s, both rows `cancelled`, journal `cancel-requested`, `cancelled`,
`interrupted cancelled`, no child left.

## 6. Inspect journal and events with the CLI: PASS

```
smithers status run-3                                                                exit 0
Verdict   completed — Woke and wrote woke.txt
Run       run-3 · sleeper · openai:gpt-5.6-luna · 3m 07s
Activity  2 turns · 3 calls (0 refused, 1 duplicate) · edits 1/1
Tokens    11,520 in / 320 out
smithers logs run-3          transcript: turn headers, model usage, cell text, calls with results,
                             [+00:05] run.waiting-approval, [+03:06] run.resume, [+03:07] run.completed    exit 0
smithers events run-3        59 events, 25 distinct kinds (alias of logs --json)                          exit 0
smithers output run-3 result
result success
Woke and wrote woke.txt                                                              exit 0
smithers output run-5 result
result success
approved                                                                             exit 0
smithers ps --json           nine runs with status, planId, planDigest, steering.pending                  exit 0
```

Direct `sqlite3` reads of `engine.db` match the CLI: `flows_journal_events`
per run at the end: run-1 162, run-2 53, run-3 59, run-4 26, run-5 58, run-6
24, run-7 11, run-8 36, run-9 36, plus two events per plan
(`final-db-state.json`). `control.db` `flows_journal_events` is empty; the CLI
reads the engine journal.

## 7. Gateway and UI against the run: PASS

```
smithers serve --host 127.0.0.1 --port 7351        (background; health answered after 3.5 s)
smithers serve listening on http://127.0.0.1:7351
  /rpc  /rpc/ws  /projections  /projections/ws  /sync  /sync/ws  /health
  auth  none (loopback only)

curl -i http://127.0.0.1:7351/health
HTTP/1.1 200 OK
{"workspaceHash":"ad528ba4146165d9","gatewayId":"cli-42422","protocolVersion":"1","version":"1.0.0-rc.0"}

curl -X POST -H 'content-type: application/json' --data '{}' /rpc
HTTP/1.1 400 Bad Request
{"_tag":"flows/gateway/GatewayError","code":"malformed_request","message":"POST /rpc carries no RPC request message","cause":null}

curl -X POST -H 'content-type: application/ndjson' --data-binary '{"_tag":"Request","id":"1","tag":"List","payload":{"_tag":"runs"},...}\n' /rpc
HTTP/1.1 200 OK
{"_tag":"Exit","requestId":"1","exit":{"_tag":"Success","value":{"_tag":"runs","items":[run-1 ... run-6]}}}

curl -i /projections                    HTTP/1.1 404 Not Found (no projection named)
```

The `POST /rpc {}` answer is a typed 400 where the previous smoke saw a 500.

Remote CLI from `phase7/smoke-remote/` (no `flows/`, its own empty `.flows/`
marker), each command a separate process over the shipped `ControlClient`:

```
smithers ls --remote http://127.0.0.1:7351 --json         the five flows                          exit 0
smithers ps --remote ... --json                            run-1..run-6 with their statuses        exit 0
smithers status run-3 --remote ...                         the same diagnosis card as locally      exit 0
smithers logs run-5 --remote ... --json                    58 events                               exit 0
smithers up hello --remote ... --json                      {"_tag":"Accepted","receiptId":"approve:plan-7","runId":"run-7"}   exit 0, 1 s
smithers status run-7 --remote ...                         Verdict running · 1 turns · 0 calls
smithers cancel run-7 --remote ... --json                  {"_tag":"Terminal","runId":"run-7","status":"cancelled"}          exit 0
smithers up hello --remote ... --json                      {"_tag":"Accepted","receiptId":"approve:plan-8","runId":"run-8"}   exit 0, 1 s
   (ps --remote polled every 2 s)                          run-8 completed after 5.1 s
smithers status run-8 --remote ...                         Verdict completed — Created result.txt containing exactly OK
                                                           Tokens 5,741 in / 171 out
smithers logs run-8 --remote ... --json                    36 events; model-settled and the write call present
```

`run-7` and `run-8` were planned, approved, launched, executed, and (run-7)
cancelled entirely through the gateway: the serve process (pid 42422) resolved
the seat and ran them, `result.txt`'s mtime moved from 00:57:07 to 01:10:02,
and both engine rows are terminal with `finished_at_ms` set. `up --remote`
returns after admission because the local process does not own the executor,
which is the contract's wording. `kill -TERM 42422` stopped the gateway in
0.2 s.

UI, two proofs at this HEAD:

```
cd apps/ui && corepack pnpm run proof:gateway                                        exit 0
5. approve: one call, no second resume
  ok  the decision was ONE relayed call
  ok  the gateway resumed the run on the caller's behalf
8. cancel
  ok  the cancel is durable: the run reads cancelled
Relayed procedures: List, Plan, Approval.Submit, Run, Projection.Snapshot, Projection.Snapshot, Approval.Submit, Projection.Snapshot, Projection.Snapshot, Cancel, Projection.Snapshot
PROOF PASSED

cd apps/ui && corepack pnpm run build:web           vite built in 676 ms, exit 0
dist/__build.json: {"app":"smithers-ui","gitSha":"20b32c6316487497301db74ec70cbe951428ef53","builtAt":"2026-08-31T08:08:28.341Z"}

SMITHERS_LOCAL_MODE=offline bun src/bun/serve.ts   SMITHERS_LOCAL_ORIGIN=http://127.0.0.1:62164 after 0.3 s
curl -s -o /dev/null -w '%{http_code}' $ORIGIN/                200
curl ... $ORIGIN/api/bootstrap (no session header)             401
```

Loaded in headless Google Chrome through Playwright 1.62.1
(`smoke-artifacts/ui-shot.mjs`, screenshot `smoke-artifacts/ui-local.png`): page
title `Smithers`; the sidebar renders `REPOS`, `Select a repo`, `New tab`; the
main pane renders the card `Smithers initialized successfully` with a `Details`
disclosure, the notice `This host doesn't provide Smithers identity, so GitHub
sign-in and jjhub account features are unavailable. Commands supported by this
host remain available below.`, a `Select a repo` picker, and the composer `Ask
Smithers to work on something...` with a `Chat` mode button. The page made
`GET /api/bootstrap` 200, `GET /api/repos` 200, `GET /api/harnesses` 200 with
the `smithers-local-session` token the document carried; zero console errors,
zero failed requests. The local UI host serves repositories, targets,
terminals, and harnesses; it does not connect to `smithers serve`, so the
UI-to-gateway evidence is the seam proof above (`docs/LOCAL-APP.md`).

## 8. Exercise one real integration: PASS

```
cd packages/integrations
GITHUB_TOKEN="$(gh auth token)" corepack pnpm exec vitest run test/GitHubLive.test.ts --coverage.enabled=false
 Test Files  1 passed (1)      Tests  4 passed (4)      Duration  2.04s                exit 0
corepack pnpm exec vitest run test/LinearLive.test.ts --coverage.enabled=false
 Test Files  1 passed (1)      Tests  4 passed (4)      Duration  1.27s                exit 0
```

Both against `api.github.com` and `api.linear.app` with the credentials named
in the environment table. No ENV-SKIP.

## Defects found

### D1. A locally launched run's engine row is never finalized, and every later executor re-drives it

Evidence, run-1 (foreground `smithers run`) and run-9 (`smithers up -d`):

```
run-1 journal:
34 control.run.completed              1788163027537
35 flows.engine.run-decision          1788163027551  interrupt-released, owner pid 35089 (the launching process)
36 flows.engine.run-decision          1788163098632  claimed-and-activated, previousStatus suspended, owner pid 35766 (`up sleeper2`)
40..52 control.agent.discipline-armed ... turn-opened, model-settled (same ms), cell-call-started write, cell-call-settled, resolved
53 flows.engine.run-decision          1788163129585  stolen-and-activated, evidence same-host-pid-dead, owner pid 36251 (`run --resume run-2`)
... the same block for pids 37129, 37667, 38906, 39558, 40080, 41241, 42422 (`serve`), 44232
run-9 journal:
34 control.run.completed              1788163889010
35 flows.engine.run-decision          1788163889024  interrupt-released
```

Compare the runs settled inside a process that stayed alive or was a resumer:
run-2 (`control.run.completed` at ...952, `transitioned completed` at ...964),
run-3, run-5, and run-8 (gateway-hosted). Same code, same 10 to 14 ms window,
different winner.

Mechanism, at the source. `packages/cli/src/Command.ts` `settled`/`awaitRun`
(lines 207-231) returns on `control.run.completed`, which `AgentSession` emits
when the agent resolves; the command's scope then closes and the executor's
driver is interrupted while `engine.execute` is still recording the run's
`Complete` result. The launching process logs `WARN An agent run lifecycle
event could not be journaled { runId, status: 'completed', cause:
InterruptError }` from `AgentSession.ts:880` and the engine journals
`interrupt-released`. The row is now `suspended`/`released` with no result, so
every later process that composes an executor claims it through the ordinary
reclaim path, replays the whole agent turn (no model call, no re-write:
`result.txt`'s mtime did not move across ten replays), and then fails to
settle it:

```
[01:08:27.913] WARN (#944): engine-store: coordinated drain failed for run-1 SchemaError: Expected JSON value
  at ["exit"]["cause"][0]["error"]                     (packages/engine-store/src/internal/RunCoordinator.ts:89)
```

Consequences measured in this project: run-1 carries 162 journal events
against 36 for an untouched `hello` run and 16 `flows.engine.run-decision`
records across 11 pids; `status run-1` reported `6 turns · 6 calls (0 refused,
5 duplicate)` and `Tokens 34,446 in / 738 out` (5,741 × 6) after six replays;
`gc --older-than 0s --dry-run --json` lists run-1 for `control.db` and omits it
for `engine.db`; the engine row reads `running` under the pid of whichever
process last claimed it (44232, already dead, at the end); `down` answers
`{"cancelled":[]}` because the control row is `completed`. Every `up`, `run`,
`approve`, and `serve` in this project will keep doing this, and the count
grows by one for every run launched locally.

### D2. Warnings print on stdout in the middle of `--json` output

```
smithers up hello -d --json >up9.out 2>up9.err        exit 0, stdout 1773 bytes, stderr 0 bytes
up9.out line 1:  [01:11:20.231] WARN (#1044): engine-store: coordinated drain failed for run-1 SchemaError: Expected JSON value
up9.out last line: {"detached":true,"logFile":"<smoke>/.flows/logs/run-9.log","runId":"run-9"}
```

`packages/cli/src/bin.ts` (lines 33-40) states that the runtime logger writes to
stdout, that this puts log lines in a `--json` document, and that reporting was
disabled for that reason; `Effect.logWarning` calls in `@smthrs/engine-store`
and `@smthrs/agent` still reach stdout. A script parsing `--json` output with
`JSON.parse` fails on every command that composes an executor while a D1 row
exists.

### D3. `NoMatchingWait` renders as the signal name and nothing else

`smithers signal run-3 '{"name":"go",...}'` against a timer-parked run exits 1
with stderr `go: `. `packages/control/src/ControlError.ts:182` declares the
error with a `name: Schema.String` field, which shadows `Error.prototype.name`,
and `bin.ts` `report` prints `${error.name}: ${error.message}`, so the operator
reads the signal's name followed by an empty message instead of
`no_matching_wait` and the run's actual wait reason.

### Observations that are not blockers

- `GET /projections` with no projection name answers 404 with an empty body,
  unchanged from the previous smoke.
- `ps` and `status` label a timer park `waiting-approval`; `status run-3` while
  parked was not captured, `ps` was.
- The `smithers init` template ships no `model:` line and is not launchable as
  scaffolded; the previous smoke recorded the same.
- `up --remote` returns after admission rather than settlement. The contract
  says `run` blocks "when the local process owns the executor", and a remote
  caller does not.

## Final state

`ps --json` at the end: run-1 completed, run-2 completed, run-3 completed,
run-4 cancelled, run-5 completed, run-6 cancelled, run-7 cancelled, run-8
completed, run-9 completed. `engine.db flows_runs`: run-1 `running` (owner pid
44232, dead), run-9 `suspended`/`released`, every other row terminal with
`finished_at_ms`. `flows_clock_deadlines`: one row (run-3), `completed_at_ms`
set. `control_run_messages`: two rows (run-4). `control_grants`: nine plan
grants plus the run-5 ask grant. Files in the project: `result.txt` `OK`,
`woke.txt` `DONE`, `woke2.txt` `DONE`, `decision.txt` `approved`. The gateway
and the UI server were stopped; no `bin.ts` process remained.

## Blockers for the fix lane

1. D1: a run launched in the local process (`run <payload>`, `up`, `up -d`)
   settles `control.run.completed` and the launching process exits before the
   engine records the completion; the engine row is left `suspended`/`released`,
   every later executor process claims and replays it, and the drain fails with
   `SchemaError: Expected JSON value at ["exit"]["cause"][0]["error"]`. Pin it
   with a real-binary test that launches `hello` once and asserts the engine
   row is `completed` with `finished_at_ms` set, then that a second executor
   process records no `claimed-and-activated` for it.
2. D1's second half: a released row whose control row is already terminal must
   not be re-driven by every process, and `gc` must be able to collect it.
3. D2: `Effect.logWarning` output reaches stdout under `--json`.
4. D3: `NoMatchingWait`'s `name` field shadows `Error.name`; the CLI prints
   `go: `.
