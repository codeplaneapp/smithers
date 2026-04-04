# Transactional state writes

## Revision Summary

- Added a shared adapter-level transaction helper instead of repeating raw
  `BEGIN IMMEDIATE` snippets.
- Clarified that event/log emission stays outside the transaction boundary.
- Added a requirement to preserve node metadata during approval-path writes.
- Expanded the audit list so nested transactions, cancellation paths, and other write
  groups are not missed.

## Problem

Smithers writes state in independent SQLite operations: output table upsert, then
`_smithers_attempts` update, then `_smithers_nodes` update. Each write is individually
retried via `withSqliteWriteRetry`, but if the process crashes between writes, state
becomes inconsistent.

Example: crash after writing output but before updating `_smithers_attempts` →
attempt stuck in "in-progress" but output exists. The resume logic has heuristics to
detect this (check if output exists before re-executing), but it's best-effort.

Temporal prevents this with conditional writes: every persistence operation includes a
`range_id` lease token, and all state changes for a workflow task completion are
written atomically.

## Proposal

Wrap related state writes in SQLite transactions:

### Critical write groups

These sequences must be atomic (all-or-nothing):

1. **Task completion**: write output → update attempt → update node state
2. **Task start**: insert attempt → update node state
3. **Run completion**: update run status → finalize all nodes
4. **Approval decision**: update approval → update node state → update run status
5. **Frame commit**: write frame → write snapshot

### Implementation

SQLite supports `BEGIN IMMEDIATE ... COMMIT` which acquires a write lock upfront. Use
a `withTransaction` wrapper:

```ts
function withTransaction<T>(db: BunSQLiteDatabase, fn: () => T): T {
  db.run("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.run("COMMIT");
    return result;
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}
```

### Where to apply

In `src/engine/index.ts`, the task completion path (~line 2440-2480) currently does:
1. `upsertOutputRow(...)`
2. Update `_smithers_attempts` with finishedAtMs
3. Upsert `_smithers_nodes` with state="finished"

Wrap these in `withTransaction`. Same for task start, approval resolution, and frame
commit.

### What this does NOT require

- No schema changes
- No new tables
- No changes to the resume algorithm
- The existing `withSqliteWriteRetry` can wrap the entire transaction instead of
  individual writes

## Additional Steps

1. Add `withTransaction(fn)` to `SmithersDb` so engine code does not reach into the
   raw SQLite client directly.
2. Keep DB mutations inside the transaction body and emit events/logs only after the
   commit succeeds.
3. Decide on savepoint behavior for nested transactions and fail fast if nesting is
   unsupported.
4. Audit approval updates carefully: preserve `outputTable`, `label`, and other node
   metadata instead of overwriting rows with blanks.
5. Audit adjacent write groups not listed originally, including cancel/down and any
   future supervisor claim/resume mutations.
6. Reuse the existing event-seq transaction pattern as a reference implementation
   rather than inventing another raw-client style.

### Risk

SQLite transactions hold a write lock. If a transaction takes too long, other writers
block. Keep transactions tight — only the critical write group, no I/O or computation
inside the transaction boundary.

## Verification requirements

### E2E tests

1. **Task completion is atomic** — Run a workflow. After completion, assert
   `_smithers_nodes.state`, `_smithers_attempts.state`, and the output table row are
   ALL consistent. Read all three in a single query and verify.

2. **Task start is atomic** — Start a multi-node workflow. Pause mid-execution. Assert
   `_smithers_attempts` has state="in-progress" AND `_smithers_nodes` has
   state="in-progress" for the same node. No half-state.

3. **Approval is atomic** — Approve a waiting node. Assert `_smithers_approvals`,
   `_smithers_nodes`, and `_smithers_runs` all update in the same logical instant.
   Verify by reading all three after approval — no intermediate state visible.

4. **Frame commit is atomic** — Assert `_smithers_frames` and `_smithers_snapshots`
   for the same `frameNo` are either both present or both absent. Never one without
   the other.

5. **Simulated crash between writes (regression)** — Mock `adapter.insertNode()` to
   throw after `upsertOutputRow()` succeeds. Assert that on resume, the output is NOT
   present (rolled back), and the node re-executes cleanly.

6. **Concurrent task completions** — Run a `<Parallel>` workflow with 4 tasks. All 4
   complete near-simultaneously. Assert no SQLITE_BUSY errors propagate to the user
   and all 4 nodes reach "finished".

7. **Transaction rollback on error** — If output validation fails inside the
   transaction, assert NO partial writes are committed (attempt not updated, node not
   updated).

### Corner cases

8. **Large output in transaction** — Task output is 500KB JSON. Transaction should
   complete without hitting WAL size issues.

9. **Nested transactions** — If `withTransaction` is accidentally called inside another
   transaction, it should either fail-fast or use a savepoint. Not silently corrupt.

10. **Transaction under SQLITE_BUSY** — Another process holds a read lock. Assert
    `BEGIN IMMEDIATE` retries via `withSqliteWriteRetry` and eventually succeeds.

### Performance

11. **Transaction latency** — Benchmark the critical write groups. Each transaction
    should complete in <5ms for typical payloads. Assert no regression beyond 10ms
    p99.

12. **No I/O inside transaction** — Static analysis or code review assertion: the
    transaction body must not contain `await` calls to external services, only
    synchronous DB writes.

## Observability

### New metrics
- `smithers.db.transaction_ms` (histogram, fastBuckets) — duration of each
  transactional write group
- `smithers.db.transaction_rollbacks` (counter) — rollbacks due to errors
- `smithers.db.transaction_retries` (counter) — `SQLITE_BUSY` retries at the
  transaction level

### Logging
- `Effect.withLogSpan("db:transaction")` wrapping each write group
- On rollback: `Effect.logWarning("transaction rollback")` with `{ error, writeGroup }`
- Annotate with `{ writeGroup: "task-completion"|"task-start"|"approval"|"frame-commit" }`

## Codebase context

### Smithers files
- `src/engine/index.ts:2460-2493` — **Task completion path**: output upsert → attempt
  update → node update → event emit. The first three should be wrapped in a
  transaction. The event emit stays outside.
- `src/engine/index.ts:1228-1233` — **Task start path**: attempt insert → node update.
  Wrap in transaction.
- `src/engine/index.ts:2031-2085` — **Approval path**: approval update → node update →
  run status update. Wrap in transaction.
- `src/engine/index.ts:3163-3226` — **Frame commit path**: frame write → snapshot
  capture. Wrap in transaction.
- `src/db/write-retry.ts:86-155` — `withSqliteWriteRetry`: the transaction wrapper
  should replace individual retries with a single retry around the whole transaction.
- `src/db/adapter.ts` — SmithersDb methods are individual operations. Add a
  `withTransaction(fn)` method to the adapter.

### Temporal reference
- `temporal-reference/service/history/shard/context_impl.go` — Shard context uses
  `range_id` as a conditional write token; every persistence operation is conditional
  on owning the shard. Smithers' simpler analog is wrapping writes in `BEGIN IMMEDIATE`.
- `temporal-reference/schema/postgresql/v12/temporal/versioned/v1.0/schema.sql` —
  All Temporal writes are within transactions with `range_id` checks.
- `temporal-reference/service/history/history_engine_test.go` — Comprehensive mutation
  tests with persistence mock assertions verifying atomicity.

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

- **`effect`** core — `Effect.gen`, `Effect.acquireRelease`, `Effect.retry`, `Schedule`, `Effect.withLogSpan`, `Effect.annotateLogs`

No `@effect/workflow` or `@effect/cluster` needed — this is pure Effect core for DB transaction management.

### Key mapping

The `withTransaction` helper should return an `Effect<T, SqliteError>`, not a raw promise. The existing `withSqliteWriteRetry` logic should be converted to an Effect `Schedule`:

```typescript
import { Effect, Schedule } from "effect"

// Transaction wrapper as an Effect
const withTransaction = <T>(
  writeGroup: string,
  fn: Effect.Effect<T, SqliteError>
): Effect.Effect<T, SqliteError> =>
  Effect.gen(function*() {
    yield* Effect.withLogSpan(`db:transaction`)(
      Effect.annotateLogs({ writeGroup })(
        Effect.acquireRelease(
          // Acquire: begin transaction
          Effect.tryPromise(() => db.run("BEGIN IMMEDIATE")),
          // Release: commit or rollback
          (_, exit) => exit._tag === "Success"
            ? Effect.tryPromise(() => db.run("COMMIT"))
            : Effect.gen(function*() {
                yield* Effect.logWarning("transaction rollback").pipe(
                  Effect.annotateLogs({ error: exit.cause, writeGroup })
                )
                yield* Effect.tryPromise(() => db.run("ROLLBACK"))
              })
        ).pipe(
          Effect.flatMap(() => fn)
        )
      )
    )
  })
```

### SQLite write retry as an Effect Schedule

```typescript
import { Effect, Schedule } from "effect"

// Convert withSqliteWriteRetry to an Effect Schedule
const sqliteBusyRetrySchedule = Schedule.exponential("10 millis").pipe(
  Schedule.compose(Schedule.recurs(5)),
  Schedule.whileInput((error: SqliteError) => error.code === "SQLITE_BUSY")
)

// Transaction with retry
const transactionalWrite = <T>(
  writeGroup: string,
  fn: Effect.Effect<T, SqliteError>
): Effect.Effect<T, SqliteError> =>
  withTransaction(writeGroup, fn).pipe(
    Effect.retry(sqliteBusyRetrySchedule)
  )
```

### Applying to critical write groups

```typescript
// Task completion: write output -> update attempt -> update node state
const taskCompletion = transactionalWrite("task-completion",
  Effect.gen(function*() {
    yield* upsertOutputRow(outputData)
    yield* updateAttempt({ state: "finished", finishedAtMs: Date.now() })
    yield* updateNodeState({ state: "finished" })
    // Event emission stays OUTSIDE the transaction
  })
)

// Task start: insert attempt -> update node state
const taskStart = transactionalWrite("task-start",
  Effect.gen(function*() {
    yield* insertAttempt(attemptData)
    yield* updateNodeState({ state: "in-progress" })
  })
)

// Approval decision: update approval -> update node -> update run status
const approvalDecision = transactionalWrite("approval",
  Effect.gen(function*() {
    yield* updateApproval(approvalData)
    yield* updateNodeState({ state: newNodeState })
    yield* updateRunStatus(newRunStatus)
  })
)

// Frame commit: write frame -> write snapshot
const frameCommit = transactionalWrite("frame-commit",
  Effect.gen(function*() {
    yield* writeFrame(frameData)
    yield* writeSnapshot(snapshotData)
  })
)
```

### Effect patterns to apply

- Use `Effect.acquireRelease` for the SQLite write lock (`BEGIN IMMEDIATE` / `COMMIT` or `ROLLBACK`)
- Convert `withSqliteWriteRetry` to `Effect.retry` with a `Schedule.exponential` policy filtered on `SQLITE_BUSY`
- Emit events/logs only after the transaction `Effect` succeeds (outside the `acquireRelease` scope)
- Use `Effect.withLogSpan("db:transaction")` wrapping each write group
- Use `Effect.annotateLogs({ writeGroup })` to tag which critical section is executing

### Smithers Effect patterns to follow

- `src/effect/runtime.ts` — Use the custom runtime layer for transaction execution
- `src/effect/metrics.ts` — Wire transaction metrics (`smithers.db.transaction_ms`, `smithers.db.transaction_rollbacks`, etc.) using the existing histogram/counter helpers
- `src/effect/logging.ts` — Transaction log spans with `{ writeGroup, error }` annotations
- `src/db/write-retry.ts:86-155` — This file's `withSqliteWriteRetry` is the migration target: convert its retry loop to `Effect.retry` with a `Schedule`
- `src/effect/interop.ts` — Use `fromPromise()` to bridge existing synchronous Drizzle/SQLite calls into Effect

### Reference files

- No `@effect/workflow` or `@effect/cluster` reference needed for this ticket
- Follow the patterns in `src/effect/runtime.ts` for Effect execution context
- Follow the patterns in `src/db/write-retry.ts` as the source of truth for retry constants to preserve in the Schedule conversion
