---
title: "Test against the real stores"
description: "Test ownership and attempt code deterministically: the in-memory layer that runs the production stores, TestClock for every lease rule, the noop layers, and when a real file is the only honest test."
sidebar:
  order: 7
---

Nothing in these stores needs a mock. Every nondeterministic input is a service:
the database is a `SqlClient`, the lease reasoning reads the Effect `Clock`, and
the liveness answer is a `LivenessCheck` you pass in. A test swaps those and runs
the production code.

## Run the production stores in memory

`@smthrs/run-store/test/TestRunStore` provides `RunStore` and `AttemptStore` over
a fresh in-memory SQLite database with the migrations already applied. The stores
are the real ones; only the file is gone.

```ts
import { AttemptStore, RunStore } from "@smthrs/run-store"
import * as TestRunStore from "@smthrs/run-store/test/TestRunStore"
import * as Effect from "effect/Effect"

const withStores = <A, E>(
  effect: Effect.Effect<A, E, RunStore.RunStore | AttemptStore.AttemptStore>
) => effect.pipe(Effect.provide(TestRunStore.layer), Effect.scoped)
```

The layer is Node only, because it binds `node:sqlite`. Nothing else in the
package is: the root entry point names no driver and bundles for the browser.

Each provision gets its own database, so tests do not share rows. `Effect.scoped`
is required: the database is a scoped resource and closes with the scope.

## Drive every lease rule with TestClock

The lease is the part most worth testing and the part you must never wait for in
wall time. Both the store's own stamps and `Ownership.heartbeatLoop` read the
injected `Clock`, so `TestClock` controls all of it:

```ts
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Migrations from "@smthrs/run-store/Migrations"
import * as Duration from "effect/Duration"
import { TestClock } from "effect/testing"

const withTestClock = <A, E>(effect: Effect.Effect<A, E, RunStore.RunStore>) =>
  effect.pipe(
    Effect.provide(RunStore.layer),
    Effect.provide(Migrations.layer),
    Effect.provide(TestDatabase.layer),
    Effect.provide(TestClock.layer())
  )
```

`TestClock.adjust(Duration.seconds(31))` walks a fresh lease past
`heartbeatStaleAfter` in one statement, which is what makes a steal test a
readable ten lines. Take `nowMs` from `Clock.currentTimeMillis` in the code under
test, never `Date.now()`: a reading more than `heartbeatSkewAllowance` ahead of
the store's clock fails with `invalid_run`, and a test that mixed the two would
be failing on that rather than on what it meant to assert.

To test the supervision loop, race it against work and assert on the exit:

```ts
import { Ownership } from "@smthrs/run-store"
import type { OwnerId } from "@smthrs/run-store/Ownership"

const supervised = (runId: string, owner: OwnerId) =>
  Effect.raceFirst(Effect.never, Ownership.heartbeatLoop(runId, owner))
```

A pulse lands after each `TestClock.adjust(Ownership.heartbeatInterval)`. Once
the fence is gone, the loop interrupts itself and takes the raced work with it,
so the fiber's exit is an interrupt rather than a failure.

## Assert on outcomes, not on rows

Every operation answers with a tagged value, so the assertion is the contract:

```ts
const losesTheRace = Effect.gen(function*() {
  const runs = yield* RunStore.RunStore
  const outcome = yield* runs.claim("run-1", expected, ownerB, nowMs)
  expect(outcome).toEqual({ _tag: "AlreadyClaimed" })
})
```

Read the row back with `get` only for the fields the outcome does not carry:
`heartbeatAtMs` after a pulse, `finishedAtMs` after a terminal transition, or
`stateJson` to prove executable state round-tripped byte for byte. Counting
outcomes proves the other half; see
[Observe store outcomes](./observe-outcomes.md).

## Use the noop layers for compositions that must not persist

Both services ship an explicit absence, so a test that is not about persistence
provides the smallest thing that type-checks:

| Layer                      | Behavior                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunStore.layerNoop()`     | `create` and `get` fail with `persistence_failed`. Every compare-and-swap reports a loss: `NotFound`, or `ClaimLost` for `activate` and `abandonClaim`. |
| `AttemptStore.layerNoop()` | Every operation fails with the `unknown` code.                                                                                                          |

Both take partial overrides, which is how a test forces one outcome without
building a store:

```ts
const alwaysFenced = RunStore.layerNoop({
  heartbeat: () => Effect.succeed({ _tag: "FenceLost" })
})
```

Use an override to drive the caller's losing branch: a supervision test that
needs `FenceLost` on the third pulse gets it here, with no second process and no
clock arithmetic.

## When a real file is the only honest test

The in-memory database lives in one process, so it cannot prove anything about
two processes contending for one run. Cross-process fencing needs a real SQLite
file and two real Node processes, which is what
[`test/RunStoreFileFence.integration.test.ts`](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/run-store/test/RunStoreFileFence.integration.test.ts)
does: it spawns two children over one temporary database and steps them through a
takeover from the parent.

Write one of those only for a claim about concurrency across processes. Every
other rule in this package, the fence, the guards, the admission boundary, the
lease arithmetic, is fully decided inside one process.

## Next steps

- [Compose the stores into a host](./compose-the-stores.md): the production
  layer order the test layer stands in for.
- [Observe store outcomes](./observe-outcomes.md): asserting on counters.
- [Troubleshooting](../troubleshooting.md): the failures a test is most likely to
  hit first.
