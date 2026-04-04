# Automatic resume on crash (supervisor)

## Revision Summary

- Decoupled the supervisor loop from a nonexistent standalone `smithers serve`
  command.
- Added a claim/idempotency requirement so two supervisors cannot resume the same
  run at once.
- Split durable timer wakeups into a follow-on integration instead of a hard
  day-one dependency.
- Added a phased entrypoint plan: `smithers supervise` first, then reuse the same
  loop from any future server mode.

## Problem

If a Smithers process dies, workflows are stuck in "running" with a stale heartbeat
until someone manually calls `smithers resume`. There's no automatic failover. The
heartbeat staleness detection exists (5s threshold), but nothing acts on it.

Temporal handles this automatically: if a shard owner dies, another node acquires the
lease and resumes all workflows. Smithers doesn't need multi-node consensus, but it
does need a process that watches for orphaned runs and restarts them.

## Proposal

Add a supervisor loop that monitors and auto-resumes orphaned runs.

### Entrypoints

- `smithers supervise`
- `smithers up <workflow> --serve --supervise` if the current run-serving mode needs
  to host the loop
- A future standalone `smithers serve --supervise` if the project later adds a
  dedicated multi-run server command

All entrypoints should call the same supervisor core.

### Poll loop

On each tick:

1. Query `_smithers_runs WHERE status = 'running' AND heartbeat_at_ms < now - 30000`
2. For each stale run:
   - Log: "Run abc123 has stale heartbeat (last seen 45s ago), resuming..."
   - Atomically claim the run for resume so other supervisors skip it
   - Call the same resume machinery as `smithers resume --run-id abc123 --force`
   - Spawn as detached process (same as `-d` mode)
3. Optionally, in a later phase, also check timer-blocked runs once the durable
   timers ticket lands

### Poll interval

- Default: 10s
- Configurable: `--supervise-interval 30s`
- Stale threshold: 30s (longer than the 5s detection threshold to avoid false
  positives from brief GC pauses)

### Safety

- Only resume runs whose workflow file still exists on disk
- Only resume if `runtimeOwnerId` doesn't match a currently-running process (check
  PID liveness)
- Only resume after a compare-and-set style claim succeeds; otherwise log and skip
- Rate-limit: max 3 concurrent resume attempts to avoid thundering herd
- Emit `RunAutoResumed` event for observability

## Additional Steps

1. Extract the stale-run detection loop into a reusable module rather than baking it
   into one CLI command.
2. Add a DB-level claim/update step so concurrent supervisors do not race the same
   run.
3. Reuse `resumeRunDetached()` for process spawning.
4. Add PID liveness helpers and a clear skip reason taxonomy.
5. Make timer wakeups a second poller plugged into the same supervisor core after
   durable timers exist.
6. Expose `--dry-run`, `--interval`, `--stale-threshold`, and
   `--max-concurrent`.
7. Add debug/info logging for empty polls and skipped runs.

### Standalone mode

Also works as a standalone watcher:

```
smithers supervise                    # watch + auto-resume, no HTTP server
smithers supervise --dry-run          # show what would be resumed, don't act
```

### Integration with existing cron

The cron scheduler already runs a poll loop. The supervisor can share that
infrastructure — it's another "check and act" loop alongside cron job dispatch.

## Verification requirements

### E2E tests

1. **Stale run is auto-resumed** — Start a workflow in detached mode, kill the process
   (SIGKILL). Start supervisor. Assert supervisor detects the stale heartbeat and
   resumes the run. Assert run completes successfully.

2. **Healthy run is NOT resumed** — Start a running workflow with fresh heartbeats.
   Start supervisor. Assert supervisor does NOT attempt to resume it.

3. **Timer-waiting run is resumed when timer fires** — Start a workflow that enters
   `waiting-timer` with a 1s timer. Start supervisor. Assert supervisor fires the
   timer and resumes the run after 1s.

4. **Rate limiting** — Kill 5 workflows simultaneously. Start supervisor with
   `--max-concurrent 3`. Assert only 3 are resumed initially. As those complete,
   remaining 2 are picked up.

5. **Missing workflow file** — Kill a workflow, then delete its `.tsx` file. Start
   supervisor. Assert it logs a warning but does NOT crash. Other stale runs still
   get resumed.

6. **PID liveness check** — Start a workflow, note its `runtimeOwnerId`. Without
   killing it, start supervisor. Assert supervisor checks PID is alive and skips the
   run.

7. **Dry-run mode** — `smithers supervise --dry-run`. Assert it prints which runs
   would be resumed but takes no action. Assert no `RunAutoResumed` events.

8. **Standalone vs hosted mode** — Assert `smithers supervise` and any hosted entry
   point that reuses the same supervisor core both detect and resume stale runs.

9. **Supervisor idempotency** — Two supervisors running concurrently. Assert they don't
   both try to resume the same run (the second should see the first's fresh heartbeat
   and skip).

### Corner cases

10. **Run with stale heartbeat but terminal status** — A run has status="failed" but
    stale heartbeat. Supervisor should NOT resume it.

11. **Run with fresh heartbeat but status="cancelled"** — Should NOT be resumed.

12. **Supervisor crash and restart** — Supervisor itself crashes. New supervisor picks
    up where old one left off (no orphaned supervisor state).

13. **DB locked by another process** — Supervisor can't read the DB. Should retry, not
    crash.

14. **Zero stale runs** — Supervisor polls and finds nothing. Should log at debug level,
    not warn/error.

### Performance

15. **Poll with 10,000 runs in DB** — Supervisor query should complete in <100ms.
    Test with a seeded DB.

## Observability

### New events
- `SupervisorStarted { pollIntervalMs, staleThresholdMs, timestampMs }`
- `SupervisorPollCompleted { staleCount, resumedCount, skippedCount, durationMs, timestampMs }`
- `RunAutoResumed { runId, lastHeartbeatAtMs, staleDurationMs, timestampMs }`
- `RunAutoResumeSkipped { runId, reason: "pid-alive"|"missing-workflow"|"rate-limited", timestampMs }`

### New metrics
- `smithers.supervisor.polls_total` (counter) — supervisor poll cycles
- `smithers.supervisor.stale_detected` (counter) — stale runs found
- `smithers.supervisor.resumed_total` (counter) — runs auto-resumed
- `smithers.supervisor.skipped_total` (counter, label: reason) — runs skipped
- `smithers.supervisor.poll_duration_ms` (histogram, fastBuckets) — poll cycle time
- `smithers.supervisor.resume_lag_ms` (histogram, durationBuckets) — time from
  heartbeat staleness to resume initiation

### Logging
- `Effect.withLogSpan("supervisor:poll")`, `Effect.withLogSpan("supervisor:resume")`
- Annotate with `{ runId, staleDurationMs, runtimeOwnerId }`
- Info-level: "Resuming stale run {runId} (last heartbeat {staleDurationMs}ms ago)"
- Warning: "Skipping run {runId}: workflow file not found at {path}"

## Codebase context

### Smithers files
- `src/cli/scheduler.ts:21-62` — **Primary reference**: the cron `tick()` poll loop.
  Supervisor is the same pattern: query DB, check conditions, spawn detached processes.
  Can be added as a second check inside this loop or as a parallel loop.
- `src/engine/index.ts:381-382` — `RUN_HEARTBEAT_MS = 1_000`,
  `RUN_HEARTBEAT_STALE_MS` — constants for staleness detection
- `src/engine/index.ts:758-768` — `isRunHeartbeatFresh()` function; supervisor uses
  the inverse of this
- `src/cli/index.ts:207` — `resumeRunDetached()` function: spawns
  `bun [cliPath] up <workflow> --resume --run-id <id> -d --force`. Supervisor calls
  exactly this.
- `src/cli/index.ts:1358` — `ps` command; supervisor query is essentially
  `ps --status running` + heartbeat filter

### Temporal reference
- `temporal-reference/service/history/shard/context_impl.go` — Shard acquisition
  and lease management. When a shard owner dies, another node acquires the shard via
  `range_id` bump. Smithers' analog is the PID liveness check + force resume.
- `temporal-reference/tests/acquire_shard_test.go:16-97` — Shard ownership tests
  with `LogRecorder` pattern: captures log messages, waits 5s for stabilization,
  checks for "acquire shard" messages
- `temporal-reference/tests/xdc/failover_test.go:119` —
  `TestSimpleWorkflowFailover`: starts workflow on cluster A, fails over to cluster B,
  polls and processes tasks on B. Validates continuation without interruption.

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

- **`@effect/cluster`** — `Sharding.registerSingleton()` ensures only one supervisor runs across a cluster
- **`effect`** core — `Effect.gen`, `Effect.repeat`, `Effect.acquireRelease`, `Effect.all`, `Schedule`, `Effect.annotateLogs`, `Effect.withLogSpan`

### Key mapping

The supervisor should be a `Schedule`-driven polling loop using `Effect.repeat`. Stale run detection is an Effect query pipeline. The claim/resume uses `Effect.acquireRelease` for the DB claim lock. The supervisor itself is registerable as a `Sharding.registerSingleton()` so only one supervisor runs across a cluster:

```typescript
import { Sharding } from "@effect/cluster"
import { Effect, Schedule } from "effect"

// Supervisor poll loop as an Effect.repeat with Schedule
const supervisorLoop = Effect.gen(function*() {
  yield* Effect.annotateLogs({ component: "supervisor" })
  yield* Effect.withLogSpan("supervisor:poll")(
    Effect.gen(function*() {
      // 1. Query for stale runs
      const staleRuns = yield* findStaleRuns({
        status: "running",
        heartbeatOlderThan: Date.now() - staleThresholdMs,
      })

      yield* Effect.annotateLogs({ staleCount: staleRuns.length })

      // 2. Claim and resume each stale run (with concurrency limit)
      const results = yield* Effect.all(
        staleRuns.map((run) => claimAndResume(run)),
        { concurrency: maxConcurrent }  // Rate-limit: max 3 concurrent
      )

      yield* Effect.logInfo(`Poll complete: ${results.length} resumed`)
    })
  )
}).pipe(
  Effect.repeat(Schedule.spaced(`${pollIntervalMs} millis`))
)
```

### Claim/resume with Effect.acquireRelease

```typescript
// Atomic claim so two supervisors cannot resume the same run
const claimAndResume = (run: StaleRun) =>
  Effect.gen(function*() {
    yield* Effect.annotateLogs({ runId: run.id, staleDurationMs: run.staleDuration })
    yield* Effect.withLogSpan("supervisor:resume")(
      Effect.acquireRelease(
        // Acquire: atomically claim the run via compare-and-set
        claimRunForResume(run.id, currentSupervisorId),
        // Release: unclaim on failure
        (claimed, exit) =>
          exit._tag === "Failure"
            ? unclaimRun(run.id)
            : Effect.void
      ).pipe(
        Effect.flatMap(() =>
          Effect.gen(function*() {
            // Safety checks
            yield* assertWorkflowFileExists(run.workflowPath)
            yield* assertPidNotAlive(run.runtimeOwnerId)
            // Resume
            yield* resumeRunDetached(run.id)
            yield* Effect.logInfo(`Resumed stale run ${run.id}`)
          })
        )
      )
    )
  })
```

### Cluster singleton registration

```typescript
import { Sharding } from "@effect/cluster"

// Register supervisor as a singleton — only one instance across the cluster
const registerSupervisor = Sharding.registerSingleton(
  "smithers-supervisor",
  supervisorLoop
)
// When a node dies, another node automatically picks up the singleton
```

### Stale run detection as Effect pipeline

```typescript
const findStaleRuns = (params: {
  status: string
  heartbeatOlderThan: number
}) =>
  Effect.gen(function*() {
    const runs = yield* queryRuns({
      where: {
        status: params.status,
        heartbeat_at_ms: { lt: params.heartbeatOlderThan },
      },
    })
    // Filter: only runs whose workflow file exists and PID is not alive
    return yield* Effect.filter(runs, (run) =>
      Effect.gen(function*() {
        const fileExists = yield* checkWorkflowFile(run.workflowPath)
        const pidAlive = yield* checkPidLiveness(run.runtimeOwnerId)
        return fileExists && !pidAlive
      })
    )
  })
```

### Effect patterns to apply

- `Effect.repeat` with `Schedule.spaced(pollIntervalMs)` for the poll loop (replaces `setInterval`)
- `Effect.all` with `{ concurrency: maxConcurrent }` for rate-limited parallel resume
- `Effect.acquireRelease` for the DB claim lock on each run
- `Effect.filter` for the safety-check pipeline (workflow file exists, PID not alive)
- `Sharding.registerSingleton()` to ensure only one supervisor across the cluster

### Smithers Effect patterns to follow

- `src/effect/runtime.ts` — Use the custom runtime layer for supervisor execution
- `src/effect/metrics.ts` — Wire supervisor metrics (`smithers.supervisor.polls_total`, `smithers.supervisor.resumed_total`, etc.) using existing histogram/counter helpers
- `src/effect/logging.ts` — Annotate supervisor spans with `{ runId, staleDurationMs, runtimeOwnerId }`
- `src/cli/scheduler.ts:21-62` — The cron `tick()` poll loop is the existing pattern to follow; the supervisor is the same shape but with `Effect.repeat` + `Schedule` instead of raw `setTimeout`
- `src/effect/child-process.ts` — `spawnCaptureEffect()` for the `resumeRunDetached()` process spawning

### Reference files

- `/Users/williamcory/effect-reference/packages/cluster/src/Sharding.ts` — `Sharding.registerSingleton()` for cluster-wide singleton supervisor
- `/Users/williamcory/effect-reference/packages/cluster/src/Entity.ts` — Entity patterns for distributed actors (context for how the supervisor interacts with cluster)
- `/Users/williamcory/effect-reference/packages/cluster/test/Entity.test.ts` — Entity and singleton usage examples
- `/Users/williamcory/effect-reference/packages/workflow/src/WorkflowEngine.ts` — Engine interface for resume operations
