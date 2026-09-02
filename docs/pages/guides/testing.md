---
description: "Deterministic host fixtures, the in-memory engine, and SQL-backed integration tests that need no external service."
---

# Testing

This guide covers deterministic host fixtures, an in-memory flow engine, and SQL-backed engine integration tests. It does not require external services.

## Unit-test a handler

Use `FlowEngine.layerMemory` when the behavior under test does not require restart replay:

```ts
import { assert, it } from "@effect/vitest"

const layer = Build.toLayer(({ target }) =>
  Effect.succeed({ artifact: `${target}.js` })
).pipe(
  Layer.provideMerge(FlowEngine.layerMemory)
)

it.effect("builds an artifact", () =>
  Effect.gen(function*() {
    const result = yield* Build.execute(
      { target: "server", sourceDigest: "abc" },
      { executionId: "test-build-1" }
    ).pipe(Effect.provide(layer))

    assert.deepStrictEqual(result, { artifact: "server.js" })
  }))
```

Select explicit execution IDs so failures are reproducible.

## Test host operations

`TestHost.layer` supplies an in-memory filesystem, a scripted command interpreter, seeded Random, a Jujutsu service, and Effect's `HttpClient` tag filled by `HttpClient.layerNoop()`, a stub that fails every request with a `TransportError`, so a test that needs real responses provides its own client over the bundle. Configure only the seams a test exercises:

```ts
import * as TestHost from "@smthrs/kernel/test/TestHost"

const HostLayer = TestHost.layer({
  files: { "/workspace/input.txt": "hello" },
  commands: {
    "read-input": { stdout: "hello\n", exitCode: 0 }
  },
  seed: 42
})
```

`TestHost` is imported from its subpath rather than the `@smthrs/kernel` root, which stays browser-safe ([browser support](/architecture/browser-support)); `effect/testing`'s `TestClock` reaches for `node:assert`, so the bundle itself is Node-only. Consult the actual `TestHost.layer` option types when extending a fixture; the filesystem and interpreter helpers deliberately implement only the host contracts used by tests.

For kernel tests, `TestGrantStore.layerAllow`, `layerDeny`, and `layerScripted` provide explicit authorization behavior.

## Test durable persistence

Combine:

- `TestJournal.layer()` (from `@smthrs/journal/test/TestJournal`) for a migrated in-memory SQLite journal, `TestRunStore.layer` and `TestCacheStore.layer` for the run and cache stores, or `TestStores.layer()` (from `@smthrs/engine-store/test/TestStores`) for all four over one database,
- `DurableEngineState.makeMemory()` for deferred/clock state,
- `StepBoundary.layerTest()` for deterministic boundary evidence,
- a stub `Jj` (`@smthrs/jj/browser/BrowserJj`'s `layerUnsupported`).

Create a second `EngineStore.make` within the same service scope to simulate engine restart. Register the same handler, complete a deferred or call `resume`, and assert that completed action code was not dispatched twice.

Flush the journal before reading committed entries:

```ts
const journal = yield* Journal.Journal
yield* journal.flush
const page = yield* journal.entries({ runId, limit: 100 })
```

An accepted submission is not necessarily durable until `flush` completes.

{/* generated:testing-guide start */}

## The testing library

Everything above is supplied by the package under test: `@smthrs/kernel` ships `TestHost`, `@smthrs/journal` ships `TestJournal`, and so on. `@smthrs/testing` is the separate published library for the other half of a test, the part that asserts. It carries engine and model doubles, pure plan and journal assertions, a host conformance suite, deterministic score gates, and the Vitest adapter that runs an Effect body under a test clock.

```ts
import { Conformance, EngineSubject, JournalAssertions, TestLayers } from "@smthrs/testing"
import * as Vitest from "@smthrs/testing/Vitest"
```

The root entry point exports one namespace per module, and each is also importable from its own subpath. `Vitest` is the exception and is absent from the root barrel: `vitest` refuses to load through `require()`, so a barrel that carried it would break `require("@smthrs/testing")` for every CommonJS consumer of the assertion helpers.

Three things it is used for, in rising order of commitment.

**Assert what a run journaled.** `JournalAssertions.expectJournal` reads entries in `entry.index` order and answers about steps and journaled effects separately, so an at-most-once claim about an external effect cannot be satisfied by an ordinary step that happens to share its key.

**Replay a model instead of calling one.** `CachedModel` records what a fixture is missing and replays what it has, keyed by the full canonical request with `modelId` included, so switching models is an ordinary miss that records a second entry. `RecordedModel` is the strict double: it matches by request shape with `modelId` erased, claims each recorded call once, refuses a request the fixture does not describe, and refuses a fixture recorded against another model. Neither reads the environment, so how a suite decides to record stays the suite's business.

**Certify an engine.** `Conformance.coreSuite()` is the mandatory black-box suite every `EngineSubject` must pass: identity, interruption, replay, and race. `MemoryEngine` and `FlowEngineLike` are the two reference subjects it is developed against, and `RestartableEngine` adds the restart and hard-kill boundaries that a lease-based reclaim has to recover from. The race and interrupt cases advance a `TestClock`, so register them through `Vitest.testEffect(...).effect`, which supplies one, and not through `.live`, which does not.

Every failure the package raises carries a stable `code` from a closed union, so a caller matches on the code rather than on the prose of a message. The package's own reference, generated from its sources, lists every module and every documented export.

{/* generated:testing-guide end */}

## Test invariants

High-value properties include:

- canonical inputs produce the same `Key`,
- reordered object keys and set-like declarations do not change a cache key,
- replay reuses completed attempt exits,
- irreversible retries without idempotency fail,
- stale ownership cannot be stolen without liveness evidence,
- rejected journal admission does not imply contiguous sequence numbers,
- sync resumes from the last applied cursor,
- rewind preserves an audit on injected failure.

Run all package checks with:

```sh
pnpm run check
```

See [Determinism and replay](/concepts/determinism-and-replay) and the package references for [`@smthrs/kernel`](/api/kernel), [`@smthrs/journal`](/api/journal), [`@smthrs/run-store`](/api/run-store), and [`@smthrs/step-cache`](/api/step-cache).
