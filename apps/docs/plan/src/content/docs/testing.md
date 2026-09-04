---
title: "Testing"
description: "What the package's own suites pin, and how to test code that builds plans: the one service to provide, an in-memory store, and the assertions worth writing."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/plan/docs/testing.md"
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

Those two helpers are what this package's own suites use. No clock, no
filesystem, and no fake anything: a plan is a pure function of its declarations,
so a plan test is an ordinary value test.

Testing persistence adds a database. [`@smthrs/database`](https://database.smithers.sh/reference/api/) ships a
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
digest did not move. This package pins that with a `Date`, a `URL`, and a custom
`toJSON` object.

### Keep fixtures out of test modules

Importing a `*.test.ts` module registers its suites in the importer, so shared
fixtures belong in an ordinary module. This package learned that when
`PlanStore.test.ts` imported helpers from `Plan.test.ts` and re-ran every case
in it, including a 10,000-node chain that then timed out on a slower CI runner
for work `PlanStore` never asked for.

## What the package's own suites pin

The package-owned [`@smthrs/plan` suite](/reference/api/) pins the step-key compiler
and its collision cases: prototype-named dependencies, forged digest inputs,
projected values resolved as own data properties only, adversarial projection
corpora, and a memo whose leader is interrupted while a waiter is parked on it.
Payload tests prove the authoring AST is a JSON mirror, so distinct `Date` and
`URL` payloads never share a key, no function survives into a stored plan, and
a `toJSON` returning its own receiver refuses on both the clone and the input
rather than keying as an empty object. Plan tests cover topological order,
conflict annotation and the ordering edges it infers, reader-after-writer
edges, append across generations, diff attribution for every hashed field,
draft validation, and bounded-resource compilation of a large chain in both
declaration orders. Immutability is pinned by mutating the caller's `Date`,
`URL`, and custom-`toJSON` objects after compiling and asserting the stored
material and the plan digest do not move, and by proving an effect edit re-keys
its node instead of moving the approval digest silently. The store suite runs
real SQLite: append-only triggers including the plan-id pin, compare-and-swap
on the plan generation, the persisted-prefix check that rolls back an append
grown from a divergent branch, ordinal uniqueness, and every refusal code.
Property suites cover file-set globbing, overlap, and Unicode normalization.
