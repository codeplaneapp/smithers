---
title: "Register an Effect test body"
description: "Use the Vitest adapter to run Effect bodies under a per-case layer and a deterministic clock, and know when to reach for .live instead."
sidebar:
  order: 1
---

`@smthrs/testing/Vitest` turns an Effect into a registered vitest case. It is
the only module in the package that imports a runner, and it is ESM only, so it
is absent from the root barrel.

```ts
import { describe, expect, it } from "@smthrs/testing/Vitest"
```

## Register a body with no requirements

`it` is the Effect-aware registrar, with `scoped` aliased onto `it.effect`:

```ts
import { describe, expect, it } from "@smthrs/testing/Vitest"
import * as Effect from "effect/Effect"

describe("plan projection", () => {
  it.effect("renders deterministically", () =>
    Effect.sync(() => {
      expect(1 + 1).toBe(2)
    }))
})
```

`it.effect` and `it.scoped` run the body under a `TestClock`. `it.live` runs it
on the real clock. Both wrap the body in `Effect.scoped`, so a body that
acquires a scoped resource needs no extra ceremony.

## Register a body that needs services

`testEffect(layer)` returns registrars that carry the layer's requirements, and
builds a **fresh** environment for every case:

```ts
import { EngineSubject, TestLayers } from "@smthrs/testing"
import { testEffect } from "@smthrs/testing/Vitest"
import * as Effect from "effect/Effect"

const test = testEffect(TestLayers.unit(EngineSubject.layerNoop()))

test.effect("reads the subject from context", () =>
  Effect.gen(function*() {
    const engine = yield* EngineSubject.EngineSubject
    // The unit tier's noop subject fails every operation as unavailable.
    yield* Effect.flip(engine.result("nothing"))
  }))
```

Because the layer is rebuilt per case, no state is shared between tests,
including the deterministic variant's `TestClock`, and no test can depend on
registration order.

Each registrar takes an optional third argument: a timeout in milliseconds, or
a vitest `TestOptions` object.

```ts
test.effect("finishes inside a second", Effect.sync(() => undefined), 1_000)
```

`test.skip` and `test.only` register a skipped or focused case under the
deterministic clock. `test.live.skip` and `test.live.only` do the same on the
real clock.

## Pick the right clock

Reach for `.live` only when the body must observe real elapsed time: a socket
round trip, a subprocess, a real timer. Everything else belongs on `.effect`,
including anything that touches this package's conformance pins.

The race and interrupt pins in `Conformance.coreSuite()` advance virtual time.
Registered through `.live` they wait on a clock nothing is moving, and the case
hangs until vitest's own timeout. That symptom and its fix are in
[Troubleshooting](../troubleshooting.md#a-conformance-case-hangs-until-the-vitest-timeout).

## Cancellation

Vitest cancellation is converted to fiber interruption at this boundary: the
body runs as a forked fiber and the runner's `AbortSignal` triggers
`Fiber.interrupt`. The signal itself never crosses into Effect code, so a body
never receives one and never has to thread one through. A scoped resource's
finalizer runs on cancellation exactly as it does on failure.

## Why `it` is a proxy, and why that matters to you

The module's `it` is a fresh callable over `@effect/vitest`'s, built as a
`Proxy` rather than by writing into it.

`Object.assign(EffectVitest.it, ...)` mutated the peer dependency's live module
object. That module is externalized and shared across every test file in a
worker process, so importing this module replaced `it.scoped` for every other
file in that worker with a registrar that has different semantics. It also made
`sideEffects: []` false for this package.

A copy would not work either: vitest defines the chainable members of `it` as
accessors, so `Object.assign` silently drops `effect`, `live`, `each`, and the
rest. The proxy forwards reads with the original as the receiver, so those
accessors still see the `this` they expect.

The practical consequence: importing `it` from `@smthrs/testing/Vitest` changes
nothing for a file in the same worker that imports `it` from `@effect/vitest`.
Mixing the two in one suite is safe.
