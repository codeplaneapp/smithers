# Phase 7 fix lane: engine-park

Round 1. Branch `phase7/engine-park`, worktree
`/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/wt/engine-park`,
based on `9c464343f0`.

Verdict: four of the five spec items are fixed with recorded red runs. Item 3
is fixed for the half the smoke actually blocked on (a parked run is continued
by a later process, bounded); its "fail typed on a run that cannot be
continued" half is not pinned. Item 4 is fixed for the half the spec names a
remedy for (the replayed `cli:cancel:<runId>` receipt); its delegation halves
were investigated and are reported below rather than changed.

## Root cause, confirmed at the source

`packages/agent/src/AgentSession.ts` `driver()` at HEAD, lines 1208-1229:

```ts
        yield* engine.execute(agentFlow, { executionId: runId, payload: { runId, planId }, discard: true }).pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function*() {
              const bodyFiber = activeBodies.get(runId)
              if (bodyFiber !== undefined) {
                yield* Fiber.interrupt(bodyFiber).pipe(Effect.forkDetach({ startImmediately: true }))
              }
              yield* preserveDriverInterrupt(() => engine.interrupt(agentFlow, runId)).pipe(
                Effect.forkDetach({ startImmediately: true })
              )
            })
          )
        )
```

`engine.interrupt` is the DURABLE cancel: `RunDriver.ts:2162-2205` writes
`store.requestCancel(executionId, nowMs)` before it touches any fiber. A park
and a process shutdown both interrupt the driver fiber, so both recorded the
request. `RunDriver.settleRound`'s suspended transition is guarded on
`{ cancelRequested: "absent" }`, so it answered `GuardFailed` and fell into
`cancelOwned` (`RunDriver.ts:1002-1078`), which completes the run's clock rows
and journals `flows.engine.interrupted {"outcome":"cancelled"}`.

`Control.cancel` already writes the durable half itself, inside its own
mutation transaction and before it interrupts anything
(`ControlLive.ts:807-810`, `executorRequestCancel` → `AgentSession.requestCancel`
→ `RunStore.requestCancel`), and `RunDriver.settleInterrupted` exists to
discriminate on exactly that record. The driver's copy made the fiber's own
interruption its own evidence.

## Items

### 1. PARK — done

Test: `packages/agent/test/EngineParkAcrossProcesses.test.ts`

- `a run parked on a durable timer when its process exits > stays suspended on
  \`timer\` with its deadline still pending, and is never cancelled`
- `a run parked on an in-run ask when its process exits > stays suspended on
  \`approval\`, and is never cancelled`

Two compositions over one pair of real SQLite files (`engine.db`, `control.db`)
built from `NodeRuntime.layer` + `AgentSession.layer` + `ControlLive.layer`, the
stack `NodeControl` composes. The first composition returns — its scope closes —
on the same event the shipped CLI returns on (`control.run.waiting-approval`,
`packages/cli/src/Command.ts` `settled`), which is what makes the race the
operator's race. The rows are then read with `node:sqlite`.

Red, against the pre-fix source (`9c464343f0`):

```
AssertionError: expected 'cancelled' to be 'suspended' // Object.is equality
 ❯ test/EngineParkAcrossProcesses.test.ts:374:25
```

(both cases, timer and ask.)

After removing `engine.interrupt` from the driver, the second red:

```
AssertionError: expected 'released' to be 'timer' // Object.is equality
AssertionError: expected 'released' to be 'approval' // Object.is equality
```

and after classifying the interrupted park, the third:

```
AssertionError: expected 'event' to be 'approval' // Object.is equality
```

Fixes:

- `packages/agent/src/AgentSession.ts` `driver()` — the interrupt handler
  interrupts the active flow body and nothing else.
- `packages/engine-store/src/internal/RunDriver.ts` — new `interruptedWaiting`,
  and `releaseOwned` takes the round's flow and instance. A round whose flow had
  already asked to suspend parks under its declared reason, or the earliest
  pending clock deadline, or `event`; only a round that had not asked to suspend
  is `released` (issue #39). The interrupted park also records the `Suspended`
  result on the row, which is what `poll` publishes.
- `packages/agent/src/AgentSession.ts` `authorize()` — the ask gate calls
  `FlowRuntime.annotateWaiting({ reason: "approval", token: requestId })` before
  it fails with `PermissionRequired`. An in-run ask arms no clock, so the engine
  derived `event`, the reason `Control.steer` wakes on a message.

### 2. SHUTDOWN — done

Test: `a run still executing when its process shuts down > is released for
reclaim rather than cancelled`. The run is caught inside a cell call the host's
own flow handler holds open, and the composition's scope then closes.

Red:

```
AssertionError: expected 'cancelled' not to be 'cancelled' // Object.is equality
 ❯ test/EngineParkAcrossProcesses.test.ts:424:29
```

Green: `waiting_reason` `released`, `cancel_requested_at_ms` null, no
`flows.engine.interrupted {"outcome":"cancelled"}`. rc-contract section 7's one
cancellation path is `Control.cancel` / `RunStore.requestCancel` alone.

Fix location: the same `AgentSession.driver` change as item 1.

### 3. RESUME — done for the blocked half

Test: `a parked run resumed by a later process > continues the ask-parked run to
completion when a second process approves`. The parking composition exits at the
park; a second composition over the same two files approves and drives the run
to `completed`, and the note the resumed frame writes carries the second
composition's engine id.

Red:

```
Unknown Error: run run-1 never reached completed (still waiting-approval)
```

Root cause of the hang, at the source: `poll` (`RunDriver.ts:2104-2144`) answers
`Option.none` for a state with no `result`, and `AgentSession.awaitParked` only
counts a published `Suspended` as parked, so `takeUpResume` answered `"unknown"`,
nothing drove the run, and the CLI blocked in `awaitRun` with no output. Fixed by
recording the suspension on the interrupted park (item 1).

Bound: the completion is bounded by `Ownership.heartbeatStaleAfter` (30 s) plus
one delegation poll — `AgentSession.hostsPark` will not let a composition that
did not park a run adopt its delegation before then. The test allows 90 s and the
whole file settles in about 35 s.

Not done: `smithers run --resume` and `smithers approve` against a run that
cannot be continued still return no typed refusal; they return their receipt and
the run stays where it was. No test pins that half.

### 4. DELEGATION — done for the receipt half

Tests:

- `packages/control/test/CancelReceiptReplay.test.ts` — `a cancel that did not
  finish the run > asks again instead of replaying its own receipt`, and
  `> replays the receipt of a cancel that DID finish the run`.
- Real binary, two separate processes, transcript below.

Red:

```
AssertionError: expected 'AlreadyApplied' not to be 'AlreadyApplied' // Object.is equality
 ❯ test/CancelReceiptReplay.test.ts:93:39

AssertionError: expected { _tag: 'AlreadyApplied', …(2) } to match object { _tag: 'Terminal', …(1) }
 ❯ test/CancelReceiptReplay.test.ts:136:30
```

Fix: `packages/control/src/ControlLive.ts` — `mutate` takes a `replay` flag and
`cancel` passes `false`. Cancellation needs no receipt to be idempotent: the
run's own terminality is stronger, and `cancel` reads it first (rc-contract
section 7: "A cancel against a terminal run returns the `Terminal` receipt and
writes no event"). A key that already carries a receipt is not re-recorded,
because `recordMutation` refuses to overwrite one. Every other mutation is
unchanged.

Retargeted, not deleted:

- `packages/control/test/ControlContract.ts` `cancels by interrupting the owning
  Effect fiber` — the replay now expects `Terminal`.
- `packages/cli/test/CommandHandlers.test.ts` — renamed to `answers a repeated
  cancel from the run rather than from its receipt`, expecting `Terminal`.

Investigated and not changed, with the evidence:

- A stale delegation for a settled run is already filtered in SQL:
  `SqlControlRuntime.pendingResumes` joins `flows_runs` and excludes
  `completed|failed|cancelled`.
- A terminal control row is already refused a claim: `SqlControlRuntime.resume`
  and `.interrupt` both test `terminal(summary.status)` first.
- The smoke's own regression (run-3 going `cancelled` → `running`) is downstream
  of item 1: the ENGINE row was cancelled at the park while the CONTROL row was
  still `waiting-approval`, so `Control.resume` saw a non-terminal control row
  and claimed it. With the park fixed, neither row is cancelled and the resume is
  the ordinary one item 3 pins. No separate defect was reproduced, so nothing was
  changed on this seam.

### 5. EXIT — root cause found and fixed

Tests:

- `packages/control/test/CancelSettlement.test.ts` — `the journal of a cancelled
  run > carries the terminal status the launching process is waiting for`.
- `packages/agent/test/EngineParkAcrossProcesses.test.ts` — `a running process
  whose run is cancelled from another one > is told the run settled, so it has
  something to stop waiting for`, in the production composition with a real
  engine and a real executor.

Red:

```
AssertionError: expected [ 'control.run.pending' ] to deeply equal [ 'control.run.cancelled' ]
 ❯ test/CancelSettlement.test.ts:69:37

AssertionError: expected [] to include 'control.run.cancelled'
 ❯ test/EngineParkAcrossProcesses.test.ts:476:39
```

`control.run.cancelled` had no writer anywhere. `Control.cancel` journals
`control.run.cancel-requested` (`Cancellation.requestedEventType`) and then moves
the row through `ControlRuntime.interrupt`, which writes no journal event;
`AgentSession.settle` writes none either, because the control operation owns a
cancellation's terminal write. `packages/cli/src/Command.ts` `settled` is the
whole exit condition of a local `smithers run` — the process keeps its executor
alive until the run's journal says there is nothing left to drive — so a detached
engine whose run was cancelled by a second process was waiting for an event
nothing emits. That is the smoke's pid 10105, alive at 0.1 % CPU for 4 min 33 s
after its run read `Terminal cancelled`.

Fix: `packages/control/src/ControlLive.ts` `cancel` emits
`control.run.<status>` when `runtime.interrupt` returns a terminal summary.

Bound: `SqlJournal.stream`'s follower rechecks the durable tail once a second
(`SqlJournal.ts:812-823`, "a bounded poll must recheck both the durable tail and
the compaction floor"), so a detached process observes the settlement within one
second of the cancelling process's commit and then exits through
`NodeRuntime.runMain`'s teardown. The detached-pid measurement itself was not
repeated: `smithers up -d` needs an agent flow, an agent flow needs a model seat,
and this lane used no provider credit.

## Smoke recipe re-run at the lane HEAD

Real binary (`node --no-warnings packages/cli/src/bin.ts`), a temp project with
real `.flows/control.db` and `.flows/engine.db`, no provider key exported.

```
$ smithers --version
smithers v1.0.0-rc.0                                                    exit 0
$ smithers init hello --json
{"created":true,"flowFile":".../smoke-rerun/flows/hello/flow.mdx","gitignore":"skipped","name":"hello","stateDirectory":".../smoke-rerun/.flows"}   exit 0
$ smithers ls --json
{"_tag":"flows","items":[{"description":"A starter Smithers flow.","flowId":"hello"}]}   exit 0
$ smithers plan hello --json
{"approval":{"idempotencyKey":"approve:plan-1","scope":"run","target":{"_tag":"Plan","digest":"20f1ce02...","envelope":{...},"planId":"plan-1"}},...}   exit 0
$ smithers run '<payload>' --json
{"_tag":"Parked","planId":"plan-1","receiptId":"approve:plan-1","status":"waiting-approval"}   exit 3
$ smithers approve '<payload>' --scope run --json
{"_tag":"Accepted","receiptId":"approve:plan-1"}                        exit 0
$ env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY ... smithers run '<payload>' --json
{"...","runId":"run-1","status":"accepted",...}
Run run-1 was accepted but the executor did not take it: it is accepted with
nothing running. ...                                                    exit 1
$ smithers ps --json
{"_tag":"runs","items":[{"runId":"run-1","status":"accepted",...}]}     exit 0
```

The run is left non-terminal with nothing driving it, which is the state the
smoke's two stuck runs were in. Then, each command a separate process:

Pre-fix (`packages/control/src/ControlLive.ts` restored to `afaf85211b`):

```
$ smithers cancel run-1 --json
{"_tag":"Terminal","runId":"run-1","status":"cancelled"}
$ smithers cancel run-1 --json
{"_tag":"AlreadyApplied","receiptId":"cli:cancel:run-1","runId":"run-1"}
$ smithers down --json
{"cancelled":[]}
```

At the lane HEAD:

```
$ smithers cancel run-1 --json
{"_tag":"Terminal","runId":"run-1","status":"cancelled"}                exit 0
$ smithers cancel run-1 --json
{"_tag":"Terminal","runId":"run-1","status":"cancelled"}                exit 0
$ smithers down --json
{"cancelled":[]}                                                        exit 0
$ smithers ps --json
{"_tag":"runs","items":[{"runId":"run-1","status":"cancelled",...}]}    exit 0
$ smithers gc --older-than 0s --dry-run --json
{"dryRun":true,"failures":[],"reports":[{"database":".../control.db","runs":["run-1"]},{"database":".../engine.db","runs":[]}]}   exit 0
```

`gc` lists the run rather than skipping it, which is the other half of the
smoke's "the parked rows cannot be terminated".

The `up -d`, `sleeper`, `asker`, and `canceller` legs of the smoke were not run
against the binary: each needs a model seat, and this lane used none. Their
behaviour is pinned instead by
`packages/agent/test/EngineParkAcrossProcesses.test.ts`, which runs the same
composition `NodeControl` builds — the durable engine over `engine.db`, the
production `AgentSession` executor, `ControlLive` over `control.db` — with a
scripted model, and which takes one composition's scope down between the park
and the read exactly as the detached process exits.

## Gates

Machine load is the one-minute average printed by `uptime` immediately before
each command.

```
load 18.72  packages/agent        vitest run              28 files, 421 tests, 0 failed
load 20.43  packages/engine-store vitest run              99 files, 796 tests, 0 failed
load 20.43  packages/control      vitest run              27 files, 224 tests, 0 failed
load 20.43  packages/cli          vitest run              36 files, 605 tests, 0 failed
load 15.99  packages/flows        vitest run              12 files, 403 tests, 0 failed
load 18.32  packages/gateway      vitest run               9 files,  85 tests, 0 failed
load 18.32  packages/time-travel  vitest run              34 files, 312 tests, 0 failed
load 18.32  packages/registry     vitest run              15 files, 319 tests, 0 failed
load 18.32  packages/std          vitest run              24 files, 283 tests, 0 failed
load 18.32  packages/migrate      vitest run              28 files, 374 tests, 6 skipped, 0 failed
load 18.32  packages/triggers     vitest run               8 files,  37 tests, 0 failed
load 39.07  agent/engine-store/control/cli  tsc -b + tsc -p tsconfig.test.json --noEmit   clean
load 39.07  agent/engine-store/control/cli  eslint src --max-warnings=0 + dprint check    clean
load 27.03  agent/engine-store/control/cli  node scripts/circular.mjs                     clean
```

Dependents of `@smthrs/{agent,control,engine-store}` in the workspace: `cli`,
`create-app`, `flows`, `gateway`, `integrations`, `migrate`, `registry`, `std`,
`time-travel`, `triggers`. `integrations` and `create-app` were not run:
`integrations` needs live GitHub and Linear credentials and `create-app`
scaffolds against the network.

Neither `pnpm-lock.yaml` nor `bun.lock` changed. No manifest changed.

## Commits

```
1748d0c0ce test(agent): pin that a durable park and a shutdown are not cancellations
05a1f78380 fix(agent,engine-store): a durable park is not a cancellation
4fdb44cebc fix(control): a cancel answers from the run, never from its own receipt
afaf85211b chore(cli,agent): retarget the cli cancel-replay pin and format the ask gate
98b288b0b9 fix(control): journal the terminal status a cancel writes
d33e54c9fb test(agent): pin the cancelled settlement event in the production composition
108547c46c chore(agent): drop the imports the rewritten settlement case no longer uses
```

## Left for a later round

1. `smithers run --resume` and `smithers approve` against a run that cannot be
   continued return their receipt and no typed refusal. The silent block is
   fixed; the typed answer is not written.
2. `AgentSession.preserveDriverInterrupt` is still exported, documented in
   `packages/agent/README.md`, and unit-tested, but `src` no longer calls it.
   Removing it is a public-surface change with a docs regeneration attached, so
   it was left alone rather than folded into a fix lane.
3. `AgentSession.hostsPark` makes a composition that did not park a run wait out
   `Ownership.heartbeatStaleAfter` (30 s) before adopting its delegation, even
   when the parking process is provably gone. The park fence (`parkedBy`) carries
   the owner identity and its pid, so the liveness question could be asked
   instead of timed out.
4. The detached-process exit was not measured against a real pid, for want of a
   model seat. The event it waits for now exists and is pinned twice.

---

# Round 2

Branch `phase7/engine-park`, same worktree, based on the round 1 head
`108547c46c`. Three commits: `7cea521cbf`, `c186ef53ec`, `a73c846f5e`.

Verdict: all four round 1 verifier findings are closed, each with a recorded
red run and a green one, and the whole path is re-run against the real binary
with a real model seat — the leg round 1 could not run. One residual is stated
at the end: a bare `smithers cancel` leaves the ENGINE row `suspended` with its
durable request until any engine composition runs, which takes one
`Ownership.heartbeatInterval` tick and is measured below.

## Finding 1 (major) — a cancel finishes the run nobody is driving

Confirmed at the source. `packages/control/src/SqlControlRuntime.ts:1221`:

```ts
        if (!ownedByUs(row)) return yield* new ClaimLost({ runId })
```

and `ownedByUs` (`SqlControlRuntime.ts:781-786`) requires `row.status ===
"running"`. A park writes store status `suspended` and releases the owner
columns, so every process — including the one that parked the run — is refused.
`Control.cancel` caught that refusal and answered `Accepted`
(`ControlLive.ts:848-854` at `108547c46c`), on the reading that a live peer
owns the run and will act on the durable request. For a parked run there is no
peer: nothing reads the request, and the control row stays parked forever.

Tests:

- `packages/control/test/TerminalControl.test.ts` — `cancelling a run nobody is
  driving > settles the parked control row instead of accepting a request no
  owner will act on`.
- `packages/agent/test/EngineParkAcrossProcesses.test.ts` — `a run parked on an
  in-run ask that a later process cancels > settles both rows and answers the
  ask with the run's terminal status`. Two compositions over one pair of real
  SQLite files, the stack `NodeControl` composes; the parking composition's
  scope closes on the same event the shipped CLI returns on.

Red, against `108547c46c`:

```
AssertionError: expected { _tag: 'Accepted', …(2) } to deeply equal { _tag: 'Terminal', …(2) }
 ❯ test/TerminalControl.test.ts:408:30

AssertionError: expected { _tag: 'Accepted', …(2) } to deeply equal { _tag: 'Terminal', …(2) }
 ❯ test/EngineParkAcrossProcesses.test.ts:585:32
```

Fix: `packages/control/src/ControlLive.ts` `cancel`. The lost claim is read for
what it is. `live(current.status)` — `running` or `accepted` — keeps the old
answer, because a live peer really is going to act. Anything else is a run
nobody holds, and the cancelling process claims the park and interrupts it:

```ts
              Effect.catchTag("/control/ClaimLost", () =>
                live(current.status)
                  ? Effect.succeed(undefined)
                  : runtime.resume(input.runId).pipe(
                    Effect.andThen(runtime.interrupt(input.runId)),
                    Effect.catchTag("/control/ClaimLost", () => Effect.succeed(undefined))
                  ))
```

`ControlRuntime.resume` and `.interrupt` are unchanged: the claim is the
existing "claim any suspended run" path, and a claim that loses the race is a
peer that just took the park, which is the branch above it. `Control.cancel`'s
existing terminal-status writer then journals `control.run.cancelled`, so the
receipt is `Terminal` and the run is collectable.

Green, and both rows agree: the engine row carries `cancel_requested_at_ms` and
settles `cancelled` on the next sweep tick of any live engine
(`RunDriver.sweepCancelRequested`, every `Ownership.heartbeatInterval` = 1 s);
the control row is terminal in the cancelling call itself.

The verifier also asked for `AgentSession.awaitParked` to treat a cancelled
engine row as settled. It already does and no change was needed:
`waitForParked` (`AgentSession.ts:606-618`) returns as soon as `engine.poll`
answers `Some`, and a settled execution publishes a state with a result, so the
wait ends at once and `takeUpResume` answers `"unknown"`. The 120-second block
the smoke measured was in the CLI, not there: `Command.ts` `awaitOwnedRun`
waits on the run's journal for a settlement, and only for an `Accepted`
receipt. Finding 3's fix removes that wait by answering `Terminal`, which is
measured against the real binary below.

## Finding 2 (minor) — one cancellation, one attribution record

Confirmed at the source. `ControlLive.ts` `cancel` emitted
`Cancellation.requestedEventType` unconditionally, and `mutate(..., replay:
false)` re-executes the whole effect for every repeat, so each `cancel` and
`down` journaled another attribution event for the same cancellation.

Test: `packages/control/test/TerminalControl.test.ts` — `a cancel repeated
against a run it cannot finish > attributes the request once, however many
times it is asked`. Three cancels against a run a live peer holds.

Red:

```
AssertionError: expected [ Array(3) ] to have a length of 1 but got 3
 ❯ test/TerminalControl.test.ts:445:87
```

Fix: the difference already exists one layer down.
`RunStore.RequestCancelOutcome` distinguishes `CancelRequested` from
`AlreadyRequested`, and the executor port now carries it through:

- `packages/control/src/ControlExecutor.ts` — `CancelRecord` gains
  `already-requested`.
- `packages/agent/src/AgentSession.ts` `requestCancel` — maps the store's
  outcome to it.
- `packages/control/src/ControlLive.ts` `cancel` — emits the attribution event
  only when the request was newly recorded, and still re-reads terminality and
  re-attempts the interrupt on every ask.

Retargeted, not deleted: `packages/agent/test/AgentSessionPorts.test.ts`
`records the cancellation on the engine row` asserted `recorded` for the repeat
and now asserts `already-requested` (`test/AgentSessionPorts.test.ts:147`); the
timestamp assertion beside it is unchanged, which is the part that says the
repeat wrote nothing.

## Finding 3 (minor) — a resume and a decision answer from the run

Confirmed at the source. `mutate` returns a recorded receipt before the effect
runs (`ControlLive.ts:191-195`), and `runMutation`'s terminality read was
INSIDE that effect, so a key that already carried a receipt never reached it.
`decide` had no terminality read at all.

Tests:

- `packages/control/test/TerminalControl.test.ts` — `resuming a run that has
  already settled > answers Terminal even when the resume key already carries a
  receipt`.
- `packages/control/test/ApprovalResume.test.ts` — `deciding an in-run approval
  on a run that has already settled > answers Terminal instead of delegating a
  resume nothing can take up`, and `> answers Terminal for a repeat rather than
  replaying the decision's receipt`.
- `packages/cli/test/CommandHandlers.test.ts` — `answers a repeated resume from
  the run rather than from its receipt`, through the real parser and the real
  `ControlLive` (`TestControl` composes it over the in-memory runtime).

Red:

```
AssertionError: expected { _tag: 'AlreadyApplied', …(2) } to deeply equal { _tag: 'Terminal', …(2) }
 ❯ test/TerminalControl.test.ts:479:28

AssertionError: expected { _tag: 'Accepted', …(2) } to deeply equal { _tag: 'Terminal', …(2) }
 ❯ test/ApprovalResume.test.ts:285:30

AssertionError: expected { _tag: 'AlreadyApplied', …(2) } to deeply equal { _tag: 'Terminal', …(2) }
 ❯ test/ApprovalResume.test.ts:310:28

AssertionError: expected { _tag: 'AlreadyApplied', …(2) } to match object { _tag: 'Terminal', …(1) }
 ❯ test/CommandHandlers.test.ts:298:27

AssertionError: expected { _tag: 'Accepted', …(2) } to deeply equal { _tag: 'Terminal', …(2) }
 ❯ test/EngineParkAcrossProcesses.test.ts:593:30
```

The last one is the same production-composition case as finding 1, measured
against the intermediate tree that had finding 1 fixed and this one not.

Fix: `packages/control/src/ControlLive.ts`.

- `runMutation` reads the run before `mutate` and answers `Terminal {status}`.
  The inner read stays, for the run that settles between them.
- `decide` reads a `Node` target's run before `mutate` and answers the same. A
  `Plan` target has no run; a run this plane cannot find is left to
  `lookupApproval` to refuse. A decision on a settled run installs no grant and
  records no delegation, because a standing resume for a cancelled run is a
  restart every host poll re-reads and no host may take up.

## Finding 4 (minor) — the two round 1 line references

Corrected here rather than by rewriting round 1's text, so the record of what
was reported stays legible:

- Round 1, item 1, the first red block: the quoted `expected 'cancelled' to be
  'suspended'` is `test/EngineParkAcrossProcesses.test.ts:374:25` for the TIMER
  case and `:397:25` for the ASK case. Round 1 wrote `374:25` and annotated it
  "(both cases)", which is wrong for the ask case. Both are the identical
  assertion text at `expect(row?.status).toBe("suspended")`.
- Round 1, item 5, the first red block: `expected [ 'control.run.pending' ] to
  deeply equal [ 'control.run.cancelled' ]` is
  `test/CancelSettlement.test.ts:72:37`, not `69:37`. Line 68 is the
  `control.run.cancel-requested` assertion; line 72 is the one that failed.

## Smoke recipe re-run at the lane head, with a real seat

Real binary (`node --no-warnings packages/cli/src/bin.ts`), a temp project with
real `.flows/control.db` and `.flows/engine.db`, `jj git init --colocate` in
the project to contain the snapshot boundary (round 1 trap 2), and the same
`asker` flow the smoke used, on `openai:gpt-5.6-luna` through
`SMITHERS_OPENAI_AUTH=chatgpt`. This is smoke section 3 verbatim, the leg round
1 skipped for want of a seat.

```
$ smithers up asker -d --json
{"detached":true,"logFile":".../.flows/logs/run-1.log","runId":"run-1"}
```

19 s later the detached process is gone (`ps` shows no `bin.ts`), and the rows
read:

```
control.db flows_runs: [{"run_id":"run-1","status":"suspended"}]
engine.db  flows_runs: [{"run_id":"run-1","status":"suspended","waiting_reason":"approval","cancel_requested_at_ms":null}]
engine journal:        ... control.approval.requested, control.agent.permission-required,
                       control.agent.suspended, control.run.waiting-approval
```

No `flows.engine.interrupted {"outcome":"cancelled"}`: round 1's park fix
holding on the real binary. Then, each command a separate process:

```
$ smithers cancel run-1 --json
{"_tag":"Terminal","runId":"run-1","status":"cancelled"}                 exit 0, 2.4 s
control.db flows_runs: [{"run_id":"run-1","status":"cancelled"}]
engine.db  flows_runs: [{"run_id":"run-1","status":"suspended","waiting_reason":"approval","cancel_requested_at_ms":1788145848291}]

$ smithers ps --json
{"_tag":"runs","items":[{"runId":"run-1","flowId":"asker","status":"cancelled",...}]}

$ smithers approve '<the ask payload>' --json
{"_tag":"Terminal","runId":"run-1","status":"cancelled"}                 exit 0, 2.6 s

$ smithers run run-1 --resume --json
{"_tag":"Terminal","runId":"run-1","status":"cancelled"}                 exit 0, 2.6 s

$ smithers cancel run-1 --json
{"_tag":"Terminal","runId":"run-1","status":"cancelled"}                 exit 0
$ smithers down --json
{"cancelled":[]}                                                         exit 0
```

The smoke's own numbers for the same three commands were `Accepted` with the
row left parked, `exit 124` after 120 s with empty stdout and stderr, and no
output at all.

Attribution, after four cancel/down asks plus an approve and a resume:

```
control.run.* for run-1:
["control.run.accepted","control.run.running","control.run.cancel-requested","control.run.cancelled","control.run.waiting-approval"]
```

One `control.run.cancel-requested`, one `control.run.cancelled`. The smoke had
four of the first and none of the second.

The engine row, and the bound on it:

```
before serve: engine.db [{"run_id":"run-1","status":"suspended","cancel_requested_at_ms":1788145848291}]
$ smithers serve --host 127.0.0.1 --port 7391      (killed after 20 s)
during serve: engine.db [{"run_id":"run-1","status":"cancelled","waiting_reason":null,"cancel_requested_at_ms":1788145848291}]

$ smithers gc --older-than 0s --dry-run --json
[{"db":"control.db","runs":["run-1"]},{"db":"engine.db","runs":["run-1"]}]
```

Both `flows_runs` tables read `cancelled` and both databases collect the run.
The smoke's `gc` skipped it in both.

A second recipe with no seat at all, on the "accepted with nothing running" run
round 1 used, pins the resume half by itself:

```
$ smithers run run-1 --resume --json     # run still accepted: the resume records its receipt
$ smithers cancel run-1 --json           -> {"_tag":"Terminal","runId":"run-1","status":"cancelled"}
$ smithers run run-1 --resume --json     -> {"_tag":"Terminal","runId":"run-1","status":"cancelled"}   exit 0
$ smithers resume run-1 --json           -> {"_tag":"Terminal","runId":"run-1","status":"cancelled"}   exit 0
$ smithers cancel run-1 --json           -> {"_tag":"Terminal","runId":"run-1","status":"cancelled"}
$ smithers down --json                   -> {"cancelled":[]}
$ smithers ps --json                     -> run-1 cancelled
$ smithers gc --older-than 0s --dry-run  -> control.db runs ["run-1"]
control.run.* : ["control.run.accepted","control.run.pending","control.run.resume",
                 "control.run.cancel-requested","control.run.cancelled"]
```

Pre-fix the third line answered `{"_tag":"AlreadyApplied","receiptId":"cli:resume:run-1"}`.

## Gates

Machine load is the one-minute average printed by `uptime` immediately before
each command. Exit codes were read from the command itself, not from a pipe.

```
load  6.49  pnpm run check                                            exit 0
load  7.49  pnpm run lint                                             exit 0
load  6.55  pnpm run circular                                         exit 0
load  6.70  packages/control      vitest run   27 files,  229 tests, 0 failed
load  7.52  packages/agent        vitest run   28 files,  422 tests, 0 failed
load  6.61  packages/cli          vitest run   36 files,  606 tests, 0 failed
load  7.40  packages/engine-store vitest run   99 files,  796 tests, 0 failed
load  6.73  packages/flows        vitest run   12 files,  403 tests, 0 failed
load  6.45  packages/gateway      vitest run    9 files,   85 tests, 0 failed
load  6.45  packages/registry     vitest run   15 files,  319 tests, 0 failed
load  7.77  packages/std          vitest run   24 files,  283 tests, 0 failed
load  9.63  packages/triggers     vitest run    8 files,   37 tests, 0 failed
load  9.63  packages/time-travel  vitest run   34 files,  312 tests, 0 failed
load  6.56  packages/migrate      vitest run   28 files,  374 tests, 6 skipped, 0 failed
load  6.85  packages/harness      vitest run   33 files, 1043 tests, 1 skipped, 0 failed
load  9.18  packages/testing      vitest run   18 files,  123 tests, 2 skipped, 0 failed
load  9.18  packages/evals        vitest run    6 files,   20 tests, 0 failed
load  8.77  packages/chain        vitest run   20 files,  206 tests, 0 failed
load  8.77  packages/mcp          vitest run    5 files,   33 tests, 0 failed
load  ~18   pnpm run test:jsdoc                                       5 pass, 0 fail
```

Every load reading was below the 40 guard, so every suite ran with default
workers. No suite needed an isolated re-run.

Dependents of `@smthrs/{agent,control}` in the workspace: `cli`, `create-app`,
`flows`, `gateway`, `integrations`, `migrate`, `registry`, `std`,
`time-travel`, `triggers`. `integrations` and `create-app` were not run:
`integrations` needs live GitHub and Linear credentials and `create-app`
scaffolds against the network.

Neither `pnpm-lock.yaml` nor `bun.lock` changed. No manifest changed. The
install was one `corepack pnpm install --frozen-lockfile --offline`, exit 0.

## Commits

```
7cea521cbf fix(control,agent): a cancel finishes the run nobody is driving
c186ef53ec fix(control): a resume and a decision answer from the run, never from their own receipt
a73c846f5e fix(control): type the settled decision receipt instead of asserting it
```

`7cea521cbf` is green on its own: the production-composition case's approve
assertion arrives with `c186ef53ec`, which is the commit that makes it true.

## Residual

1. A bare `smithers cancel` leaves the ENGINE row `suspended` with its durable
   `cancel_requested_at_ms` until an engine composition runs long enough to
   sweep it. The sweep ticks every `Ownership.heartbeatInterval` (1 s) in every
   process that opens `engine.db`, so `smithers serve`, the gateway, or the
   next `smithers up` finishes it — measured above. The cancelling CLI exits
   before its own first tick. Delivering it inside the cancel is not a matter
   of calling the engine from `ControlExecutor.requestCancel`: that port runs
   INSIDE the control mutation's write transaction on purpose (rc-contract
   B-11), and re-driving an execution there would wait on the writer the
   transaction holds — the same reason `takeUpResume` runs outside it. It needs
   a post-mutation port method, which is a public-surface addition rather than
   a fix.
2. `AgentSession.preserveDriverInterrupt` is still exported, documented, and
   unit-tested with no caller in `src` (round 1 residual 2, unchanged).
3. `AgentSession.hostsPark` still times out `Ownership.heartbeatStaleAfter`
   before a composition that did not park a run adopts its delegation, rather
   than asking whether the parking pid is alive (round 1 residual 3, unchanged).
4. The detached-process exit measurement from round 1 residual 4 is now partly
   covered: the real-binary run above confirms the detached `smithers up -d`
   process exits at the park on its own. A detached process still RUNNING when
   its run is cancelled elsewhere was not re-measured against a real pid; the
   event it waits for is pinned twice in tests.

---

# Round 3

Branch `phase7/engine-park`, same worktree, based on the round 2 head
`a73c846f5e`. Three commits: `6644bfb1e6`, `51b3580e11`, `d039eeac90`.

Verdict: the major finding is closed and one of the three minors is closed,
each with a recorded red run and a green one. Findings 3 and 4 are NOT fixed.
Both were driven to the point where the blocker is a measured fact rather than
a guess, the attempted fix for finding 3 was written and then reverted because
it regressed three `packages/cli` gate assertions, and the evidence for the
next round is below.

## Finding 1 (major) — the package gates of two owned packages were red

Confirmed by running them. `packages/agent` at `a73c846f5e`, shipped config:

```
Test Files  28 passed (28)
     Tests  422 passed (422)
AgentSession.ts   |     100 |    99.32 |     100 |     100 | 983
ERROR: Coverage for branches (99.82%) does not meet global threshold (100%)
                                                                    exit 1
```

`packages/engine-store` at the same commit:

```
Test Files  99 passed (99)
     Tests  796 passed (796)
RunDriver.ts     |   98.82 |    97.63 |   99.14 |   98.94 | 1112-1118
ERROR: Coverage for lines (99.84%) does not meet global threshold (100%)
ERROR: Coverage for functions (99.89%) does not meet global threshold (100%)
ERROR: Coverage for statements (99.82%) does not meet global threshold (100%)
ERROR: Coverage for branches (99.59%) does not meet global threshold (100%)
                                                                    exit 1
```

Logs: `scratchpad/r3-agent-red.log`, `scratchpad/r3-engine-store-red.log`.

### AgentSession.ts:983 — the branch is gone, and it was hiding a race

`AgentSession.ts` at `a73c846f5e`, the ask gate:

```ts
        const instance = activeInstances.get(runId)
        if (instance !== undefined) {
```

and the registered handler that fills the map:

```ts
        const fiber = yield* Effect.forkChild(
          body(payload).pipe(...),
          { startImmediately: true }
        )
        activeBodies.set(payload.runId, fiber)
        activeInstances.set(payload.runId, instance)
```

The map is written AFTER the body is forked with `startImmediately: true`, so
an ask that reaches the gate before the write finds no instance, declares
nothing, and the run parks under the derived `event` reason instead of
`approval` — the exact defect round 1 fixed for the ordinary case.

Fix: `packages/agent/src/AgentSession.ts`. `body` takes the flow instance the
registered handler already read, `authorize(runId, instance)` takes it from
`body`, and `activeInstances` is deleted with the branch. The instance can no
longer be missing, so the classification cannot be lost to fork ordering.

### RunDriver.ts:1112-1118 — the interrupted park now has cases of its own

New file: `packages/engine-store/test/InterruptedSuspensionPark.test.ts`.
Three cases over the production `EngineStore` composition, whose scope closes
between the suspension and the read the way a process exit closes it:

- `keeps the approval the flow declared, with its wake token`
- `derives 'timer' and the earliest deadline from an undeclared clock wait`
- `falls back to 'event' when the flow declared nothing and armed no clock`

Each asserts the parked reason, the sweep that must see it, and the recorded
`Suspended` result on the row. The round's body forks its wait under the
registered handler, which is the shape `AgentSession` uses, so the suspension
lands on the shared instance while the handler is still inside the round.

Red, with `packages/engine-store/src/internal/RunDriver.ts` restored to the
lane's base `9c464343f0`:

```
AssertionError: expected 'released' to be 'approval' // Object.is equality
AssertionError: expected 'released' to be 'timer' // Object.is equality
AssertionError: expected 'released' to be 'event' // Object.is equality
 ❯ test/InterruptedSuspensionPark.test.ts
```

Green at the lane head, and both package gates exit 0:

```
packages/agent        vitest run   28 files,  422 tests            exit 0
packages/engine-store vitest run  100 files,  799 tests            exit 0
```

## Finding 2 (minor) — a cancel settles the park it just recorded

Confirmed at the source. `RunDriver.ts:1944-1965` forks the parked-run sweep
into the driver's scope on a `Ownership.heartbeatInterval` tick, so the row IS
finalized by any engine that lives a second past the request — and a `smithers
cancel` writes the request in its last hundreds of milliseconds and exits
first. Nothing else drives a parked run, because a park has no owner.

Test: `packages/agent/test/EngineParkAcrossProcesses.test.ts` — `a run parked
on an in-run ask that a later process cancels > settles both rows and answers
the ask with the run's terminal status`, whose engine-row read is now taken
the instant `control.cancel` returns instead of polled for thirty seconds.

Red, against `6644bfb1e6`:

```
AssertionError: expected 'suspended' to be 'cancelled' // Object.is equality
 ❯ test/EngineParkAcrossProcesses.test.ts (settles both rows …)
```

Fix, in three parts:

- `packages/control/src/ControlExecutor.ts` — new port method
  `settleCancelledPark(input)`, with `makeNoop` answering `Effect.void`.
- `packages/agent/src/AgentSession.ts` — implements it: if this engine
  publishes the run as parked, drive it once. The engine's re-activation cancel
  guard closes a run with a recorded cancellation without entering the flow
  body, which is what makes this safe to do to an agent run
  (`InterruptReleaseReclaim.test.ts`, `bodyRuns` 0).
- `packages/control/src/ControlLive.ts` — `cancel` calls it on the way out of
  `mutate`, not inside it.

The last part is not a style choice, and the first attempt got it wrong: the
call started inside `executorRequestCancel`, which `ControlLive` runs inside
the mutation's write transaction on purpose. Driving a run re-enters the
engine, whose writes then wait on the writer that transaction holds, and the
cancel deadlocked:

```
Error: Test timed out in 180000ms.
 ❯ test/EngineParkAcrossProcesses.test.ts:541:3
```

`takeUpResume`'s own doc comment already names this hazard; the fix follows it.

A shared `parkedHere(runId, attempts)` replaced the two copies of
`awaitParked(...).pipe(Effect.catchCause(() => Effect.succeed(false)))`, which
is also what keeps `packages/agent` at 100% functions: a second copy of that
handler is a second function no test invokes.

## Finding 3 (minor) — NOT fixed, and here is what it costs to fix

The claim is right and the mechanism is right. It was implemented, measured,
and reverted, because the first step it requires regresses the shipped CLI.

Measured at the lane head, real binary, a temp project with no model seat:

```
$ smithers up hello -d --json
{"detached":true,"logFile":".../.flows/logs/run-1.log","runId":"run-1"}
control.db run-1  status=running
          ownerId={"hostId":"local","pid":0,"nonce":"3f62b294-…"}
          parkedBy=undefined
engine.db  []
```

`pid: 0` is `SqlControlRuntime.make_`'s default identity, and `NodeControl`
passes no `owner`. Two consequences, and the second one is why this is not a
drive-by fix:

1. The park fence names no process, so `Ownership.sameHostPidProbe` cannot be
   asked about it. That is the verifier's finding.
2. `sameProcess` compares `hostId` and `pid` only, so EVERY `smithers` process
   on one machine is the same process to `ownedByUs`. That is what makes the
   `cancel` above answer `Terminal`: the cancelling process believes it owns a
   row a detached process claimed and abandoned.

The attempted fix was: `SqlControlRuntime.Options.isAlive`, a projection that
drops `parkedBy` (and `ownerId`) when the identity names a dead process on
this host, `NodeControl` supplying `{ hostId: "flows-cli", pid: process.pid }`
plus `Ownership.sameHostPidProbe`, and `ControlLive.cancel` reading
`live(status) && ownerId !== undefined`. It works at the composition level —
the pin was `packages/agent/test/EngineParkAcrossProcesses.test.ts` `adopts the
park at once when the parking process is gone from this machine`, which went
from

```
AssertionError: expected 30133 to be less than 20000
```

to about two seconds. Five `packages/control` cases covered the projection's
readings.

It also turned three `packages/cli` gate assertions red:

```
FAIL  test/EndToEnd.test.ts > one project, from init to gc > cancels the run durably
AssertionError: expected { _tag: 'Accepted', …(2) } to match object { _tag: 'Terminal', …(2) }
 ❯ test/EndToEnd.test.ts:228:35

FAIL  test/EndToEnd.test.ts > one project, from init to gc > takes every remaining run down
AssertionError: expected 'accepted' to be 'cancelled' // Object.is equality
 ❯ test/EndToEnd.test.ts:242:75

FAIL  test/EndToEnd.test.ts > one project, from init to gc > reports what gc would delete, then deletes it
AssertionError: expected [] to include 'run-1'
 ❯ test/EndToEnd.test.ts:256:26
```

The reason is a real gap, not a test artifact. With honest identities, a run
whose control row is `running`/`accepted` under a dead process's fence is
nobody's: `ControlRuntime.resume` refuses it (`SqlControlRuntime.ts:1338-1340`,
"a run owned by a live peer is theirs to drive" — it never asks whether the
peer is live), so `Control.cancel` has no path to finish it and answers
`Accepted` forever. Today the pid-0 identity hides that, and `cancel`, `down`
and `gc` depend on the hiding.

The whole fix is therefore three steps, in this order, and it is a lane of its
own rather than a round-3 minor:

1. `ControlRuntime.resume` claims a `running` row whose owner this host can
   prove is dead, through `RunStore`'s steal path rather than `claimAndOwn`.
2. `SqlControlRuntime` takes a liveness probe and stops reading a dead
   process's `ownerId`/`parkedBy` as a host.
3. `NodeControl` gives the control plane the engine's host name and this
   process's pid.

Only after step 3 does `AgentSession.hostsPark` have a pid to probe, which is
the 51-second `smithers approve` the verifier measured.

## Finding 4 (minor) — NOT fixed: a package gate cannot serve a model

The ask is a `packages/cli/test/EndToEnd.test.ts` case that runs `up <flow> -d`
"with the test seat", waits for the detached pid to exit, and reads
`.flows/engine.db`. There is no test seat, and one cannot be built inside the
package gate:

- Every `smithers up` is an agent run. `AgentSession.body` resolves a seat,
  loads the descriptor's prompt, and calls `agent.run`; a project `flow.ts`
  only names what it delegates to, and `packages/cli` registers no delegate
  that runs without the agent (no `Executable.layer` in `packages/cli/src`).
- `NodeControl.seatResolver` hard-codes each provider's origin
  (`Route.anthropic`, `Route.openai`, `OpenAICompatible` for OpenRouter) and
  reads only `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` and
  `SMITHERS_OPENAI_AUTH`. There is no base-URL or transport override, so a test
  cannot point a seat at a local HTTP server.
- Without a seat there is no engine row at all to assert on. Measured above:
  `up hello -d` with the keys unset leaves `engine.db` `flows_runs` EMPTY and
  the control row `running`/`accepted`. `packages/cli/test/CrossProcessCancel.test.ts`
  seeds an engine row by hand (`seedParkedExecution`) for exactly this reason.

So the case the verifier asks for needs one of: a documented model base-URL
override (a public surface change with a docs page, outside this lane's owned
paths), or an e2e lane that may spend a real seat. The park-at-exit race stays
pinned by `packages/agent/test/EngineParkAcrossProcesses.test.ts` in the
production composition, and by round 2's real-binary transcript.

## Gates

Machine load is the one-minute average from `uptime` immediately before each
command. Exit codes were read from the command, not from a pipe.

```
load  4.90  pnpm run check                                            exit 0
load  4.38  pnpm run lint                                             exit 0
load  4.94  pnpm run circular                                         exit 0
load  4.90  pnpm run test:jsdoc                                       exit 0, fail 0
load  6.72  packages/agent        vitest run   28 files,  422 tests   exit 0
load  4.56  packages/engine-store vitest run  100 files,  799 tests   exit 0
load  3.69  packages/control      vitest run   27 files,  229 tests   exit 0
load  7.68  packages/cli          vitest run   36 files,  606 tests   exit 0
load  4.52  packages/flows        vitest run   12 files,  403 tests   exit 0
load  4.37  packages/gateway      vitest run    9 files,   85 tests   exit 0
load  4.37  packages/registry     vitest run   15 files,  319 tests   exit 0
load  4.37  packages/std          vitest run   24 files,  283 tests   exit 0
load  5.94  packages/triggers     vitest run    8 files,   37 tests   exit 0
load  5.79  packages/time-travel  vitest run   34 files,  312 tests   exit 0
load  5.08  packages/migrate      vitest run   28 files,  374 tests   exit 0
load  5.99  packages/harness      vitest run   33 files, 1043 tests   exit 0
load  5.83  packages/testing      vitest run   18 files,  123 tests   exit 0
```

Every reading was far below the 40 guard, so every suite ran with default
workers and none needed an isolated re-run. `integrations` and `create-app`
were not run, for round 1's reasons: live GitHub and Linear credentials, and
network scaffolding.

Neither `pnpm-lock.yaml` nor `bun.lock` changed. No manifest changed. The
install was one `corepack pnpm install --frozen-lockfile --offline`, exit 0.

## Commits

```
6644bfb1e6 fix(agent,engine-store): the ask gate's instance travels by argument, and the interrupted park is covered
51b3580e11 fix(control,agent): a cancel settles the park it just recorded
d039eeac90 chore(agent,engine-store): format the ask gate and type the interrupted-park harness
```

## For the orchestrator

1. Findings 3 and 4 are open. Finding 3 needs the three-step lane above and
   touches `packages/control` and `packages/cli/src/NodeControl.ts`; the
   `packages/cli` EndToEnd assertions it moves are quoted verbatim, so the
   lane that takes it can start from a known red.
2. Finding 4 needs a model transport seam or a credentialed e2e lane. Neither
   is inside this lane's owned paths.
3. Round 2's residual is closed by finding 2's fix: `smithers cancel` on a
   parked run now settles the engine row inside the call, so `gc` collects the
   run in both databases with no later engine process involved. The real-binary
   leg of that was not re-measured this round for want of a model seat.
