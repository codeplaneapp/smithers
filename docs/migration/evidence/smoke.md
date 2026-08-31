# Phase 7 gate: smoke

Verdict: PASS

This run supersedes the smoke at `cd14388ed7`, which is preserved as
`smoke-prev-cd14388ed7.md` with its artifacts under
`smoke-artifacts-prev-cd14388ed7/` and `smoke-remote-prev-cd14388ed7/` (that
run's `smoke-db` was removed as instructed; the older `20b32c6316` and
`9c464343f0` sets remain under their own `-prev` names). The re-run covers the
wave 7 and wave 8 surfaces that landed since: the `smithers init` scaffold now
declares a model seat and was launched AS WRITTEN with the maintainer's
ambient credentials, the resolved seat had no credits, and the launch settled
`failed` in both databases instead of leaving an `accepted` row with owner
pid 0; the quick start then completed on a seat that works. All eight PLAN
Phase 7 smoke items executed end to end at `341c8fa87e` against the
working-tree CLI, two real SQLite files, a real model seat, a real gateway,
the built UI loaded in headless Chrome, and the real GitHub and Linear APIs.
Every engine row in the project is terminal with `finished_at_ms` set, no
`accepted` row (or any row) with owner pid 0 survives anywhere, every control
row agrees, and no process, listener, or shell child outlived the run.

## Environment

| Item | Value |
| --- | --- |
| Clean checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4` (written as `<ck>` below); `git status --short` empty before and after (the ignored `apps/ui/{.hutch,dist,node_modules}` are the only untracked paths, and `apps/ui/.hutch/devkit` is the documented copy from `~/smithers/apps/ui/.hutch/devkit`, electrobun 2.0.1, because `electrobun prepare` blocks on another session's hutch lock) |
| HEAD | `341c8fa87e2dadbe80d0f0d3258dae112a7d03d3` (`v1/rc0-migration`, 2026-08-31 09:12 PDT, `docs(release): consumer overrides note and the browser-contract list's new home`), which contains waves 7 and 8: `92febad82c` (docs-served-llms, cli-refuse-before-boot), `a42f8f6e5d`/`274c3b9e26`/`5cc98912d0` (polish-2, init-scaffold-launch). Submodule `vendor/jj` at `47589ada70`. |
| Smoke project | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/phase7/smoke-db` (written as `<smoke>`), created fresh with `.flows/` premade and `jj git init --colocate`; `.flows/control.db` 258,048 bytes and `.flows/engine.db` 1,167,360 bytes at the end |
| Remote client cwd | `phase7/smoke-remote/` (no `flows/`, an empty `.flows/` marker) |
| Artefacts | `phase7/smoke-artifacts/`: `transcript.log`, `transcript-remote.log`, `sm.sh` (ChatGPT-session runner), `sma.sh` (ambient-credential runner), `rm.sh`, `rows.sh` (rows, journal, and the accepted/pid-0 sweep per run), `up1-ambient.{out,err}`, `rows-run-*.txt`, `plan-hello.out`, `run2.{out,err}`, `up3.{out,err}`, `up10.{out,err}`, `approval-requested-run-7.json`, `status-run-7-parked.txt`, `approve-run-7.out`, `events-run-5.json`, `logs-run-{1,7}.json`, `logs-follow-run-4.txt`, `serve.log`, `rpc-list.{ndjson,out}`, `remote-ps.out`, `remote-logs-run-7.json`, `ui-proof-gateway.log`, `ui-build-web.log`, `ui-local.log`, `ui-shot.mjs`, `ui-shot.out`, `ui-local.png`, `github-live.log`, `linear-live.log`, `journal-counts-{before,after}-run10.txt`, `final-db-state.txt` |
| Host | macOS 26.2 (Darwin 25.2.0), arm64; 1-minute load 3.37 at the start, peaking at 25.99 mid-run (other agents share the machine), 5.58 before the integration suites; disk 13 GiB free at the end |
| Node | v24.18.0 |
| Bun | 1.4.0 (used only by the UI local host) |
| pnpm | `corepack pnpm` 11.21.0; vitest 4.1.9; Playwright 1.62.1; `effect` 4.0.0-rc.108 |
| sqlite3 / jj | 3.51.0 / 0.39.0 |
| CLI | `node --no-warnings <ck>/packages/cli/src/bin.ts`, cwd `<smoke>`; `--version` prints `smithers v1.0.0-rc.0` in 1.5 s |
| Ambient credentials (item 1a, `sma.sh`) | `OPENAI_API_KEY` (set, org has no API credits), `CEREBRAS_API_KEY`, `LINEAR_API_KEY`; `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, and `SMITHERS_OPENAI_AUTH` unset. `doctor`: `ok providers: OPENAI_API_KEY, CEREBRAS_API_KEY` |
| Working seat (everything else, `sm.sh`) | `SMITHERS_OPENAI_AUTH=chatgpt` with `~/.codex/auth.json`; `doctor` adds `openai seats use the ChatGPT session`; flows written for items 1b through 8 declare `model: openai:gpt-5.6-luna` |
| Integrations | `GITHUB_TOKEN` from `gh auth token` (account `roninjin10`, scopes `gist, read:org, repo, workflow`); `LINEAR_API_KEY` exported in the shell |
| Date | 2026-08-31, 16:19 to 16:40 UTC |

The two known traps were avoided up front: `<smoke>/.flows/` existed before
the first command so `Project.root` does not walk up to `~`, and
`jj git init --colocate` ran in `<smoke>` so the engine's snapshot boundary is
the project.

## Setup

```
mkdir -p smoke-db/.flows && cd smoke-db && jj git init --colocate
ln -s <ck>/examples/node_modules node_modules
smithers --version                                  smithers v1.0.0-rc.0            exit 0, 1.5 s
```

## 1. Create and run a flow: PASS

### 1a. The scaffold AS WRITTEN, ambient credentials, the resolved seat has no credits

```
smithers init hello --json                                                           exit 0, 1.8 s
{"created":true,"flowFile":"<smoke>/flows/hello/flow.mdx","gitignore":"created","name":"hello","seat":"openai:gpt-5.6-sol","stateDirectory":"<smoke>/.flows"}
```

The scaffold now declares the seat wave 8 promised, chosen from the
credentials `doctor` reports, with the YAML comment naming the choice:

```
---
name: hello
description: A starter Smithers flow.
# The model seat this flow runs on. `smithers init` chose it from
# OPENAI_API_KEY, the first provider credential this environment sets. Change
# the line to run somewhere else; `smithers doctor` lists the keys it reads.
model: openai:gpt-5.6-sol
---
```

Launched exactly as written, with only the ambient credentials
(`up1-ambient.{out,err}`):

```
smithers up hello --json                                                             exit 1, 15.3 s
stdout: {"_tag":"Accepted","receiptId":"approve:plan-1","runId":"run-1"}        (one JSON document)
stderr: WARN An agent run failed { runId: 'run-1', cause: '/harness/HarnessError: The cell frame failed ...
        [cause]: flows/model/ModelError: You have no credits remaining. Add credits to continue using the API ... }
```

The seat resolves, the launch is accepted, the first turn makes a real model
call, the provider refuses it for billing, and the run SETTLES. Rows read the
moment the command returned (`rows-run-1-ambient.txt`):

```
engine.db flows_runs:   ('run-1','failed', finished_at_ms 1788193188537, owner NULL)
control.db flows_runs:  ('run-1','failed', finished_at_ms 1788193188511)
accepted/pid-0 sweep:   empty
journal: 0 control.run.accepted · 3 run-decision claimed-and-activated (owner pid 51438, the launching process)
         7 control.agent.turn-opened seat openai:gpt-5.6-sol · 9 control.run.failed (the ModelError as cause)
         10 run-decision transitioned failed                                          (11 events)
smithers status run-1   Verdict failed — /harness/HarnessError: The cell frame failed   exit 0
```

This is the exact outcome the task named: the resolved seat has no credits,
the outcome is a terminal `failed` row in BOTH databases, and the pre-fix
shape (`accepted` forever, `ownerId` pid 0, no engine row) is gone. The
receipt is the whole stdout; the refusal is on stderr (observation N1 records
a second WARN on that path).

### 1b. The quick start on a seat that works

The docs quick start (`docs/pages/index.mdx`, unchanged at this HEAD) was run
verbatim apart from the tag names against the working-tree packages:

```
node --no-warnings quickstart.ts                    Hello, Ada.                      exit 0
```

The as-written scaffold body was then exercised on the working seat: the
`model:` line was switched to `openai:gpt-5.6-luna` (the scaffold's own
comment invites exactly this edit) and the documented CLI path ran under
`SMITHERS_OPENAI_AUTH=chatgpt`:

```
smithers plan hello --json                          plan-2, digest 20f1ce02...        exit 0, 2.9 s
smithers run '<approval payload>' --json            {"_tag":"Parked",...,"status":"waiting-approval"}   exit 3
smithers approve '<approval payload>' --scope run   {"_tag":"Accepted","receiptId":"approve:plan-2"}    exit 0
smithers run '<approval payload>' --json            {"_tag":"Accepted","receiptId":"approve:plan-2","runId":"run-2"}   exit 3, 158.0 s
```

With the starter body and no concrete request, the agent read the project,
then parked on a real clarification `ask` ("The request is only titled
“hello” and does not specify a behavior..."), which is why the launch exited
3 (parked): engine row `suspended`/`approval`, `waiting_token ask/run-2/376f3165...`.
Approving that ask from a fresh process (`exit 0, 92.0 s`) continued the run
in the deciding process (owner pid 85051) to `completed` with the settlement
"No change is needed." — `finished_at_ms` in both rows, sweep empty, 8 turns,
105,261 in / 18,949 out tokens (observation N2).

For the deterministic completion the previous smokes measured, `hello`'s body
was then replaced with the same five bodies every earlier smoke used (write
`result.txt` containing `OK`; plus `sleeper2`, `sleeper`, `asker`,
`canceller` as recorded in `smoke-prev-cd14388ed7.md`, all on
`openai:gpt-5.6-luna`):

```
smithers up hello --json > up3.out 2> up3.err                                        exit 0, 7.8 s
stdout: {"_tag":"Accepted","receiptId":"approve:plan-3","runId":"run-3"}    stderr: 0 bytes
```

`result.txt` contains `OK`; both rows `completed` (`finished_at_ms`
1788193614944/1788193614931); journal 36 events with the transition inside
the launching process (pid 20565); sweep empty. The `--json` stdout contract
holds in both directions: a settled-failed launch still prints exactly the
receipt (1a), and a completed launch prints exactly the receipt with 0 bytes
on stderr.

## 2. Restart a process during execution: PASS

### 2a. SIGKILL during an in-memory 45 s wait (`sleeper2`, run-4)

```
smithers up sleeper2 -d --json          {"detached":true,"logFile":".flows/logs/run-4.log","runId":"run-4"}   exit 0, 6.6 s
```

12 s later: journal seq 21 `cell-call-started wait {"seconds":45}`, engine row
`('run-4','running', owner_pid 22672, heartbeat 1788193643440)`, pid 22672
alive running `bin.ts run {...plan-4...}`.

```
kill -9 22672                                       (16:27:28Z; ps reports dead 1 s later)
engine row after the kill: ('run-4','running', owner_pid 22672, heartbeat 1788193648451); woke2.txt absent
smithers run --resume run-4 --json                  {"_tag":"Accepted","receiptId":"cli:resume:run-4","runId":"run-4"}   exit 0, 68.3 s
```

`woke2.txt` contains `DONE`; both rows `completed` (`finished_at_ms`
1788193724981). Journal after the kill: `22 control.run.resume` 1788193659861,
`23 run-decision stolen-and-activated` 1788193678888 (19 s later, the
heartbeat-stale bound), the wait re-executed for 45 s
(`cell-call-settled {"waitedSeconds":45}` 1788193724116), `write woke2.txt`,
`59 transitioned completed` (owner pid 23339). 53 journal events. `status`:
`completed`, `2 turns · 3 calls (0 refused, 1 duplicate)`.

### 2b. Durable park on a 150 s timer, process gone, continued after the deadline (`sleeper`, run-5)

```
smithers up sleeper -d --json           {"detached":true,...,"runId":"run-5"}                                 exit 0, 6.3 s
```

25 s later, with NO smoke `bin.ts` process alive:

```
engine.db flows_runs:   ('run-5','suspended', waiting_reason 'timer', waiting_wake_at_ms 1788193897268, cancel_requested_at_ms NULL, owner NULL)
flows_clock_deadlines:  execution_id run-5, due_at_ms 1788193897268, completed_at_ms NULL
journal: 17 flows.engine.clock-scheduled · 22 control.agent.aborted "Cell frame interrupted" · 24 control.run.waiting-approval · 25 transitioned suspended
```

No `flows.engine.interrupted`, no `cancel_requested_at_ms`: the park is a
park. Items 4 and 5 ran during the window; their run-6 process was cancelled
and gone before the deadline. 35 s after the deadline, still with no smoke
process alive and the clock row still `completed_at_ms NULL`:

```
smithers run --resume run-5 --json      {"_tag":"Accepted","receiptId":"cli:resume:run-5:24","runId":"run-5"}   exit 0, 4.4 s
```

`woke.txt` contains `DONE`; both rows `completed` (`finished_at_ms`
1788193936679); the clock row stamped `completed_at_ms 1788193935580`.
Journal: `27 flows.engine.deferred-completed DurableClock/harness/wait/run-5/...`,
`28 wake-scheduled reason clock`, `29 claimed-and-activated previousStatus
suspended (pid 52018)`, the wait REPLAYED from the journal
(`cell-call-settled {"waitedSeconds":150}` lands 370 ms after the claim, no
second 150 s wait), `write woke.txt`, `66 transitioned completed` (59
events). A second `run --resume run-5` answers
`{"_tag":"Terminal","runId":"run-5","status":"completed"}` with exit 0, the
contract's join-or-claim wording for a settled run.

## 3. Resume a durable wait by delivering the awaited input: PASS

```
smithers up asker -d --json             {"detached":true,...,"runId":"run-7"}                                 exit 0, 6.3 s
```

21 s later the engine row read `suspended`/`approval` with `waiting_token`
`ask/run-7/7791e758...` and no smoke `bin.ts` process was alive. `ps --status
waiting-approval --json` lists exactly run-7. `status run-7` prints `Verdict
waiting-approval — asks: Ship the phase7 smoke release?` and an `Unblock`
approve command whose payload is byte-identical to the `payload` field of the
journaled `control.approval.requested` event (compared programmatically;
`status-run-7-parked.txt` against `approval-requested-run-7.json`).

```
smithers approve '<that payload>' --json                                             exit 0, 34.4 s
{"_tag":"Accepted","receiptId":"approve:ask/run-7/7791e758...","runId":"run-7"}
```

`decision.txt` contains `approved` (this time the model wrote the string
correctly on the first try; the previous smoke's schema-refusal round trip
did not recur). Both rows `completed` (`finished_at_ms` 1788194023608).
Journal: `23 control.approval.approved` 1788193992385, `24
control.run.resumed` +2 ms, `25 wake-scheduled reason operator` 30 s later
(the park-adoption bound), `26 claimed-and-activated` by pid 52675 — the
approve process itself, so the `&& smithers run --resume run-7` in the
`Unblock` line was again not needed (rc-contract 5.1) — `ask ->
{"answer":"approved","approved":true}`, `write decision.txt`, `59
transitioned completed` (58 events). `control_grants` gained
`('ask/run-7/7791e758...', '{"capabilities":[],"flows":["ask"],"budget":{}}',
'run')`; the table ends with 12 grants: ten plan grants and the two ask
grants (run-2 and run-7). `output run-7 result` prints `result success` /
`Recorded the decision in decision.txt.`

## 4. Deliver a signal: PASS

Against `run-6` (`canceller`) while its process and `bash` child were alive:

```
smithers signal run-6 '{"name":"go","payload":{"attempt":1}}' --json   {"_tag":"Accepted","receiptId":"cli:signal:run-6:d4476500"}        exit 0
smithers signal run-6 '{"name":"go","payload":{"attempt":1}}' --json   {"_tag":"AlreadyApplied","receiptId":"cli:signal:run-6:d4476500"}  exit 0
smithers signal run-6 '{"name":"go","payload":{"attempt":2}}' --json   {"_tag":"Accepted","receiptId":"cli:signal:run-6:6bbf2c01"}        exit 0
```

`control_run_messages` holds exactly two rows for run-6, one per distinct
payload, and the journal exactly two `control.signal.delivered` events (seq
20, 21); the replay appended nothing. Against runs in other states:

```
smithers signal run-5 '{"name":"go",...}' --json    (run-5 parked on its timer)
stderr: NoMatchingWait: no wait point named "go" is open on run run-5. Read `smithers status run-5` to see what that run is waiting for.
stdout: (empty)                                                                      exit 1
smithers signal run-3 '{"name":"go","payload":{}}' --json   (completed)   {"_tag":"Terminal","runId":"run-3","status":"completed"}   exit 0
smithers signal run-8 '{"name":"go","payload":{}}' --remote http://127.0.0.1:7351 --json   (cancelled)   {"_tag":"Terminal","runId":"run-8","status":"cancelled"}   exit 0
```

The timer-park refusal renders the full error name, message, and guidance
(the D3 fix holds). As before, no standard agent flow parks on `WaitFor`
(`StandardFlows` ships `wait` and `ask`), so wake-on-signal is covered by
`packages/control/test/EngineWaits.test.ts` and
`e2e/faults/case04-restart-waiting-event.test.ts`, not this smoke.

## 5. Cancel a run and prove terminal state and child cleanup: PASS

```
smithers up canceller -d --json         {"detached":true,...,"runId":"run-6"}                                 exit 0, 6.3 s
```

20 s later (journal seq 19 `cell-call-started bash {"mode":"unhermetic","command":"echo smoke-cancel-marker started; sleep 300; echo never"}`),
and again immediately before the cancel:

```
pid    ppid   pgid   command
24607      1  24607  node <ck>/packages/cli/src/bin.ts run {...plan-6...}      (engine owner_pid for run-6)
24709  24607  24709  /bin/sh -c echo smoke-cancel-marker started; sleep 300; echo never
24710  24709  24709  sleep 300
```

```
smithers cancel run-6 --json                        (16:30:54Z)                     exit 0, 3.1 s
{"_tag":"Terminal","runId":"run-6","status":"cancelled"}
```

6 s later: no smoke `bin.ts run`, `sh`, or `sleep 300` process; pids 24709
and 24710 gone; the final sweep found no orphan under ppid 1 either. Rows:
engine `('run-6','cancelled', cancel_requested_at_ms 1788193854075,
finished_at_ms 1788193854287, owner NULL)`, control `cancelled`. Journal: `22
control.run.cancel-requested` (principal `local`/`operator`), `23
control.run.cancelled` +2 ms, `25 flows.engine.interrupted
{"outcome":"cancelled"}` 212 ms after the request (26 events). A second
`cancel run-6` answers `Terminal cancelled` again and the journal stays at 26
events. The gateway-hosted cancel (run-8, item 7) shows the same shape from a
remote caller: `cancel_requested_at_ms` 1788194244477, `finished_at_ms` 7 ms
later.

## 6. Inspect journal and events with the CLI: PASS

```
smithers logs run-5                     30 transcript lines: run.accepted, turn 1, call wait 150, run.waiting-approval,
                                        [+03:14] run.resume, turn 2 replay, -> ok {"waitedSeconds":150}, write woke.txt,
                                        complete, run.completed · header "completed · 3m 16s · 2 turns · 3 calls"        exit 0
smithers events run-5 --json            59 events — exactly the journal's 59 rows for run-5                              exit 0
smithers logs run-7 --json              58 events (= journal)     smithers logs run-1 --json    11 events (= journal)    exit 0
smithers logs run-4 --follow            prints the 53 existing events then stays open (timeout 20 → exit 124; observation O3)
smithers output run-5 result            result success / woke.txt created with exactly DONE after the wait               exit 0
smithers inspect run-4                  the same diagnosis card as status (alias)                                        exit 0
smithers ps                             all runs with status/planId/planDigest/steering.pending, pretty JSON (observation O4)
smithers gc --older-than 0s --dry-run --json                                                                             exit 0
  reports: control.db runs [run-1..run-7], engine.db runs [run-1..run-7]     (all seven then-terminal runs, both databases)
```

Direct `sqlite3` reads of `engine.db` match the CLI's lifecycle view
throughout (`rows-run-*.txt`). At this HEAD the CLI's per-run event counts
equal the journal's row counts exactly (run-1 11/11, run-5 59/59, run-7
58/58). `control.db flows_journal_events` is empty; the CLI reads the engine
journal.

## 7. Gateway and UI against the run: PASS

```
smithers serve --host 127.0.0.1 --port 7351         (pid 53910; /health answered after 4 s)
curl -i /health                          200 {"workspaceHash":"ad528ba4146165d9","gatewayId":"cli-53910","protocolVersion":"1","version":"1.0.0-rc.0"}
curl -X POST -H 'content-type: application/json' --data '{}' /rpc
                                         400 {"_tag":"flows/gateway/GatewayError","code":"malformed_request","message":"POST /rpc carries no RPC request message"}
printf '{"_tag":"Request","id":1,"tag":"List","payload":{"_tag":"runs"},"headers":[]}\n' | curl -X POST -H 'content-type: application/ndjson' --data-binary @- /rpc
                                         200 application/ndjson, 1713 bytes: {"_tag":"Exit","requestId":1,"exit":{"_tag":"Success","value":{"_tag":"runs","items":[run-1 ... run-7]}}}
curl -i /projections                     404, empty body (no projection named; observation O6)
```

The raw frame shape (`id` a number, `headers` an array) is the one
`apps/server/src/gatewayRpc.ts` documents; a frame with a string id or an
object `headers` is not a request the transport parses (the first returns an
empty 200, the second a 500), which is worth knowing when driving `/rpc` by
hand. Remote CLI from `phase7/smoke-remote/` (no `flows/`), each command a
separate process over the shipped `ControlClient` (`transcript-remote.log`):

```
smithers ls --remote http://127.0.0.1:7351 --json          the five flows                                     exit 0, 1.0 s
smithers ps --remote ... --json                             all runs with their statuses                       exit 0, 1.1 s
smithers status run-5 --remote ...                          the same diagnosis card as locally                 exit 0, 1.0 s
smithers logs run-7 --remote ... --json                     58 events (same count as locally)                  exit 0
smithers up hello --remote ... --json                       {"_tag":"Accepted","receiptId":"approve:plan-8","runId":"run-8"}   exit 0, 1.1 s
smithers status run-8 --remote ...                          Verdict running                                    exit 0, 1.3 s
smithers cancel run-8 --remote ... --json                   {"_tag":"Terminal","runId":"run-8","status":"cancelled"}           exit 0, 1.0 s
smithers up hello --remote ... --json                       {"_tag":"Accepted","receiptId":"approve:plan-9","runId":"run-9"}   exit 0, 1.1 s
   (control.db polled every 2 s)                            run-9 completed after ~8 s
smithers status run-9 --remote ...                          Verdict completed — Created result.txt · 1 turns · 1 calls · edits 1/1
smithers signal run-8 '{"name":"go","payload":{}}' --remote ... --json    {"_tag":"Terminal","runId":"run-8","status":"cancelled"}
```

run-8 and run-9 were planned, approved, launched, executed, and (run-8)
cancelled entirely through the gateway: every `flows.engine.run-decision` for
both names owner pid 53910 (the serve process), `result.txt`'s mtime moved to
16:37Z, and both engine rows are terminal with `finished_at_ms` set (run-8
`cancelled` 1788194244484, run-9 `completed` 1788194252699). `up --remote`
returns after admission (observation O7). `kill -TERM 53910` stopped the
gateway immediately; port 7351 had zero listeners afterwards.

UI, three proofs at this HEAD:

```
cd apps/ui && corepack pnpm run proof:gateway                                        exit 0
  5. approve: ok the decision was ONE relayed call · ok the gateway resumed the run on the caller's behalf
  8. cancel:  ok the cancel is durable: the run reads cancelled · ok the control plane itself says the same
  Relayed procedures: List, Plan, Approval.Submit, Run, Projection.Snapshot ×4, Approval.Submit, Cancel
  PROOF PASSED

corepack pnpm run build:web                          vite built in 488 ms, exit 0
dist/__build.json: {"app":"smithers-ui","gitSha":"341c8fa87e2dadbe80d0f0d3258dae112a7d03d3","builtAt":"2026-08-31T16:38:03.913Z"}

SMITHERS_LOCAL_MODE=offline bun src/bun/serve.ts    origin http://127.0.0.1:49886 in under 2 s
curl / -> 200 (4,157 bytes)     curl /api/bootstrap with no session header -> 401 local_session_required
```

Loaded in headless Chrome through Playwright 1.62.1
(`smoke-artifacts/ui-shot.mjs`, screenshot `ui-local.png`, 49,613 bytes):
page title `Smithers`; sidebar `REPOS`, `Select a repo`, `New tab`; the card
`Smithers initialized successfully` with `Details`, the no-identity notice,
the repo picker, and the composer with a `Chat` mode button. With the session
token the document carries, the page made `GET /api/bootstrap` 200, `GET
/api/repos` 200, `GET /api/harnesses` 200; zero console messages, zero page
errors, zero failed requests. As before, the local UI host serves
repositories, targets, terminals, and harnesses and does not connect to
`smithers serve`; the UI-to-gateway evidence is the seam proof above
(`apps/ui/docs/LOCAL-APP.md`). `kill -TERM` stopped it within 1 s.

## 8. Exercise one real integration: PASS

```
cd <ck>/packages/integrations
GITHUB_TOKEN="$(gh auth token)" corepack pnpm exec vitest run test/GitHubLive.test.ts --coverage.enabled=false
 Test Files  1 passed (1)      Tests  4 passed (4)      Duration  1.80s                exit 0
corepack pnpm exec vitest run test/LinearLive.test.ts --coverage.enabled=false
 Test Files  1 passed (1)      Tests  4 passed (4)      Duration  1.19s                exit 0
```

Both suites are `describe.skipIf(credential === undefined)` and both ran
against `api.github.com` and `api.linear.app` with the credentials named in
the environment table; 4 passed and 0 skipped in each (`github-live.log`,
`linear-live.log`). No ENV-SKIP.

## Regression: a later local executor leaves earlier rows alone

After items 1 through 7, with nine terminal runs in the project:

```
smithers up hello --json > up10.out 2> up10.err                                      exit 0, 11.0 s
stdout: {"_tag":"Accepted","receiptId":"approve:plan-10","runId":"run-10"}      stderr: 0 bytes
```

`flows_journal_events` counts before and after differ by exactly
`plan:plan-10 2` and `run-10 36`; no earlier key gained an event
(`journal-counts-{before,after}-run10.txt`, `diff` recorded). The decision
chains for the whole project (`final-db-state.txt`):

```
run-4   created > claimed-and-activated(22672) > stolen-and-activated(23339) > transitioned          (SIGKILL, 2a)
run-5   created > claimed(24446) > transitioned > wake-scheduled > claimed(52018) > wake-scheduled > transitioned   (clock, 2b)
run-2   created > claimed(59850) > transitioned > wake-scheduled > claimed(85051) > transitioned     (operator ask, 1b)
run-7   created > claimed(52499) > transitioned > wake-scheduled > claimed(52675) > transitioned     (operator ask, 3)
run-1, run-3, run-9, run-10   created > claimed > transitioned      run-6, run-8   created > claimed  (then flows.engine.interrupted cancelled)
```

Zero `interrupt-released` decisions exist in the project, and the only
cross-process claims are the four the smoke created on purpose.

## Observations that are not blockers

- O1 (carried forward). The harness journals `control.run.waiting-approval`
  for a timer park (run-5 seq 24) and `status` labels it `waiting-approval`.
  The `Unblock` approve line is absent for a timer park, so no false command
  is offered, but the verdict wording is wrong for the wait it describes.
- O2 from the previous smoke (`init` ships no `model:` line) is CLOSED by
  wave 8; item 1a is the replacement evidence.
- O3 (carried forward). `logs <run> --follow` on a terminal run prints the
  existing events (53 for run-4) and stays open until killed (exit 124),
  matching the declared "streams future events" behavior.
- O4 (carried forward). `ps` without `--json` prints pretty-printed JSON
  rather than a table.
- O5 (carried forward). `status` token totals after a resume count the
  replayed turn's usage again (run-4: `11,526 in` for one real call; the `1
  duplicate` in the Activity line names the replay). The replayed
  `model-settled` lands in the same millisecond as its `turn-opened`; no
  second model call was made.
- O6 (carried forward). `GET /projections` with no projection name answers
  404 with an empty body.
- O7 (carried forward). `up --remote` returns after admission (1.1 s); the
  contract's `run` blocks only "when the local process owns the executor".
- N1 (new). The no-credits settlement path prints a second WARN on stderr:
  `engine-store: the settlement of agent/run could not be encoded through its
  own codec; persisting a JSON projection so the run still settles
  (SchemaError: Expected JSON value at ["exit"]["cause"][0]["error"])`. The
  fallback it announces worked — the run settled `failed` in both databases —
  and stdout stayed a single JSON document, but the path is noisy: two stack
  traces for one billing refusal.
- N2 (new). The as-written scaffold body, launched with no concrete request
  on a live seat, reads the project and parks on a clarification `ask`
  before doing anything (run-2), then settles `completed` / "No change is
  needed." once the ask is approved. Operators running the quick start
  verbatim should expect a question, not an edit; the run stays durable and
  terminal either way.
- N3 (new). Two read-only CLI invocations from the setup (`--version`, `ls
  --json`) were observed still alive as processes about six minutes after
  printing their output and exiting their runner (1-minute load ~19 at the
  time); both were gone seconds later without intervention, held no run
  state, and wrote nothing. Every run-owning process exited promptly
  throughout the smoke.
- O8 (carried forward, milder). Command boot ranged 3 to 6 s, and the final
  `up hello` took 11.0 s while the host's 1-minute load peaked near 26 from
  unrelated agents. No timeout fired and no lease was lost.

## Final state

`ps --json` at the end: run-1 failed, run-2 completed, run-3 completed, run-4
completed, run-5 completed, run-6 cancelled, run-7 completed, run-8
cancelled, run-9 completed, run-10 completed. `engine.db flows_runs`: every
row terminal with `finished_at_ms` set and `owner_pid` NULL;
`cancel_requested_at_ms` set on run-6 and run-8 only. `control.db flows_runs`:
the same ten statuses with `finished_at_ms` set on every row. The
accepted/pid-0 sweep is empty in both databases. `flows_clock_deadlines`: one
row (run-5), `completed_at_ms` stamped. `control_run_messages`: two rows
(run-6). `control_grants`: ten plan grants plus the run-2 and run-7 ask
grants. Files in the project: `result.txt` `OK` (rewritten by run-9 and
run-10), `woke.txt` `DONE`, `woke2.txt` `DONE`, `decision.txt` `approved`.
The gateway and the UI server were stopped; no `clean-checkout-4` process, no
listener on 7351, and no orphan `sleep 300` remained. The clean checkout's
tracked tree is unmodified (`git status --short` empty). Disk: 13 GiB free at
the end; no pack copies or docs builds were created by this gate.

## Blockers for a fix lane

None. The wave 8 init-scaffold-launch guarantees hold on the real binary in
both directions (a settled `failed` run under the credit-less ambient key, a
completed run on the funded seat), and every previously closed blocker
(D1/D2/D3 of the `20b32c6316` round) stays closed at this HEAD. N1's double
WARN is release-note material, not a gate failure.
