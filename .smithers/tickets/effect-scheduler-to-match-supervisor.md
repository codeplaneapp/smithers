# Convert CLI scheduler to Effect (match supervisor pattern)

## Problem

`src/cli/scheduler.ts` is fully imperative — `setTimeout` polling loop, manual
`SIGINT`/`SIGTERM` handlers, raw `spawn` for child processes, no Effect usage at
all. Its sibling `src/cli/supervisor.ts` already demonstrates the correct pattern
with `Effect.repeat(Schedule.spaced(...))`, log annotations, and structured error
handling.

The scheduler is the only polling loop in the CLI that completely bypasses Effect.

## Proposed solution

Refactor to match `supervisor.ts`:
```typescript
export const runSchedulerEffect = Effect.gen(function* () {
  const adapter = yield* acquireDbEffect()
  yield* schedulerTickEffect(adapter).pipe(
    Effect.repeat(Schedule.spaced(`${pollIntervalMs} millis`)),
    Effect.annotateLogs({ component: "scheduler" }),
    Effect.interruptible,
  )
})
```

## Severity

**MAJOR** — Inconsistency with supervisor. No structured error handling, no log
annotations, no metrics, no graceful shutdown integration.

## Files

- `src/cli/scheduler.ts`
