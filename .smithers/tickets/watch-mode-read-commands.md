# `--watch` flag on read commands (ps, inspect, node, events)

## Revision Summary

- Added dependency notes so `events --watch` lands on top of the new `events`
  command, while `ps/inspect/node --watch` can ship independently.
- Replaced the nonexistent `src/cli/tui-helpers.ts` reference with a shared watch
  utility recommendation.
- Clarified the rendering model: re-render for `ps/inspect/node`, append-only for
  `events`.
- Added minimum interval/backpressure guidance so watch mode does not hammer the DB.

## Problem

`smithers logs` supports `--follow` for live streaming, but other read commands
(`ps`, `inspect`, `node`) are one-shot. Operators monitoring active runs have to
manually re-run commands to see updated state. K9s and `kubectl get --watch` show
that live-updating read views are a major ergonomics win.

## Proposal

Add a `--watch` (or `-w`) flag to these commands:

### `smithers ps --watch`
Re-renders the run table every 2s (configurable with `--interval`). Shows status
transitions in real time. Most valuable for monitoring a batch of runs.

### `smithers inspect <run-id> --watch`
Re-renders the run detail every 2s. Useful for watching a single run progress
through its nodes.

### `smithers events <run-id> --watch`
Tails new events as they arrive (similar to `logs --follow` but with the structured
event format from the `events` command).

### Behavior

- Clear and re-render on each tick (like `watch(1)`)
- Exit automatically when the run reaches a terminal state (finished, failed,
  cancelled) — print final state and exit
- `--interval <seconds>` to control refresh rate (default 2s)
- Ctrl+C to exit cleanly

## Additional Steps

1. Extract a shared watch-loop helper for polling, terminal-state checks, SIGINT
   cleanup, and interval validation.
2. Add `--watch` and `--interval` to `ps`, `inspect`, and `node` first.
3. Implement `events --watch` separately on top of the new `events` command as an
   append-only stream using `seq > lastSeen`.
4. Clamp very small intervals to a safe minimum (for example 500ms).
5. Ensure a final render/drain happens when a run becomes terminal.
6. Add PTY-based tests for clear-screen behavior and Ctrl+C handling.

## Implementation notes

- Use a simple `setInterval` + clear-screen loop
- Re-use the existing command output logic, just re-invoke on timer
- For `events --watch`, can also poll `_smithers_events` with `seq > lastSeen`
  for incremental updates
- Consider using the `EventBus` subscription directly if the server is in-process

## Verification requirements

### E2E tests

1. **`ps --watch` renders multiple ticks** — Start a workflow. Run
   `smithers ps --watch --interval 1`. Capture output for 3s. Assert at least 2
   renders occurred (detect by counting clear-screen sequences or repeated headers).

2. **`ps --watch` shows status change** — Start a workflow that finishes after 2s. Run
   `ps --watch`. Assert output transitions from "running" to "finished".

3. **`inspect --watch` auto-exits on completion** — Run `inspect <id> --watch` on a
   workflow that finishes in 2s. Assert the command exits automatically after the run
   reaches terminal state. Assert final output shows "finished".

4. **`events --watch` tails new events** — Start a workflow. Run
   `events <id> --watch`. Assert new events appear incrementally as the workflow
   progresses (not re-rendering the full list each time).

5. **`--interval` flag** — `ps --watch --interval 5`. Assert renders are ~5s apart
   (within tolerance).

6. **Ctrl+C clean exit** — Send SIGINT to a `--watch` process. Assert it exits
   cleanly with exit code 0, no stack trace.

7. **`--watch` on finished run** — `inspect <id> --watch` where run is already
   finished. Assert it prints once and exits immediately (no infinite loop).

### Corner cases

8. **Rapid interval** — `--interval 0.1` (100ms). Should work but may be throttled to
   minimum 500ms to avoid excessive DB queries.

9. **DB disappears during watch** — DB file is moved/deleted while watching. Assert
   clean error message on next tick, not a crash.

10. **Large ps output** — 500 runs in DB. `ps --watch` should not flicker excessively.
    Consider only re-rendering changed rows.

11. **Watch with filters** — `ps --watch --status running`. Assert only running runs
    shown, and completed runs disappear from view on next tick.

## Observability

No new events or metrics needed — this reuses existing read paths.

### Logging
- `Effect.withLogSpan("cli:watch")`
- Annotate with `{ command, interval, tickCount }`

## Codebase context

### Smithers files
- `src/cli/index.ts:1358-1380` — `ps` command. Add `--watch` and `--interval` options
  to the existing options schema.
- `src/cli/index.ts:1937-2028` — `inspect` command. Same: add `--watch` option.
- `src/cli/index.ts` — `logs` command with `--follow` flag: reference pattern for
  streaming CLI output. `watch` is similar but re-renders instead of appending.
- Add a small shared watch helper module if the polling/render logic starts getting
  duplicated across commands.

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

- **`effect`** core — `Effect.gen`, `Stream`, `Schedule`, `Effect.annotateLogs`, `Effect.withLogSpan`

No `@effect/workflow` or `@effect/cluster` needed — this is a CLI polling/rendering feature using Effect core and `Stream`.

### Key mapping

The polling loop should use `Stream.repeatEffect` with a `Schedule.spaced(interval)`. Terminal state detection should be a `Stream.takeWhile`. The clear-and-rerender should be an Effect:

```typescript
import { Effect, Stream, Schedule } from "effect"

// Shared watch helper using Stream.repeatEffect
const watchCommand = <T>(params: {
  command: string
  interval: number
  fetch: Effect.Effect<T, CommandError>
  render: (data: T) => Effect.Effect<void, never>
  isTerminal: (data: T) => boolean
}) => Effect.gen(function*() {
  yield* Effect.annotateLogs({ command: params.command, interval: params.interval })
  yield* Effect.withLogSpan("cli:watch")(
    Stream.repeatEffect(params.fetch).pipe(
      Stream.schedule(Schedule.spaced(`${params.interval} millis`)),
      // Stop when run reaches terminal state
      Stream.takeWhile((data) => !params.isTerminal(data)),
      // Clear and re-render on each tick
      Stream.runForEach((data) =>
        Effect.gen(function*() {
          yield* clearScreen
          yield* params.render(data)
        })
      )
    )
  )
  // Final render after terminal state
  const finalData = yield* params.fetch
  yield* params.render(finalData)
})

// Clear screen as an Effect
const clearScreen = Effect.sync(() => {
  process.stdout.write("\x1B[2J\x1B[0f")
})
```

### Applying to each command

```typescript
// ps --watch
const psWatch = (filters: PsFilters, interval: number) =>
  watchCommand({
    command: "ps",
    interval,
    fetch: fetchRunsList(filters),
    render: (runs) => Effect.sync(() => printRunsTable(runs)),
    isTerminal: () => false, // ps never auto-exits
  })

// inspect --watch
const inspectWatch = (runId: string, interval: number) =>
  watchCommand({
    command: "inspect",
    interval,
    fetch: fetchRunDetail(runId),
    render: (detail) => Effect.sync(() => printRunDetail(detail)),
    isTerminal: (detail) =>
      ["finished", "failed", "cancelled"].includes(detail.status),
  })

// events --watch (append-only, not clear-and-rerender)
const eventsWatch = (runId: string, interval: number) => {
  let lastSeq = 0

  return Effect.gen(function*() {
    yield* Effect.annotateLogs({ command: "events", runId, interval })
    yield* Effect.withLogSpan("cli:watch")(
      Stream.repeatEffect(
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
        // Stop on terminal event
        Stream.takeWhile((event) =>
          event.type !== "RunFinished" &&
          event.type !== "RunFailed" &&
          event.type !== "RunCancelled"
        ),
        Stream.runForEach((event) =>
          Effect.sync(() => console.log(formatEventLine(event)))
        )
      )
    )
  })
}
```

### Interval clamping

```typescript
// Clamp interval to safe minimum (500ms) using Effect
const clampInterval = (requestedMs: number): number =>
  Math.max(requestedMs, 500)
```

### Effect patterns to apply

- `Stream.repeatEffect` with `Schedule.spaced(interval)` for the polling loop (replaces `setInterval`)
- `Stream.takeWhile` for terminal state detection and auto-exit
- `Stream.runForEach` for rendering each tick
- `Effect.sync` for synchronous side effects (clear screen, print output)
- `Effect.withLogSpan("cli:watch")` with `{ command, interval, tickCount }` annotations
- Shared `watchCommand` helper to avoid duplicating the poll/render/exit logic

### Smithers Effect patterns to follow

- `src/effect/runtime.ts` — Use the custom runtime layer for watch loop execution
- `src/effect/logging.ts` — Annotate with `{ command, interval, tickCount }`
- `src/effect/interop.ts` — Use `fromPromise()` to bridge existing command fetch logic into Effect
- Follow the existing `Effect.gen` + `Effect.annotateLogs` + `Effect.withLogSpan` patterns

### Reference files

- No `@effect/workflow` or `@effect/cluster` reference needed for this ticket
- Follow the patterns in `src/effect/runtime.ts` for Effect execution context
- Follow the patterns in `src/cli/index.ts` for existing command implementations to wrap in the watch helper
