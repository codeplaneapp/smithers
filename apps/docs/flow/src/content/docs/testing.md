---
title: "Testing"
description: "Assert a body's topology without an engine, run a flow on the in-memory engine, prove a step replayed, drive a suspension with a test clock, and pin step identity."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/flow/docs/testing.md"
---

Flows are testable at three levels, and picking the right one keeps a test fast
and its failure legible.

| Level          | Reach for it when                                                               | What you need                                                  |
| -------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Topology       | The assertion is about the plan: node ids, edges, which arm exists.             | `Graph.build`. No engine, no crypto.                           |
| Interpretation | The assertion is about one drive: what settled, failed, or was skipped.         | `Interpreter.interpret`, action layers, a runtime.             |
| Execution      | The assertion is about the durable lifecycle: replay, suspension, cancellation. | `FlowEngine.layerMemory` from [`@smthrs/engine`](https://engine.smithers.sh/reference/api/). |

## Assert a body's topology

Building a plan is pure, so a topology test needs nothing but the declarations:

```ts
import { expect, it } from "@effect/vitest"
import { Graph } from "@smthrs/flow"

it("plans both checks before the report", () => {
  const graph = Graph.build(Gate, { target: "web" })
  const ids = Graph.nodes(graph).map((node) => node.id)

  expect(Graph.diagnostics(graph)).toEqual([])
  expect(ids).toContain("root.lint")
})
```

This is the level to test a refusal at, too: a body that computes on a planned
value throws a `GraphBuildError` from `Graph.build`, with no run in sight.

## Run a flow in memory

`FlowEngine.layerMemory` implements the whole `FlowRuntime` port in the process.
The composition is the production one with the engine swapped:

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const layer = Layer.mergeAll(
  Greet.toLayer(({ name }) => Effect.succeed(`Hello, ${name}.`)),
  Interpreter.layer(Greeting)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)
```

Use the real `NodeCrypto.layer` rather than a stub. Step identity is a digest,
and a fake digest tests a key derivation nobody ships.

## Prove a step did not run twice

Counting dispatches is the cheapest way to assert replay, and the counter lives
in the implementation rather than in the flow:

```ts
let calls = 0

const counted = Greet.toLayer(({ name }) =>
  Effect.sync(() => {
    calls += 1
    return `Hello, ${name}.`
  })
)

const countedLayer = Layer.mergeAll(counted, Interpreter.layer(Greeting)).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)

it.effect("dispatches the action once across two drives", () =>
  Effect.gen(function*() {
    const run = Effect.orDie(Greeting.execute({ name: "Ada" }, { executionId: "greet-1" }))
    yield* run
    yield* run

    expect(calls).toBe(1)
  }).pipe(Effect.provide(countedLayer)))
```

A later registration of one action tag replaces the earlier one, and closing the
registering scope restores what it replaced, so an override like `counted` is
scoped to the block that provided it.

## Drive a suspension

A flow that parks returns from `execute` while the run stays suspended. Test the
wake by completing the wait point and resuming:

```ts
import { DurableDeferred, WaitFor } from "@smthrs/flow"

const gate = WaitFor.deferred("ship")

it.effect("resumes when the wait point is completed", () =>
  Effect.gen(function*() {
    yield* Ship.execute({ build: "42" }, { executionId: "ship-1", discard: true })

    const token = DurableDeferred.tokenFromExecutionId(gate, { flow: Ship, executionId: "ship-1" })
    yield* DurableDeferred.succeed(gate, { token, value: { approved: true } })
    yield* Ship.resume("ship-1")

    expect(yield* Ship.poll("ship-1")).toMatchObject({ value: { _tag: "Complete" } })
  }))
```

`discard: true` answers with the execution id instead of waiting for the result,
which is what you want for a run you intend to park.

For a timer, drive the clock rather than the wall. Effect's `TestClock` advances
a `Sleep.action` or a `DurableClock.sleep` deterministically, and a test that
sleeps for real is a test that is slow and flaky in the same commit.

## Pin the identity

Step identity is a wire format: it outlives a process and decides whether a
result is found or recomputed. Pin the derivations you depend on with literal
vectors, so a change to how a step is keyed is a red test rather than a silent
cache miss:

```ts
import { StepIdentity } from "@smthrs/flow"

it.effect("keys a dispatch the way it always has", () =>
  Effect.gen(function*() {
    const scope = yield* StepIdentity.allocationScope({ kind: "action", name: "payments/Charge" })
    expect(scope).toBe("<the recorded digest>")
  }))
```

The same discipline applies to a completion token, a derived execution id, and a
child execution id digest. Each one is read by a process that did not write it.

## What this package's own suite proves

The `@smthrs/flow` suite combines pure schema, policy, and graph tests with
interpreted flows. Runtime cases drive declared bodies through
`Interpreter.layer` and read the durable record kept by the package's in-memory
`FlowRuntime` contract fixture, because this package deliberately depends on
nothing that executes flows.

Authoring is covered by flow definitions and their combinators, declared and
inline actions, action requirements, retry pinning, cache policy, file
boundaries, and step identity, including golden key vectors. Execution is
covered by execution-id derivation and its hostile-source cases, flow results and
their schema, suspension and nested suspension, cancellation, child boundaries
and trampoline handoffs, graph building, structural address collisions, placement
identity, scheduling priority, and the interpreter's own refusals. Durability is
covered by deferreds and their completion tokens, durable clocks, queues and
their workers, wait points, polling, human tasks and their attempt budget, and
sleeps. Wire formats that outlive a process are pinned by literal: the base64url
completion token, the derived execution-id preimage, and the child execution-id
digest.

Adversarial cases sit beside the ordinary ones rather than in a separate file. A
completion token is refused when it names a deferred other than the one it was
submitted through. A human answer is admitted only while the run is parked on
that exact approval token, so unopened and stale attempts cannot create a
completion. Retry policy, sleeps, deadlines, and queue concurrency each refuse a
non-finite or out-of-range value instead of arming a timer nobody wakes.
Diagnostics that quote author data are bounded, and placement and payload
inspection never run accessors.

## Related pages

- [Inspect the plan a body builds](/guides/inspect-the-plan/): the accessors a
  topology test reads.
- [The runtime port](/concepts/the-runtime-port/): what the in-memory engine
  is standing in for.
