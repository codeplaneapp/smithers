# Minor Effect idiom cleanup

## Problem

Collection of minor Effect usage improvements across the codebase.

### Items

1. **`write-retry.ts`** — Hand-rolled recursive retry (50 lines) reimplements
   `Schedule.exponential + Schedule.jittered + Schedule.upTo`. Replace with
   `Effect.retry` using the existing `retryPolicyToSchedule` (once wired in).

2. **`performance.now()` timing** — 6+ files use manual
   `const start = performance.now(); ... performance.now() - start` instead of
   `Effect.timed` or `Metric.trackDuration` combinator.

3. **`AsyncLocalStorage` vs `FiberRef`** — `versioning.ts` and `task-runtime.ts`
   use Node ALS instead of Effect's `FiberRef` which integrates with fiber model.

4. **`logging.ts` fire-and-forget** — `void runFork(program)` detaches logs from
   calling fiber's span context. Should use `Effect.log` within the pipeline.

5. **`as any` casts** — 92 occurrences across bridge files bypass Effect's type
   tracking. Should be addressed as types are fixed.

6. **`GenericTag` vs class `Tag`** — `builder.ts` uses old `GenericTag` pattern
   instead of class-based `Context.Tag`.

7. **Duplicate utilities** — `makeAbortError`, `wireAbortSignal`,
   `parseAttemptMetaJson` duplicated across 3+ files. Extract to shared module.

8. **Dead code** — `deferred-bridge.ts` engine context builder is created but
   never called.

9. **`builder.ts` `runSync(Schedule.driver)`** — Runs schedule driver
   synchronously in loop to count retries. Fragile; derive from config instead.

## Severity

**MINOR** — Each item is small but collectively they improve consistency and
reduce maintenance burden.

## Files

- `src/db/write-retry.ts`
- `src/effect/versioning.ts`, `src/effect/task-runtime.ts`
- `src/effect/logging.ts`
- `src/effect/builder.ts`
- `src/effect/deferred-bridge.ts`
- Multiple bridge files (duplicate utils)
- Multiple files (timing pattern)
