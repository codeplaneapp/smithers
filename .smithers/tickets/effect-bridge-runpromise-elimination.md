# Eliminate runPromise from bridge internals — compose via Layer

## Problem

Every bridge file (`activity-bridge.ts`, `durable-deferred-bridge.ts`,
`workflow-make-bridge.ts`, `single-runner.ts`, `sql-message-storage.ts`) creates
its own `Scope.make()` via `Effect.runPromise`, builds a context via another
`Effect.runPromise`, then runs operations via yet another `Effect.runPromise`.
This is "Promise code wearing Effect clothes."

### Specific issues

1. **Pervasive `runPromise`** — `workflow-make-bridge.ts` has 6 separate
   `Effect.runPromise` calls. Each creates an independent fiber with no shared
   context, no shared scope, no interruption propagation.

2. **Unclosed Scopes** — `Scope.make()` is cached in module-level `let`
   variables in 4 files with no `Scope.close()`. These hold `WorkflowEngine`
   resources (fibers, storage) that never clean up.

3. **Module-level mutable singletons** — `let activityEngineScope`,
   `let activityEngineContextPromise`, etc. Circumvents Effect's DI entirely.
   Makes testing impossible (no way to inject a test context).

4. **`SmithersDb` dual API** — Every method exists as both `fooEffect()` and
   `foo()` where the latter calls `runPromise`. 40+ duplicated methods. Every
   `runPromise` boundary loses fiber context (log annotations, spans, metrics).

5. **`sql-message-storage.ts` Effect→Promise→Effect round trip** — Wraps
   `@effect/sql` `SqlClient` in Promises, then `SmithersDb` wraps those back
   into Effects via `fromPromise`. Double context switch on every DB query.

## Proposed solution

1. Each bridge operation should return `Effect<A, E, R>` where `R` includes
   required services.
2. Engine contexts should be provided as `Layer`, using Layer memoization for
   singleton behavior instead of module globals.
3. There should be ONE `runPromise` at the outermost edge (CLI/HTTP handler).
4. Remove the Promise wrappers from `SmithersDb` — callers should use the
   Effect variants directly or call `runPromise` at their own boundary.
5. `SqlMessageStorage` should expose Effect-returning methods, not Promise.

## Severity

**CRITICAL** — The current approach loses all Effect benefits (structured
concurrency, typed errors, resource safety, tracing) at every boundary.

## Files

- `src/effect/activity-bridge.ts`
- `src/effect/durable-deferred-bridge.ts`
- `src/effect/workflow-make-bridge.ts`
- `src/effect/single-runner.ts`
- `src/effect/deferred-bridge.ts`
- `src/effect/sql-message-storage.ts`
- `src/db/adapter.ts`
