# Replace SmithersError with tagged Effect errors

## Problem

`SmithersError` (in `src/utils/errors.ts`) extends `Error` and uses a string
`code` field for discrimination. This is not a tagged union and does not
participate in Effect's type system. Callers cannot use `Effect.catchTag` and
must resort to runtime string matching on `.code`.

Additionally, all RPC definitions in `entity-worker.ts` and `sandbox-entity.ts`
use `error: Schema.Unknown`, defeating the typed error channel entirely.

### Impact

- No compile-time error channel discrimination anywhere in the codebase
- Cannot compose error handling with `Effect.catchTag`/`Effect.catchTags`
- 80+ error codes exist as strings but none are typed at the Effect level
- RPC callers get `unknown` as their error type

## Proposed solution

1. Convert `SmithersError` to use `Data.TaggedError` or `Schema.TaggedError`
   per error category (e.g., `class TaskTimeout extends Data.TaggedError("TaskTimeout")`)
2. Replace `error: Schema.Unknown` in all `Rpc.make` calls with specific
   error schemas
3. Update bridge files to use `Effect.catchTag` instead of string matching
4. Keep backward compat by having `SmithersError.code` still available for
   external consumers (CLI output, HTTP responses)

## Severity

**MAJOR** — Affects every file that handles errors. Third highest-impact change
after engine loop and bridge `runPromise` elimination.

## Files

- `src/utils/errors.ts`
- `src/effect/entity-worker.ts`
- `src/effect/sandbox-entity.ts`
- All bridge files (callers of `Effect.fail(new SmithersError(...))`)
