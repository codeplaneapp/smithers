---
title: "Testing"
description: "How to test code that builds plans: the one service to provide, a real in-memory store, and the assertions worth writing."
---

## Testing code that builds plans

Compiling asks for Effect's `Crypto` service and nothing else, so a plan test
needs one layer:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"

/** Provides concrete Node cryptography to a test Effect. */
export const withCrypto = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Effect.Effect<A, E> =>
  Effect.provide(effect, NodeCrypto.layer)

/** The same, for an Effect expected to fail: yields the typed error. */
export const withCryptoFailure = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Effect.Effect<E, A> =>
  withCrypto(Effect.flip(effect))
```

Those two helpers are the whole harness. No clock, no filesystem, and no fake
anything: a plan is a pure function of its declarations, so a plan test is an
ordinary value test.

Testing persistence adds a database. [`@smthrs/database`](/api/database) ships a
real in-memory SQLite layer for exactly this, so a store test exercises the
append-only triggers rather than a mock that cannot raise them:

```ts
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Migrations from "@smthrs/plan/Migrations"
import * as PlanStore from "@smthrs/plan/PlanStore"
import * as Layer from "effect/Layer"

const stores = Layer.provideMerge(PlanStore.layer, Layer.provideMerge(Migrations.layer, TestDatabase.layer))
```

### Assert on keys, not on shape

A plan's value is that identity is computable. The assertions that earn their
place say so:

- An edit re-keys its node and its dependent cone, and nothing else.
- A rename re-keys nothing, because ids are lookup addresses.
- An ordering edge, a priority change, or a conflict annotation leaves every key
  where it was.
- Compiling the same drafts twice produces the same digest.

### Mutate the caller's draft after compiling

A compiled plan is a deep-frozen snapshot. The cheapest proof is to compile,
mutate the object you passed in, and assert the stored material and the plan
digest did not move. The values worth trying are a `Date`, a `URL`, and an
object with a custom `toJSON`, because each one keys through a different path.

### Keep fixtures out of test modules

Importing a `*.test.ts` module registers its suites in the importer, so shared
fixtures belong in an ordinary module. When one suite pulls a helper out of
another suite's file, it re-runs every case in that file, and a fast suite
inherits a slow one's runtime and its timeouts for work it never asked for.
