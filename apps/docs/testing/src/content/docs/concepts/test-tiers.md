---
title: "Test tiers"
description: "Why a harness in @smthrs/testing is a layer set rather than a class: the unit tier, the plan-time poison tier, the fault tier, and the runner boundary that turns any of them into registered tests."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/testing/docs/concepts/test-tiers.md"
---

A harness here is not a class with lifecycle methods. It is a set of Effect
layers, and choosing a tier means choosing which layers to provide. There is no
`setup()` to call and nothing to tear down: a tier is a value, a test body runs
under it, and the scope that built it closes when the case ends.

Three tiers exist, and they differ only in what they provide.

## The unit tier

`TestLayers.unit(engine)` bundles a deterministic Host from
[`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/), an in-memory Journal from
[`@smthrs/journal`](https://journal.smithers.sh/reference/api/), the engine subject under test, and the
**real** permission kernel:

```ts
import { EngineSubject, TestLayers } from "@smthrs/testing"

const layer = TestLayers.unit(EngineSubject.layerNoop())
```

The kernel is real on purpose. A permission decision a test stubs out is a
decision the test no longer covers, so `GrantStore` runs here exactly as it
runs in production, with one difference: it is built unattended, so a sealing
violation fails typed instead of parking on an approval nobody will answer.

## The plan-time tier

Plan-time computation must never touch the host, the model, the clock, or
randomness. `TestLayers.poisoned` proves it by providing services that reject
rather than answer, and `PlanAssertions.expectPure` reports any escape as a
`purity_violation` carrying the original typed error:

```ts
import { Plan, PlanAssertions, TestLayers } from "@smthrs/testing"
import * as Effect from "effect/Effect"

const built = PlanAssertions.expectPure(Plan.planOf(review, { pr: 4821 })).pipe(
  Effect.provide(TestLayers.poisoned)
)
```

Rejection is a **defect**, never a recoverable failure, and that distinction is
the whole design. Two earlier shapes were unsound:

- A service that answered every property with a function made a synchronous
  data read succeed. `Path.sep` came back as a function rather than `"/"`, so
  code that interpolated it produced garbage and the purity gate reported
  nothing.
- A service whose methods returned `Effect.fail` made the refusal catchable. A
  plan body that wrapped a host read in `Effect.catch`, `Effect.option`, or
  `Effect.result`, which is ordinary in fallback-shaped code, swallowed the
  violation, and the purity gate reported the plan as pure.

The poisoned services throw a `CapabilityContractError` from the property
getter instead. It fires on a data read as loudly as on a method call, and
`Effect.catchTag` cannot reach it. A small set of property names answers
`undefined` rather than throwing, because a runtime reads them to classify a
value rather than to use it: `then`, `toJSON`, `valueOf`, `$$typeof`,
`asymmetricMatch`, and the rest. That is what lets a poisoned service still be
stored, logged, and awaited past.

`Clock` and `Random` are `Context.Reference`s with ambient defaults, so their
poisoning can never appear in a layer's output type.
`TestLayers.poisonedClockAndRandom` is exported separately for that reason:
provide it beneath a bundle and an unprovided time or randomness read fails
loudly instead of silently using the Effect default.

## The fault tier

`@smthrs/testing/Faults` is the opposite of a double. `killProcess` sends a
real signal to a real pid and waits for the operating system to reap it;
`parentPid` and `waitForReparent` read the orphan a kill leaves behind; and
`skewClock` moves the wall clock a durable timer is measured against.

Because those effects are machine global, a fault suite is its own tier: it
lives in the package's `test/faults` tree, behind a `Smithers.FaultSuite`
target and a `vitest.faults.config.ts` with `fileParallelism: false`. Two
suites that spawn and kill processes cannot share a worker, because pids,
ports, and process groups are process global.

This package's own `Faults` suite is the exception and stays in `test/`. It
signals only pids it spawned itself, so it can reach no neighbouring suite, and
staying there is what keeps `src/Faults.ts` inside the package's 100% coverage
denominator.

See [Inject a real process fault](/guides/inject-a-process-fault/).

## The runner boundary

`Vitest` is the only module in this package that imports a test runner, and
that boundary is the only sanctioned `AbortSignal` touch: runner cancellation
is converted to fiber interruption at the edge, and the signal never crosses
into Effect code.

`Vitest.testEffect(layer)` builds a **fresh** environment from the supplied
layer for every case and runs each body in its own `Scope`, so no state is
shared between tests and no test can depend on registration order. The variants
differ only in the clock:

- `.effect` and its alias `.scoped` add a `TestClock`, so a body controls
  virtual time. The conformance race and interrupt pins require this.
- `.live` runs on the real clock, with only `TestConsole` added.

`scoped` is an alias rather than a third registrar. Every variant already wraps
its body in `Effect.scoped`; the name is kept because a scoped body reads
better under it.

The module's exported `it` is a fresh callable over `@effect/vitest`'s, built
as a `Proxy` rather than a copy.
[Register an Effect test body](/guides/register-effect-tests/) explains why
that matters for anyone importing it.
