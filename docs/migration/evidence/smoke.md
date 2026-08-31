# Phase 7 gate: smoke

Verdict: PASS

All eight PLAN Phase 7 smoke items executed end to end at `cd14388ed7` against
the working-tree CLI, two real SQLite files, a real model seat, a real gateway,
the built UI loaded in headless Chrome, and the real GitHub and Linear APIs.
The four blockers the previous smoke (`20b32c6316`) recorded are gone and are
re-proven below against the real binary: a locally launched run's engine row
is now `completed` with `finished_at_ms` set and no `interrupt-released`
decision (D1); a later executor process adds nothing to earlier runs (D1 second
half); `--json` stdout is exactly the receipt with 0 bytes on stderr (D2); and
`signal` against a timer-parked run prints `NoMatchingWait: no wait point named
"go" is open on run run-3 ...` (D3). Every engine row in the project is
terminal with `finished_at_ms` set, every control row agrees, and no process,
listener, or shell child survived the run.

Previous evidence at `20b32c6316` is preserved as `smoke-prev-20b32c6316.md`,
`smoke-db-prev-20b32c6316/`, `smoke-artifacts-prev-20b32c6316/`, and
`smoke-remote-prev-20b32c6316/`; the `9c464343f0` set is preserved under the
same naming.

## Environment

| Item | Value |
| --- | --- |
| Clean checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4` (written as `<ck>` below); `git status --short` empty before and after, the only untracked paths being the ignored `apps/ui/{.hutch,dist,node_modules}` |
| HEAD | `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba` (`v1/rc0-migration`, 2026-08-31 04:08 PDT, `chore(wave-6): regenerate known-files.d.ts for the two landed lanes`), which contains the cli-lifecycle lane (`ca22977386`) and the release-hygiene lane (`b22c47e5f5`). The source branch in `~/smithers` is one commit ahead (`f63809382b`, a docs-only contract edit). Submodule `vendor/jj` at `47589ada70`. |
| Smoke project | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/phase7/smoke-db` (written as `<smoke>`), with `.flows/control.db` (245,760 bytes at the end) and `.flows/engine.db` (548,864 bytes) |
| Remote client cwd | `phase7/smoke-remote/` (no `flows/`, an empty `.flows/` marker) |
| Artefacts | `phase7/smoke-artifacts/`: `transcript.log` (every local CLI command with UTC stamp, stdout, stderr, exit code, wall time), `transcript-remote.log` (the `--remote` commands), `sm.sh` and `rm.sh` (the runners), `rows.sh` (SQLite row and journal dump per run), `item3-asker.sh` and `item3.out`, `plan-hello.out`, `run1.out`/`run1.err`, `up8.out`/`up8.err`, `logs-run-1.json`, `logs-run-2-before-kill.json`, `logs-run-3.txt`, `events-run-3.json`, `logs-run-5.json`, `logs-follow-run-2.txt`, `approval-requested-run-5.json`, `approve-run-5.out`, `serve.log`, `rpc-list.ndjson`/`rpc-list.out`, `remote-logs-run-5.json`, `remote-logs-run-7.json`, `ui-proof-gateway.log`, `ui-build-web.log`, `ui-local.log`, `ui-bootstrap.json`, `ui-shot.mjs`, `ui-shot.out`, `ui-local.png`, `github-live.log`, `linear-live.log`, `journal-counts-{before,after}-run8.txt`, `final-db-state.txt` |
| Host | macOS 26.2 (25C56), arm64; 1-minute load 3.81 at the start, 10.08 at the end (the UI proof and Vite build ran concurrently with items 3 and 6) |
| Node | v24.18.0 |
| Bun | 1.4.0 |
| pnpm | `corepack pnpm` 11.21.0; vitest 4.1.9; Playwright 1.62.1; `effect` 4.0.0-rc.108 |
| sqlite3 / jj | 3.51.0 / 0.39.0 |
| CLI | `node --no-warnings <ck>/packages/cli/src/bin.ts`, cwd `<smoke>`; `--version` prints `smithers v1.0.0-rc.0` in 1.0 s; an idle command boots in about 3 s |
| Model seat | `openai:gpt-5.6-luna` through `SMITHERS_OPENAI_AUTH=chatgpt` and `~/.codex/auth.json`; `doctor` reports `openai seats use the ChatGPT session`. `ANTHROPIC_API_KEY` unset. |
| Integrations | `GITHUB_TOKEN` from `gh auth token` (account `roninjin10`, scopes `gist, read:org, repo, workflow`); `LINEAR_API_KEY` exported in the shell |
| Date | 2026-08-31, 13:00 to 13:15 UTC |

Two traps recorded by earlier smokes were avoided up front: `<smoke>/.flows/`
was created before the first command so `Project.root` does not walk up to
`~`, and `jj git init --colocate` was run in `<smoke>` so the engine's
snapshot boundary is the project. Other `bin.ts` processes from an unrelated
lane (`migration/wt/cli-refuse-before-boot`, its own cwd and `.flows`) were
alive on the host during item 2a; every process listing below is filtered to
`clean-checkout-4/packages/cli/src/bin.ts`.

## Setup

```
mkdir -p smoke-db/.flows && cd smoke-db && jj git init --colocate
ln -s <ck>/examples/node_modules node_modules
smithers --version                                  smithers v1.0.0-rc.0            exit 0, 1.0 s
smithers init hello --json                                                          exit 0, 1.3 s
{"created":true,"flowFile":"<smoke>/flows/hello/flow.mdx","gitignore":"unchanged","name":"hello","stateDirectory":"<smoke>/.flows"}
```

The scaffolded `flow.mdx` has no `model:` line. As in the previous smoke,
`model: openai:gpt-5.6-luna` was added and four more flows were written beside
it (the same five bodies as the `20b32c6316` smoke):

| Flow | Body |
| --- | --- |
| `hello` | `write` `result.txt` containing `OK` |
| `sleeper2` | `wait` 45 s (below `DurableClock`'s 60 s in-memory threshold), then `write` `woke2.txt` |
| `sleeper` | `wait` 150 s (a durable engine clock), then `write` `woke.txt` |
| `asker` | `ask` "Ship the phase7 smoke release?", then `write` `decision.txt` with the answer |
| `canceller` | `bash` `echo smoke-cancel-marker started; sleep 300; echo never` |

```
smithers ls --json        {"_tag":"flows","items":[asker, canceller, hello, sleeper, sleeper2]}   exit 0, 3.5 s
smithers doctor                                                                                    exit 0, 3.3 s
ok   registry: 5 flows discovered
ok   state: <smoke>/.flows
ok   database <smoke>/.flows/control.db: 4 migrations applied, latest 1002
ok   database <smoke>/.flows/engine.db: 8 migrations applied, latest 4001
ok   node: v24.18.0
ok   jj: /opt/homebrew/bin/jj
ok   providers: OPENAI_API_KEY, CEREBRAS_API_KEY; openai seats use the ChatGPT session
```

## 1. Create and run a flow: PASS

The documented quick start (`docs/pages/index.mdx`) was written to
`<smoke>/quickstart.ts` verbatim apart from the tag names and run against the
working-tree packages through the `node_modules` symlink:

```
node --no-warnings quickstart.ts
Hello, Ada.                                                                          exit 0
```

The CLI path, from the `running-flows` guide:

```
smithers plan hello --json                                                           exit 0, 3.3 s
{"approval":{"idempotencyKey":"approve:plan-1","scope":"run","target":{"_tag":"Plan","digest":"20f1ce02...","envelope":{"budget":{},"capabilities":["*"],"flows":[]},"planId":"plan-1"}},"deployClass":false,...,"flowId":"hello","nodes":[],"planId":"plan-1"}
smithers run '<approval payload>' --json                                             exit 3, 3.3 s
{"_tag":"Parked","planId":"plan-1","receiptId":"approve:plan-1","status":"waiting-approval"}
smithers approve '<approval payload>' --scope run --json                             exit 0, 3.5 s
{"_tag":"Accepted","receiptId":"approve:plan-1"}
smithers run '<approval payload>' --json >run1.out 2>run1.err                        exit 0, 8.1 s
stdout 352 bytes: {"_tag":"Accepted","receiptId":"approve:plan-1","runId":"run-1"}
stderr 0 bytes
```

`result.txt` contains `OK`. Rows and journal read straight from SQLite the
moment the command returned, with no `bin.ts` process alive:

```
engine.db flows_runs:   ('run-1','completed', finished_at_ms 1788181262429, owner NULL)
control.db flows_runs:  ('run-1','completed')
 0 control.run.accepted           1788181257709
 3 flows.engine.run-decision      1788181257845  claimed-and-activated, owner pid 71194 (the launching process)
12 control.agent.model-settled    1788181261506  usage inputTokens 5741 (a real model call, 3.3 s)
17 control.agent.cell-call-started write {"path":"result.txt","content":"OK"}
27 control.agent.cell-call-settled  {"bytesWritten":2,"created":true}
34 control.run.completed          1788181262418
35 flows.engine.run-decision      1788181262429  transitioned completed, owner pid 71194
```

`status run-1`: `Verdict completed`, `1 turns · 1 calls (0 refused, 0
duplicate)`, `Tokens 5,741 in / 121 out`. This is the exact shape the previous
smoke failed on: there the row read `suspended`/`released` with an
`interrupt-released` decision at seq 35 and a `WARN` on stdout. Here the
transition lands 11 ms after `control.run.completed`, inside the launching
process, and the journal holds 36 events, unchanged for the rest of the
session (section "D1 regression" below).

## 2. Restart a process during execution: PASS

### 2a. SIGKILL during an in-memory 45 s wait (`sleeper2`, run-2)

```
smithers up sleeper2 -d --json                                                       exit 0, 6.3 s
{"detached":true,"logFile":"<smoke>/.flows/logs/run-2.log","runId":"run-2"}
```

12 s later: journal seq 21 `control.agent.cell-call-started {"flowName":"wait","input":{"seconds":45,...}}`,
engine row `('run-2','running', owner_pid 73126, heartbeat 1788181312876)`,
`pgrep` shows pid 73126 running `bin.ts run {...plan-2...}`.

```
kill -9 73126                                       (13:01:56Z; ps -p 73126 reports dead 1 s later)
engine row after the kill: ('run-2','running', owner_pid 73126, heartbeat 1788181315882); woke2.txt absent
smithers run --resume run-2 --json                                                   exit 0, 75.1 s
{"_tag":"Accepted","receiptId":"cli:resume:run-2","runId":"run-2"}
```

`woke2.txt` contains `DONE`; both `flows_runs` rows read `completed`
(`finished_at_ms` 1788181392260). Journal after the kill:

```
22 control.run.resume            1788181320176
23 flows.engine.run-decision     1788181346234  stolen-and-activated, previousStatus running, owner pid 73312
32 control.agent.turn-opened     1788181346593
33 control.agent.model-settled   1788181346593  (same millisecond: replayed from the journal, no model call)
35 control.agent.cell-call-started wait 45      1788181346593
39 control.agent.cell-call-settled {"waitedSeconds":45}   1788181391459  (44.9 s later: the in-memory wait re-executed)
40 control.agent.cell-call-started write woke2.txt
58 control.run.completed         1788181392249
59 flows.engine.run-decision     1788181392261  transitioned completed, owner pid 73312
```

The 26 s between `control.run.resume` and the steal is the
`Ownership.heartbeatStaleAfter` bound the dead owner's last heartbeat had to
age past. `status run-2`: `completed`, `1m 32s`, `2 turns · 3 calls (0
refused, 1 duplicate)`, `Tokens 11,526 in / 450 out`.

### 2b. Durable park on a 150 s timer, process gone, continued after the deadline (`sleeper`, run-3)

```
smithers up sleeper -d --json                                                        exit 0, 8.9 s
{"detached":true,"logFile":"<smoke>/.flows/logs/run-3.log","runId":"run-3"}
```

25 s later no smoke `bin.ts` process was alive and the rows read:

```
engine.db flows_runs:   ('run-3','suspended', waiting_reason 'timer', waiting_wake_at_ms 1788181592017, cancel_requested_at_ms NULL, owner NULL)
control.db flows_runs:  ('run-3','suspended')
flows_clock_deadlines:  execution_id run-3, due_at_ms 1788181592017, completed_at_ms NULL
journal: 17 flows.engine.clock-scheduled, 21 cell-call-started wait 150, 22 control.agent.aborted "Cell frame interrupted",
         24 control.run.waiting-approval, 25 flows.engine.run-decision transitioned suspended       (26 events)
```

No `flows.engine.interrupted` and no `cancel_requested_at_ms`: the park is a
park. `ps --json` lists run-3 as `waiting-approval`; `status run-3` while
parked printed `Verdict waiting-approval — a permission gate is pending`
(observation O1). Items 4 and 5a ran during the park; their process (run-4,
pid 74873) was cancelled and gone 68 s before the deadline, so nothing was
alive to adopt the wake.

28 s after the deadline, with no smoke `bin.ts` process alive and the clock row
still `completed_at_ms NULL`:

```
smithers run --resume run-3 --json                                                   exit 0, 4.1 s
{"_tag":"Accepted","receiptId":"cli:resume:run-3:24","runId":"run-3"}
```

`woke.txt` contains `DONE`; both rows `completed` (`finished_at_ms`
1788181624911); the clock row is stamped `completed_at_ms 1788181623893`.
Journal:

```
27 flows.engine.deferred-completed  DurableClock/harness/wait/run-3/0/...   1788181623893
28 flows.engine.run-decision        wake-scheduled, reason clock
29 flows.engine.run-decision        claimed-and-activated, previousStatus suspended, owner pid 76130
30 control.run.resume
44 control.agent.model-settled      (replayed)
47 control.agent.cell-call-settled  wait -> {"waitedSeconds":150}           1788181624263  (replayed, no second wait)
48 control.agent.cell-call-started  write woke.txt
65 control.run.completed            1788181624900
66 flows.engine.run-decision        transitioned completed                   (59 events)
```

`status run-3`: `completed`, `3m 07s`, `2 turns · 3 calls (0 refused, 1
duplicate)`. A second `run --resume run-3` answers `{"_tag":"Terminal","runId":"run-3","status":"completed"}`
with exit 0, which is the contract's join-or-claim wording for a settled run.

## 3. Resume a durable wait by delivering the awaited input: PASS

```
smithers up asker -d --json                                                          exit 0, 6.1 s
{"detached":true,"logFile":"<smoke>/.flows/logs/run-5.log","runId":"run-5"}
```

15.1 s later the engine row read `suspended`/`approval` with `waiting_token`
`ask/run-5/87caea8e...`, the control row `suspended`, and no smoke `bin.ts`
process was alive. Journal: `16 control.approval.requested`, `17
control.agent.cell-call-started ask`, `20 control.agent.suspended
permission-required`, `21 control.run.waiting-approval`, `22
flows.engine.run-decision transitioned suspended` (23 events).

```
smithers ps --status waiting-approval --json     [run-5 asker waiting-approval]          exit 0
smithers status run-5                                                                  exit 0
Verdict   waiting-approval — asks: Ship the phase7 smoke release?
Unblock   smithers approve '{"target":{"_tag":"Node","runId":"run-5","requestId":"ask/run-5/87caea8e...","digest":"87caea8e...","envelope":{"capabilities":[],"flows":["ask"],"budget":{}}},"scope":"run","idempotencyKey":"approve:ask/run-5/87caea8e..."}' --scope run && smithers run --resume run-5
```

The payload printed by `status` is byte-identical to the `payload` field of the
journaled `control.approval.requested` event (`item3-asker.sh` compares them).

```
smithers approve '<that payload>' --json                                             exit 0, 62.8 s
{"_tag":"Accepted","receiptId":"approve:ask/run-5/87caea8e...","runId":"run-5"}
```

`decision.txt` contains `approved`; both rows `completed` (`finished_at_ms`
1788181774452); `control_grants` gained `('ask/run-5/87caea8e...',
'{"capabilities":[],"flows":["ask"],"budget":{}}', 'run', 1788181718614)`.
Journal:

```
23 control.approval.approved   1788181718615
24 control.run.resumed         1788181718619
25 flows.engine.run-decision   wake-scheduled, reason operator     1788181748699   (30 s later: the park-adoption bound)
26 flows.engine.run-decision   claimed-and-activated, owner pid 77470 (the approve process itself)
40 control.agent.cell-call-settled ask -> {"answer":"approved","approved":true}
41 control.agent.cell-call-started write {"path":"decision.txt","content":{"answer":"approved","approved":true}}
53 control.agent.cell-call-settled write failure "Flow write rejected its input: Expected string at [\"content\"]"
63 control.agent.model-settled  (a second real model call, 24 s)
65 control.agent.cell-call-started write {"path":"decision.txt","content":"approved"}
75 control.agent.cell-call-settled {"bytesWritten":8,"created":true}
82 control.run.completed       1788181774439
83 flows.engine.run-decision   transitioned completed                (82 events)
```

The `&& smithers run --resume run-5` the `Unblock` line suggests was not
needed: the deciding process continued the run to completion, which is what
rc-contract section 5.1 promises. The first `write` refusal is the model
passing the whole `ask` result as `content`; the flow's schema rejected it and
the next turn corrected it (`status run-5`: `3 turns · 4 calls (1 refused, 1
duplicate)`, `Refusals 1× Flow write rejected its input: Expected string`).
`output run-5 result` prints `result success` / `Wrote decision.txt with the
decision text: approved`.

## 4. Deliver a signal: PASS

Against `run-4` (`canceller`) while its process and `bash` child were alive:

```
smithers signal run-4 '{"name":"go","payload":{"attempt":1}}' --json
{"_tag":"Accepted","receiptId":"cli:signal:run-4:d4476500","runId":"run-4"}       exit 0, 3.1 s
smithers signal run-4 '{"name":"go","payload":{"attempt":1}}' --json
{"_tag":"AlreadyApplied","receiptId":"cli:signal:run-4:d4476500","runId":"run-4"} exit 0, 3.0 s
smithers signal run-4 '{"name":"go","payload":{"attempt":2}}' --json
{"_tag":"Accepted","receiptId":"cli:signal:run-4:6bbf2c01","runId":"run-4"}       exit 0, 3.1 s
```

`control_run_messages` holds exactly two rows for run-4, one per distinct
payload, and the journal holds two `control.signal.delivered` events (seq 20
and 21); the replay appended nothing. Against runs in other states:

```
smithers signal run-3 '{"name":"go","payload":{"attempt":1}}' --json   (run-3 parked on a timer)
stderr: NoMatchingWait: no wait point named "go" is open on run run-3. Read `smithers status run-3` to see what that run is waiting for.
stdout: (empty)                                                                      exit 1, 3.0 s
smithers signal run-1 '{"name":"go","payload":{}}' --json              (control row completed)
{"_tag":"Terminal","runId":"run-1","status":"completed"}                             exit 0
smithers signal run-6 '{"name":"go","payload":{}}' --remote http://127.0.0.1:7351 --json   (cancelled)
{"_tag":"Terminal","runId":"run-6","status":"cancelled"}                             exit 0
```

The timer-parked refusal now renders the error name and message (the previous
smoke's D3 printed `go: `). No standard agent flow parks on `WaitFor`
(`StandardFlows` ships `wait` and `ask`), so a wake-on-signal cannot be reached
from a markdown flow; that path is covered by
`packages/control/test/EngineWaits.test.ts` and
`e2e/faults/case04-restart-waiting-event.test.ts`, not by this smoke.

## 5. Cancel a run and prove terminal state and child cleanup: PASS

```
smithers up canceller -d --json                                                      exit 0, 6.2 s
{"detached":true,"logFile":"<smoke>/.flows/logs/run-4.log","runId":"run-4"}
```

20 s later (journal seq 19 `control.agent.cell-call-started
{"flowName":"bash","input":{"mode":"unhermetic","command":"echo
smoke-cancel-marker started; sleep 300; echo never"}}`), and again immediately
before the cancel 15 s after that:

```
pid    ppid   pgid   command
74873      1  74873  node <ck>/packages/cli/src/bin.ts run {...plan-4...}      (engine owner_pid for run-4)
74910  74873  74910  /bin/sh -c echo smoke-cancel-marker started; sleep 300; echo never
74911  74910  74910  sleep 300
```

```
smithers cancel run-4 --json                       (13:05:18Z)                     exit 0, 3.0 s
{"_tag":"Terminal","runId":"run-4","status":"cancelled"}
```

6 s later: no smoke `bin.ts run`, `sh`, or `sleep 300` process; pids 74910 and
74911 gone; no process matching `sleep 300` or `smoke-cancel` under ppid 1.
Rows: engine `('run-4','cancelled', cancel_requested_at_ms 1788181518694,
finished_at_ms 1788181519233, owner NULL)`, control `cancelled`. Journal: `22
control.run.cancel-requested` (principal `local`/`operator`), `23
control.run.cancelled`, `25 flows.engine.interrupted {"outcome":"cancelled"}`
(26 events). The engine transition landed 539 ms after the request. A second
`cancel run-4` answers `Terminal cancelled` again and the journal stays at 26
events.

The gateway-hosted cancel (`run-6`, section 7) shows the same shape from a
remote caller: `cancel-requested` 3.4 s after admission, `interrupted
cancelled` 8 ms later, both rows `cancelled`, `finished_at_ms` set.

## 6. Inspect journal and events with the CLI: PASS

```
smithers logs run-3                                                                  exit 0
run-3 · completed · 3m 07s · 2 turns · 3 calls (0 refused) · 11,520 in / 284 out tok
[+00:00] run.accepted
=== turn 1 · openai:gpt-5.6-luna ===
[+00:04] call    wait {"seconds":150,"reason":"phase7 smoke"}
[+00:04] run.waiting-approval
[+03:06] run.resume
=== turn 2 · openai:gpt-5.6-luna ===
[+03:06]   -> ok {"waitedSeconds":150}
[+03:06] call    write {"path":"woke.txt","content":"DONE"}
[+03:07] complete {"bytesWritten":4,"created":true,"path":"woke.txt"}
[+03:07] run.completed                                        (30 transcript lines)
smithers events run-3        68 control events, 29 distinct kinds (alias of logs --json)              exit 0
smithers logs run-5 --json   95 events                                                                exit 0
smithers logs run-1 --json   42 events                                                                exit 0
smithers logs run-2 --follow  prints the 53 existing events, then stays open (observation O3)
smithers output run-3 result
result success
{"bytesWritten":4,"created":true,"path":"woke.txt"}                                  exit 0
smithers inspect run-2       the same diagnosis card as status (alias)                                 exit 0
smithers ps                  the five runs with status, planId, planDigest, steering.pending (observation O4)   exit 0
smithers gc --older-than 0s --dry-run --json                                          exit 0
{"dryRun":true,"failures":[],"olderThan":"0s","reports":[{"database":".../control.db","runs":["run-1","run-2","run-4","run-3","run-5"]},{"database":".../engine.db","runs":["run-1","run-2","run-4","run-3","run-5"]}]}
```

`gc` now lists every terminal run for both databases; the previous smoke's
`engine.db` report omitted the D1 rows. Direct `sqlite3` reads of `engine.db`
match the CLI's lifecycle view. `flows_journal_events` per key at the end of
the session: run-1 36, run-2 53, run-3 59, run-4 26, run-5 82, run-6 11, run-7
36, run-8 36, plus two events per plan (`final-db-state.txt`). `control.db`
`flows_journal_events` is empty; the CLI reads the engine journal. The CLI's
event count for a run is higher than that run's row count because `logs`
adds `harness/boundary/workspace-{open,close}` and `harness/cell-call/<flow>`
records that are not journal rows (run-1: 42 against 36).

## 7. Gateway and UI against the run: PASS

```
smithers serve --host 127.0.0.1 --port 7351        (background, pid 91878; health answered after 7 s)
smithers serve listening on http://127.0.0.1:7351
  /rpc  /rpc/ws  /projections  /projections/ws  /sync  /sync/ws  /health
  auth  none (loopback only)

curl -i http://127.0.0.1:7351/health
HTTP/1.1 200 OK
{"workspaceHash":"ad528ba4146165d9","gatewayId":"cli-91878","protocolVersion":"1","version":"1.0.0-rc.0"}

curl -X POST -H 'content-type: application/json' --data '{}' /rpc
HTTP/1.1 400 Bad Request
{"_tag":"flows/gateway/GatewayError","code":"malformed_request","message":"POST /rpc carries no RPC request message","cause":null}

curl -X POST -H 'content-type: application/ndjson' --data-binary '{"_tag":"Request","id":"1","tag":"List","payload":{"_tag":"runs"},...}\n' /rpc
HTTP/1.1 200 OK   content-type: application/ndjson   content-length: 1256
{"_tag":"Exit","requestId":"1","exit":{"_tag":"Success","value":{"_tag":"runs","items":[run-1 ... run-5]}}}

curl -i /projections                    HTTP/1.1 404 Not Found, empty body (no projection named; observation O6)
```

Remote CLI from `phase7/smoke-remote/` (no `flows/`, its own empty `.flows/`
marker), each command a separate process over the shipped `ControlClient`
(`transcript-remote.log`):

```
smithers ls --remote http://127.0.0.1:7351 --json         the five flows                          exit 0, 3.7 s
smithers ps --remote ... --json                            run-1..run-5 with their statuses        exit 0, 3.6 s
smithers status run-3 --remote ...                         the same diagnosis card as locally      exit 0, 3.7 s
smithers logs run-5 --remote ... --json                    95 events (same count as locally)       exit 0
smithers up hello --remote ... --json                      {"_tag":"Accepted","receiptId":"approve:plan-6","runId":"run-6"}   exit 0, 2.6 s
smithers status run-6 --remote ...                         Verdict running · 1 turns · 0 calls    exit 0, 1.3 s
smithers cancel run-6 --remote ... --json                  {"_tag":"Terminal","runId":"run-6","status":"cancelled"}          exit 0, 1.0 s
smithers up hello --remote ... --json                      {"_tag":"Accepted","receiptId":"approve:plan-7","runId":"run-7"}   exit 0, 1.0 s
   (control.db polled every 2 s)                           run-7 completed after 6 s
smithers status run-7 --remote ...                         Verdict completed — Created result.txt · Tokens 5,741 in / 165 out
smithers logs run-7 --remote ... --json                    42 events; one model-settled, the write call present
smithers signal run-6 '{"name":"go","payload":{}}' --remote ... --json   {"_tag":"Terminal","runId":"run-6","status":"cancelled"}
```

`run-6` and `run-7` were planned, approved, launched, executed, and (run-6)
cancelled entirely through the gateway: every `flows.engine.run-decision` for
both names owner pid 91878 (the serve process), `result.txt`'s mtime moved
from 13:01:02Z to 13:13:25Z, and both engine rows are terminal with
`finished_at_ms` set (run-6 `cancelled` 1788181996379, run-7 `completed`
1788182005759). `up --remote` returns after admission because the local
process does not own the executor (observation O7). `kill -TERM 91878` stopped
the gateway in under 0.1 s with exit 143; port 7351 was free afterwards.

UI, three proofs at this HEAD:

```
cd apps/ui && corepack pnpm run proof:gateway                                        exit 0
5. approve: one call, no second resume
  ok  the decision was ONE relayed call
  ok  the gateway resumed the run on the caller's behalf
8. cancel
  ok  the cancel is durable: the run reads cancelled
Relayed procedures: List, Plan, Approval.Submit, Run, Projection.Snapshot, Projection.Snapshot, Approval.Submit, Projection.Snapshot, Projection.Snapshot, Cancel, Projection.Snapshot
PROOF PASSED

cd apps/ui && corepack pnpm run build:web           vite built in 1.59 s, exit 0
dist/__build.json: {"app":"smithers-ui","gitSha":"cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba","builtAt":"2026-08-31T13:09:46.568Z"}

SMITHERS_LOCAL_MODE=offline bun src/bun/serve.ts   SMITHERS_LOCAL_ORIGIN=http://127.0.0.1:60857 in under 1 s
curl -s -o /dev/null -w '%{http_code}' $ORIGIN/                                         200 (4,157 bytes)
curl ... $ORIGIN/api/bootstrap (no session header)                                      401
curl -H "x-smithers-local-session: <document token>" $ORIGIN/api/bootstrap              200
{"apiVersion":1,"host":"local","version":"0.0.1","buildSha":"unknown","capabilities":["local.repositories","local.repository-path-entry","local.targets","local.terminal","local.harnesses"],"authFlow":"none","sandbox":{"platform":"darwin","mode":"enforced"}}
```

Loaded in headless Google Chrome through Playwright 1.62.1
(`smoke-artifacts/ui-shot.mjs`, screenshot `smoke-artifacts/ui-local.png`,
49,613 bytes): page title `Smithers`; the sidebar renders `REPOS`, `Select a
repo`, `New tab`; the main pane renders the card `Smithers initialized
successfully` with a `Details` disclosure, the notice `This host doesn't
provide Smithers identity, so GitHub sign-in and jjhub account features are
unavailable. Commands supported by this host remain available below.`, a
`Select a repo` picker, and the composer with a `Chat` mode button. The page
made `GET /api/bootstrap` 200, `GET /api/repos` 200, `GET /api/harnesses` 200
with the `smithers-local-session` token the document carried; zero console
messages, zero page errors, zero failed requests. The local UI host serves
repositories, targets, terminals, and harnesses; it does not connect to
`smithers serve`, so the UI-to-gateway evidence is the seam proof above
(`apps/ui/docs/LOCAL-APP.md`). `kill -TERM` stopped it within 1 s.

## 8. Exercise one real integration: PASS

```
cd <ck>/packages/integrations
GITHUB_TOKEN="$(gh auth token)" corepack pnpm exec vitest run test/GitHubLive.test.ts --coverage.enabled=false
 Test Files  1 passed (1)      Tests  4 passed (4)      Duration  2.16s                exit 0
   authenticates and returns the viewer; reports the rate-limit headers the retry policy reads;
   paginates a real Link header; classifies a real 404 as a non-retryable delivery failure
corepack pnpm exec vitest run test/LinearLive.test.ts --coverage.enabled=false
 Test Files  1 passed (1)      Tests  4 passed (4)      Duration  1.29s                exit 0
   authenticates and returns the viewer; resolves a real team by key and caches it;
   lists the workflow states and labels the name resolution depends on; reports a GraphQL error rather than a transport failure
```

Both suites are `describe.skipIf(credential === undefined)` and both ran
against `api.github.com` and `api.linear.app` with the credentials named in
the environment table; no test skipped. No ENV-SKIP.

## D1 regression: a later local executor leaves earlier rows alone

After items 1 through 7, with eight terminal runs in the project:

```
smithers up hello --json >up8.out 2>up8.err                                          exit 0, 9.8 s
stdout 131 bytes: {"_tag":"Accepted","receiptId":"approve:plan-8","runId":"run-8"}
stderr 0 bytes
```

`flows_journal_events` counts before and after differ by exactly `plan:plan-8
2` and `run-8 36`; no earlier key gained an event. The only cross-process
claims in the whole project are the three the smoke asked for:

```
run-2  created > claimed-and-activated > stolen-and-activated > transitioned                       (SIGKILL, 2a)
run-3  created > claimed-and-activated > transitioned > wake-scheduled > claimed-and-activated > wake-scheduled > transitioned   (clock, 2b)
run-5  created > claimed-and-activated > transitioned > wake-scheduled > claimed-and-activated > transitioned                    (operator, 3)
run-1, run-7, run-8  created > claimed-and-activated > transitioned
run-4, run-6         created > claimed-and-activated  (then flows.engine.interrupted cancelled)
```

No `interrupt-released` decision exists in the project. The previous smoke's
run-1 carried 162 events and 16 run-decision records across 11 pids at this
point.

## Observations that are not blockers

- O1. `ps` and `status` label a timer park `waiting-approval`, and `status`
  prints `a permission gate is pending` for it. The harness writes that
  status for every suspension. The `Unblock` line is absent for a timer
  park, so an operator has no false approve command to run, but the verdict
  text is wrong for the wait it describes. Unchanged from the previous smoke.
- O2. The `smithers init` template ships no `model:` line. The previous smoke
  measured that the scaffold is not launchable as written
  (`SeatUnresolved`); this smoke added the line up front and did not
  re-measure.
- O3. `logs <run> --follow` on a terminal run prints the existing events and
  then stays open until killed (`timeout 30` exit 124, 53 lines for run-2).
  The help text says `--follow streams future events`, so this matches the
  declared behavior; an operator following a run that has already settled
  gets no exit.
- O4. `ps` without `--json` prints pretty-printed JSON rather than a table.
- O5. `status` token totals after a resume include the replayed turn's usage
  again (run-2: `11,526 in` for one real call of 5,763; `1 duplicate` in the
  Activity line names the replay). The engine made no second model call: the
  replayed `model-settled` lands in the same millisecond as `turn-opened`.
- O6. `GET /projections` with no projection name answers 404 with an empty
  body, unchanged from the previous smokes.
- O7. `up --remote` returns after admission (1.0 to 2.6 s) rather than
  settlement. The contract says `run` blocks "when the local process owns the
  executor", and a remote caller does not.
- O8. Command boot time rose from about 3 s to about 10 s while the UI proof
  and Vite build ran concurrently (1-minute load 10 to 20). Nothing timed out
  and no lease was lost; the 30 s stale bounds in 2a and 3 were unaffected.

## Final state

`ps --json` at the end: run-1 completed, run-2 completed, run-3 completed,
run-4 cancelled, run-5 completed, run-6 cancelled, run-7 completed, run-8
completed. `engine.db flows_runs`: every row terminal with `finished_at_ms`
set and `owner_pid` NULL; `cancel_requested_at_ms` set on run-4 and run-6
only. `control.db flows_runs`: the same eight statuses.
`flows_clock_deadlines`: one row (run-3), `completed_at_ms` set.
`control_run_messages`: two rows (run-4). `control_grants`: eight plan grants
plus the run-5 ask grant. Files in the project: `result.txt` `OK` (mtime
13:14:39Z, rewritten by run-7 and run-8), `woke.txt` `DONE`, `woke2.txt`
`DONE`, `decision.txt` `approved`. The gateway and the UI server were stopped;
no smoke `bin.ts` process, no listener on 7351, and no orphan `sleep 300`
remained. The clean checkout's tracked tree is unmodified.

## Blockers for a fix lane

None. The four blockers from `smoke-prev-20b32c6316.md` are closed by the
evidence in sections 1, 4, 6, and "D1 regression". The observations above are
recorded for the release notes, not for a fix lane.
