# `smithers events <run-id>` — queryable event history

## Revision Summary

- Anchored the ticket on the existing event persistence/query helpers instead of a
  new storage path.
- Added explicit large-history streaming rules so the command does not OOM on big
  runs.
- Added a centralized category-mapping step based on `SmithersEvent`.
- Marked ancestry-following as a follow-on that should reuse the same lineage model
  as continue-as-new/forks.

## Problem

Events are durably stored in `_smithers_events` (SQLite) and `stream.ndjson`, but
there's no CLI command to browse or filter them. `smithers logs` streams live events
but isn't designed for structured history queries like "show me all approval events"
or "show me what happened to node X."

Temporal and SWF derive most of their debugging power from workflow history being a
first-class queryable object, not just a log stream.

## Proposal

Add `smithers events <run-id>` with filtering and grouping:

```
$ smithers events abc123
#1  00:00.000  RunStarted
#2  00:00.012  NodePending       extract-data
#3  00:00.015  NodeStarted       extract-data
#4  00:02.341  ToolCallStarted   extract-data  web-search
#5  00:03.102  ToolCallFinished  extract-data  web-search
#6  00:04.210  NodeFinished      extract-data
#7  00:04.215  NodePending       review-gate
#8  00:04.220  NodeWaitingApproval  review-gate
...

$ smithers events abc123 --node extract-data
$ smithers events abc123 --type approval
$ smithers events abc123 --type tool-call
$ smithers events abc123 --since 5m
$ smithers events abc123 --json
```

### Filter flags

- `--node <id>` — events for a specific node
- `--type <category>` — filter by event category (approval, tool-call, node, run, scorer, etc.)
- `--since <duration>` — events from the last N minutes/hours
- `--limit <n>` — cap output rows
- `--json` — NDJSON output for piping

### Grouping views (stretch)

- `--group-by node` — events grouped under each node
- `--group-by attempt` — events grouped by attempt number

## Additional Steps

1. Add the `events` command to the CLI command registry and help output.
2. Extend the adapter query surface so filters can be pushed into SQLite where
   possible.
3. Centralize the event-type-to-category mapping in one helper so `--type` stays in
   sync with `SmithersEvent`.
4. Reuse `formatEventLine()` for human output and keep `--json` as NDJSON for
   streaming friendliness.
5. Default to a capped result set and stream rows incrementally for larger queries.
6. Make `--watch` a follow-on that builds on this command rather than duplicating the
   query logic.
7. When continuation lineage lands, implement `--follow-ancestry` using the same
   ancestry model already used by time-travel/forks.

## Implementation notes

- Read from `_smithers_events` table (already has seq, timestamp, type, payload)
- Parse event type to derive category for `--type` filtering
- Format timestamps as relative offset from run start
- Colorize by event type (green=finished, red=failed, yellow=approval, blue=tool)

## Verification requirements

### E2E tests

1. **Basic event listing** — Run a workflow to completion. Run
   `smithers events <id>`. Assert output includes RunStarted, NodePending,
   NodeStarted, NodeFinished, RunFinished in chronological order with seq numbers.

2. **--node filter** — Multi-node workflow. `smithers events <id> --node task-a`.
   Assert only events with nodeId="task-a" are shown. Events for other nodes absent.

3. **--type filter (approval)** — Workflow with approval.
   `smithers events <id> --type approval`. Assert only ApprovalRequested,
   ApprovalGranted/Denied events shown.

4. **--type filter (tool-call)** — `smithers events <id> --type tool-call`. Assert
   only ToolCallStarted/Finished events shown.

5. **--since filter** — Insert events spanning 10 minutes.
   `smithers events <id> --since 5m`. Assert only events from last 5 minutes shown.

6. **--limit flag** — `smithers events <id> --limit 5`. Assert exactly 5 events
   returned.

7. **--json output** — `smithers events <id> --json`. Assert valid NDJSON output,
   each line parseable with `JSON.parse()`.

8. **--group-by node** — `smithers events <id> --group-by node`. Assert events are
   grouped under node headers, not interleaved.

9. **--group-by attempt** — `smithers events <id> --group-by attempt`. Assert events
   grouped by attempt number within each node.

10. **Empty run** — `smithers events <id>` where run has 0 events (just created).
    Assert clean empty output, no error.

11. **Relative timestamps** — Assert timestamps show relative offset from run start
    (e.g., `+00:02.341`) not absolute wall-clock time.

12. **Colorized output** — Assert RunStarted/RunFinished are different colors from
    NodeFailed (test by checking ANSI escape codes in output).

### Corner cases

13. **Run with 50,000 events** — Assert `--limit 100` returns in <100ms. Full listing
    without limit should stream, not OOM.

14. **Events with large payloads** — Event with 100KB payload JSON. Assert it doesn't
    blow up the display. Payload should be truncated with "..." in non-JSON mode.

15. **Non-existent run** — `smithers events bad-id`. Exit code 4, "Run not found".

16. **Combined filters** — `smithers events <id> --node task-a --type tool-call --limit 10`.
    Assert filters compose correctly (AND logic).

### Size limits

17. **Max --limit value**: 100,000 events. Above this, warn and cap.
18. **Default display limit**: 1000 events without `--limit`. Print "showing first 1000
    of N events, use --limit to see more".

## Observability

No new events or metrics needed — this is a read-only CLI command that queries
existing event data.

### Logging
- `Effect.withLogSpan("cli:events")` for the command execution
- Annotate with `{ runId, filters, resultCount }`

## Codebase context

### Smithers files
- `src/events.ts:10-164` — EventBus class; `persistDbEffect()` at lines 110-149
  writes to `_smithers_events` table. The `events` command reads from this table.
- `src/db/internal-schema.ts` — `_smithers_events` table: `(runId, seq, type,
  payloadJson, timestampMs)`. This is the query source.
- `src/db/adapter.ts` — `listEvents(runId)` method already exists; extend with
  filter params.
- `src/SmithersEvent.ts` — All 26+ event types with their fields. Use this to build
  the `--type` category mapping (e.g., "approval" → ApprovalRequested |
  ApprovalGranted | ApprovalDenied).
- `src/cli/format.ts:46-91` — `formatEventLine()`: already formats individual events
  with colors. Reuse and extend for the `events` command.
- `src/cli/index.ts:1358-1380` — `ps` command pattern: query DB → format → output.
  `events` command follows the same structure.

### Temporal reference
- `temporal-reference/service/history/historybuilder/history_builder.go` — Temporal's
  history builder maintains ordered, sequenced events. Smithers' `_smithers_events`
  table with `seq` column is the same idea.
- Temporal's `GetWorkflowExecutionHistory` API returns paginated, filtered event
  history — the model for this CLI command.

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

- **`effect`** core — `Effect.gen`, `Effect.annotateLogs`, `Effect.withLogSpan`, `Stream`, `Schedule`

No `@effect/workflow` or `@effect/cluster` needed — this is a read-only query command using Effect core and `Stream` for pagination/watch mode.

### Key mapping

Event queries should be Effect pipelines with `Effect.gen`. Streaming large event sets should use `Stream.fromIterable` or `Stream.fromEffect` for pagination. The `--watch` mode should use `Stream.repeat` with a `Schedule`:

```typescript
import { Effect, Stream, Schedule } from "effect"

// Event query pipeline
const queryEvents = (params: {
  runId: string
  nodeFilter?: string
  typeFilter?: string
  since?: number
  limit?: number
}) => Effect.gen(function*() {
  yield* Effect.annotateLogs({ runId: params.runId, filters: params })
  yield* Effect.withLogSpan("cli:events")(
    Effect.gen(function*() {
      const events = yield* fetchEventsFromDb(params)
      yield* Effect.annotateLogs({ resultCount: events.length })
      return events
    })
  )
})

// Streaming large event sets with pagination
const streamEvents = (runId: string, pageSize: number = 1000) =>
  Stream.paginateEffect(0, (offset) =>
    Effect.gen(function*() {
      const page = yield* fetchEventsPage(runId, offset, pageSize)
      const next = page.length === pageSize
        ? Option.some(offset + pageSize)
        : Option.none()
      return [page, next] as const
    })
  ).pipe(
    Stream.flatMap(Stream.fromIterable)
  )
```

### Watch mode with Stream.repeat and Schedule

```typescript
// --watch mode: tail new events using Stream.repeatEffect + Schedule
const watchEvents = (runId: string, interval: number = 2000) => {
  let lastSeq = 0

  return Stream.repeatEffect(
    Effect.gen(function*() {
      const newEvents = yield* fetchEventsAfterSeq(runId, lastSeq)
      if (newEvents.length > 0) {
        lastSeq = newEvents[newEvents.length - 1].seq
      }
      return newEvents
    })
  ).pipe(
    Stream.schedule(Schedule.spaced(`${interval} millis`)),
    Stream.flatMap(Stream.fromIterable),
    // Stop when run reaches terminal state
    Stream.takeWhile((event) =>
      event.type !== "RunFinished" &&
      event.type !== "RunFailed" &&
      event.type !== "RunCancelled"
    )
  )
}

// Usage
const runWatch = watchEvents(runId, intervalMs).pipe(
  Stream.runForEach((event) =>
    Effect.sync(() => console.log(formatEventLine(event)))
  )
)
```

### Effect patterns to apply

- `Effect.gen` for the query pipeline: fetch events with filters pushed to SQLite
- `Stream.paginateEffect` for streaming large event sets without OOM
- `Stream.repeatEffect` with `Schedule.spaced(interval)` for `--watch` mode
- `Stream.takeWhile` for terminal state detection (auto-exit when run finishes)
- `Stream.fromIterable` to convert page arrays into stream elements
- `Effect.withLogSpan("cli:events")` for command-level observability

### Smithers Effect patterns to follow

- `src/effect/runtime.ts` — Use the custom runtime layer for event query execution
- `src/effect/logging.ts` — Annotate with `{ runId, filters, resultCount }`
- `src/effect/interop.ts` — Use `fromPromise()` to bridge existing `adapter.listEvents()` into Effect
- Follow the existing `Effect.gen` + `Effect.annotateLogs` + `Effect.withLogSpan` patterns

### Reference files

- No `@effect/workflow` or `@effect/cluster` reference needed for this ticket
- Follow the patterns in `src/effect/runtime.ts` for Effect execution context
- Follow the patterns in `src/db/adapter.ts` for the `listEvents()` query method to wrap in Effect
