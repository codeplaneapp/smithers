# `smithers why <run-id>` — explain blockage

## Revision Summary

- Narrowed the plan to a CLI-first diagnosis engine, with GUI/TUI banners as
  follow-on consumers.
- Expanded the blocker taxonomy so approvals, event waits, timers, retries, stale
  heartbeats, and dependency failures are all first-class cases.
- Added explicit CTA-generation requirements so every blocker type maps to a concrete
  operator action.
- Added missing work for metadata-driven diagnoses of `WaitForEvent`/Signal/Timer
  nodes.

## Problem

When a run is stuck (`waiting-approval`, `waiting-event`, or silently hung), operators
have to manually piece together what's wrong by combining `inspect`, `logs`, `node`,
and `sql` queries. There's no single command that answers: *what is blocked, why, and
what do I do about it?*

## Proposal

Add a `smithers why <run-id>` command that computes a blockage diagnosis:

```
$ smithers why abc123

Run abc123 is waiting-approval

  Blocked node:  review-gate (iteration 0)
  Waiting since: 12m ago
  Reason:        Approval requested — no decision yet
  Unblock:       smithers approve abc123

  Previous attempt failed (attempt 2 of 3):
    SchemaValidationError: output.score must be >= 0
    Retrying automatically in 4s
```

### What to compute

For any non-`running`, non-`finished` run:

1. **What is waiting** — the specific node(s) in a blocking state
2. **Why it is waiting** — approval pending, event pending, all retries exhausted,
   schema validation loop, upstream failure, stale heartbeat
3. **Who/what can unblock it** — the exact CLI command or API call
4. **Context** — last error, retry count, time waiting, relevant events

### Surfaces

- **CLI:** `smithers why <run-id>` (human-readable default, `--json` for machines)
- **GUI:** follow-on banner on run detail page with inline action buttons
- **TUI:** follow-on status line or right panel on run detail view

## Additional Steps

1. Build a reusable diagnosis helper that takes run/nodes/attempts/events and returns
   structured blockers plus suggested actions.
2. Classify at least these cases: waiting approval, waiting external event/signal,
   waiting timer, retry backoff, exhausted retries, stale heartbeat, upstream
   dependency failure, cancelled run, healthy running run.
3. Generate exact unblock commands for each case instead of generic prose.
4. Read blocker metadata from node/task descriptors so event and timer diagnoses can
   name the signal/event/timer precisely.
5. Add multiple-blocker support for parallel branches.
6. Keep GUI/TUI integration out of the first implementation; have them consume the
   CLI/diagnosis helper later.

## Implementation notes

- Query `_smithers_runs` for status, `_smithers_nodes` for blocking nodes,
  `_smithers_approvals` for pending decisions, `_smithers_attempts` for last error,
  `_smithers_events` for recent timeline context
- Use heartbeat staleness to detect orphaned "running" runs
- Return suggested CTA commands (approve, deny, resume, cancel, retry)

## Verification requirements

### E2E tests

1. **Waiting-approval diagnosis** — Run a workflow that hits an `<Approval>`. Run
   `smithers why <id>`. Assert output contains: blocked node ID, "Approval requested",
   time waiting, and `smithers approve <id>` as the unblock command.

2. **Waiting-signal diagnosis** — Run a workflow that hits a `<Signal>`. Assert `why`
   reports: signal name, "waiting for signal", and the exact `smithers signal ...`
   command.

3. **Waiting-timer diagnosis** — Run a workflow with `<Timer duration="1h" />`. Assert
   `why` reports: timer ID, "waiting for timer", fires-at time, and time remaining.

4. **Failed run diagnosis** — Run a workflow that fails after exhausting retries.
   Assert `why` reports: failed node, last error message, attempt count, and suggests
   `smithers resume <id>`.

5. **Stale heartbeat diagnosis** — Start a workflow, kill the process. Run `why`. Assert
   it reports: "Run appears orphaned (last heartbeat Ns ago)", suggests
   `smithers resume <id> --force`.

6. **Finished run** — `smithers why <id>` on a finished run. Assert "Run is finished,
   nothing is blocked."

7. **Running (healthy) run** — `smithers why <id>` on an actively running, healthy
   workflow. Assert "Run is executing normally. Currently on node X."

8. **Multiple blockers** — Parallel branches: one waiting approval, one waiting signal.
   Assert `why` lists BOTH blockers with individual unblock commands.

9. **--json output** — `smithers why <id> --json`. Assert valid JSON with structured
   fields: `status`, `blockers[]`, each with `nodeId`, `reason`, `unblocker`,
   `waitingSince`.

10. **Non-existent run** — `smithers why bad-id`. Assert exit code 4, "Run not found".

### Corner cases

11. **Schema validation retry loop** — Task has failed 2 of 3 validation retries. `why`
    should report the schema error and "retrying automatically".

12. **Cancelled run** — `why` on a cancelled run reports "Run was cancelled at <time>"
    not "nothing is blocked".

13. **Run with 100 nodes** — Performance: `why` should complete in <200ms even with
    many nodes/attempts.

14. **Node waiting on upstream failure** — Node B depends on Node A which failed. `why`
    should report "Node B is blocked because dependency A failed."

## Observability

### Logging
- `Effect.withLogSpan("why:diagnose")`
- Annotate with `{ runId, status, blockerCount }`
- No new events or metrics needed — `why` is a read-only query command

## Codebase context

### Smithers files
- `src/cli/index.ts:1937-2028` — `inspect` command: `why` queries the same tables but
  computes a diagnosis instead of dumping raw state. Start by copying inspect's DB
  queries and adding logic.
- `src/cli/index.ts:1358` — `ps` command: `why` reuses the run lookup pattern.
- `src/engine/index.ts:758-768` — `isRunHeartbeatFresh()`: use this to detect orphaned
  runs in the `why` diagnosis.
- `src/db/adapter.ts` — `getRun()`, `listNodes()`, `listPendingApprovals()`,
  `listRalph()`: all the queries `why` needs.
- `src/cli/format.ts:46-91` — `formatEventLine()`: reference for colorized CLI output
  formatting.
- `src/engine/scheduler.ts:269-430` — `scheduleTasks()`: the scheduler already
  computes `waitingApprovalExists`, `pendingExists`, `nextRetryAtMs`. The `why`
  command needs similar logic but for human-readable diagnosis.

## Effect.ts architecture

### Boundary rule

All internal code MUST stay in Effect. Never call `runPromise()` or `runSync()` inside
internal modules. The only places allowed to break out of Effect into promises are:

- **CLI command handlers** — the outermost `run(c)` function in `src/cli/index.ts`
- **HTTP route handlers** — the outermost handler in `src/server/index.ts`
- **JSX component boundaries** — React/Solid components that call into Effect services
- **Test entry points** — `Effect.runPromise` in test files

Everything else — DB queries, engine logic, transport calls, validation, metrics,
logging — must compose as `Effect<A, E, R>` and flow through the Effect pipeline.
Do not wrap Effect code in `runPromise()` to get a Promise, then re-wrap that Promise
in `Effect.tryPromise()`. Keep the Effect chain unbroken.

**Rule:** ALL internal code must use Effect.ts. Only user-facing API boundaries (JSX components, React GUI) are exempt.

### Packages

- **`effect`** core — `Effect.gen`, `Effect.all`, `Effect.map`, `Effect.annotateLogs`, `Effect.withLogSpan`

No `@effect/workflow` or `@effect/cluster` needed — this is a read-only diagnosis pipeline using Effect core.

### Key mapping

The diagnosis computation should be an Effect pipeline: query runs, query nodes, query approvals, query attempts, then compute diagnosis. Use `Effect.all` for parallel queries and return a structured `Diagnosis` type:

```typescript
import { Effect, Schema } from "effect"

// Structured diagnosis type
const Blocker = Schema.Struct({
  nodeId: Schema.String,
  reason: Schema.String,
  waitingSince: Schema.Number,
  unblocker: Schema.String,  // e.g., "smithers approve abc123"
  context: Schema.optional(Schema.String),
})

const Diagnosis = Schema.Struct({
  runId: Schema.String,
  status: Schema.String,
  blockers: Schema.Array(Blocker),
})

// Diagnosis pipeline using Effect.all for parallel queries
const diagnoseRun = (runId: string): Effect.Effect<Diagnosis, DiagnosisError> =>
  Effect.gen(function*() {
    yield* Effect.annotateLogs({ runId })
    yield* Effect.withLogSpan("why:diagnose")(
      Effect.gen(function*() {
        // Parallel queries for all needed data
        const [run, nodes, approvals, attempts, recentEvents] = yield* Effect.all([
          queryRun(runId),
          queryNodes(runId),
          queryPendingApprovals(runId),
          queryLatestAttempts(runId),
          queryRecentEvents(runId, { limit: 50 }),
        ])

        // Compute blockers from the aggregated data
        const blockers = yield* Effect.gen(function*() {
          const result: Blocker[] = []

          // Check for waiting-approval nodes
          for (const approval of approvals) {
            result.push({
              nodeId: approval.nodeId,
              reason: "Approval requested — no decision yet",
              waitingSince: approval.requestedAtMs,
              unblocker: `smithers approve ${runId}`,
            })
          }

          // Check for waiting-event/signal nodes
          for (const node of nodes.filter(n => n.state === "waiting-event")) {
            result.push({
              nodeId: node.id,
              reason: `Waiting for signal '${node.signalName}'`,
              waitingSince: node.updatedAtMs,
              unblocker: `smithers signal ${runId} ${node.signalName} --data '{}'`,
            })
          }

          // Check for waiting-timer nodes
          for (const node of nodes.filter(n => n.state === "waiting-timer")) {
            result.push({
              nodeId: node.id,
              reason: `Waiting for timer '${node.timerId}', fires in ${formatDuration(node.firesAtMs - Date.now())}`,
              waitingSince: node.updatedAtMs,
              unblocker: "(timer fires automatically)",
            })
          }

          // Check for stale heartbeat (orphaned run)
          if (run.status === "running" && !isRunHeartbeatFresh(run)) {
            result.push({
              nodeId: "(run-level)",
              reason: `Run appears orphaned (last heartbeat ${formatDuration(Date.now() - run.heartbeatAtMs)} ago)`,
              waitingSince: run.heartbeatAtMs,
              unblocker: `smithers resume ${runId} --force`,
            })
          }

          // Check for exhausted retries
          for (const attempt of attempts.filter(a => a.state === "failed")) {
            const node = nodes.find(n => n.id === attempt.nodeId)
            if (node?.state === "failed") {
              result.push({
                nodeId: node.id,
                reason: `All retries exhausted. Last error: ${attempt.error}`,
                waitingSince: attempt.finishedAtMs,
                unblocker: `smithers resume ${runId}`,
                context: `Attempt ${attempt.number} of ${attempt.maxRetries}`,
              })
            }
          }

          return result
        })

        yield* Effect.annotateLogs({ blockerCount: blockers.length })
        return { runId, status: run.status, blockers }
      })
    )
  })
```

### Effect patterns to apply

- `Effect.all([...queries])` for parallel data fetching (runs + nodes + approvals + attempts + events in one shot)
- `Effect.map` to combine and transform query results into the structured `Diagnosis` type
- `Effect.withLogSpan("why:diagnose")` wrapping the entire diagnosis computation
- `Effect.annotateLogs({ runId, status, blockerCount })` for observability
- Pure computation after the queries — no DB writes, no side effects

### Smithers Effect patterns to follow

- `src/effect/runtime.ts` — Use the custom runtime layer for diagnosis execution
- `src/effect/logging.ts` — Annotate with `{ runId, status, blockerCount }`
- Follow the existing `Effect.gen` + `Effect.annotateLogs` + `Effect.withLogSpan` patterns used throughout the engine
- `src/effect/interop.ts` — Use `fromPromise()` to bridge existing adapter query methods into Effect

### Reference files

- No `@effect/workflow` or `@effect/cluster` reference needed for this ticket
- Follow the patterns in `src/effect/runtime.ts` for Effect execution context
- Follow the patterns in `src/db/adapter.ts` for the query methods to wrap in Effect
