---
title: "Observe store outcomes"
description: "Read the fencing counters and spans the stores emit: the three counters and their attributes, what a span carries, how to wire an exporter, and how to assert on a counter in a test."
sidebar:
  order: 6
---

A lost fence is a normal success value, so it never reaches an error channel and
never appears in a log by default. The stores publish it as telemetry instead:
every claim, heartbeat, and transition updates an attributed counter and closes a
span that says how it ended. Wire an exporter once and "who keeps stealing this
run" becomes a query rather than a grep.

## The three counters

`RunStoreMetrics` defines the handles, and `RunStore` updates them as it decides
each outcome. Every driver that writes through the store lands in the same
counters.

| Counter                 | Attributes      | What it counts                                                     |
| ----------------------- | --------------- | ------------------------------------------------------------------ |
| `flows_run_claims`      | `op`, `outcome` | Every ownership compare-and-swap, across all six claim operations. |
| `flows_run_heartbeats`  | `outcome`       | Every fenced ownership heartbeat.                                  |
| `flows_run_transitions` | `outcome`, `to` | Every fenced owned transition, by requested target status.         |

`op` is the operation in snake case: `claim`, `claim_and_own`, `activate`,
`abandon_claim`, `recover_claim`, or `steal`. `outcome` is the result tag in
snake case, so `HeartbeatFresh` is recorded as `heartbeat_fresh`. `to` on a
transition is the target status you asked for, whether or not the write won.

Three of those series are the ones worth alerting on:

- `flows_run_heartbeats{outcome="fence_lost"}` is the fencing event: an owner
  discovered another process holds its run.
- `flows_run_claims{op="activate",outcome="claim_lost"}` means a held claim was
  recovered or replaced before its activation ran.
- `flows_run_claims{op="steal",outcome="claimed"}` is a takeover. A steady rate
  of these is a host that keeps dying, or two hosts with clocks far enough apart
  to take runs from each other.

A terminal transition also advances `runThroughput` from
[`@smthrs/observability`](/api/observability), published as
`flows/run/throughput`, so finished runs are counted in the same place as the
rest of the runtime. See
[Read the runtime metrics](/pkg/observability/guides/read-runtime-metrics).

Throughput advances only after the outermost managed `DurableWriter.write`
commits. Rolled-back savepoints and retried transactions do not count; the
final committed transition counts once. Use the shared writer for this metric:
raw SQL transactions do not provide a managed commit notification.

## Wire an exporter

This package ships no exporter. It defines counters and updates them, so they
appear in whatever registry the composition provides:

```ts
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"

const registry = Layer.succeed(Metric.MetricRegistry)(new Map())
```

Provide `@smthrs/observability`'s exporter layer instead when you want the
counters to leave the process. Nothing about the stores changes either way: an
unprovided registry costs a map write and is dropped.

## Read a counter directly

Each exported record maps an outcome tag to an attributed view of its counter, so
reading one is a lookup rather than a filter:

```ts
import { RunStoreMetrics } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"

const fenceLosses = Effect.map(
  Metric.value(RunStoreMetrics.heartbeat.FenceLost),
  (state) => state.count
)
```

The same shape works for `RunStoreMetrics.claim`, `claimAndOwn`, `activate`,
`abandonClaim`, `recoverClaim`, `steal`, and `transition`. Each record's keys are
exactly the outcome tags of the matching operation, so a new outcome cannot be
added without a key to count it under.

`transition` is the one exception to "look it up and read it": `RunStore` adds the
`to` attribute at the update site, because the target status is call input rather
than a closed set the metrics module should restate. Add the same attribute to
read a single target:

```ts
const completedTransitions = Metric.value(
  Metric.withAttributes(RunStoreMetrics.transition.Transitioned, { to: "completed" })
)
```

## Read the spans

Every store operation runs inside a span named after it, `RunStore.claim`,
`AttemptStore.finish`, and so on. Two annotations are on all of them:

- `runId`, and the acting identity's host as `ownerHostId`, `claimantHostId`, or
  `observerHostId` depending on the operation.
- `outcome`, written when the span closes. A success carries its outcome tag in
  snake case, or `success` for `create` and `get`, which have no domain outcome.
  A failed effect carries `failure`, and an interrupted one carries `interrupt`,
  so no span ever closes without saying how it ended.

Failure causes are published to logs, spans, and telemetry, so they carry field
names, lengths, and validity flags and never the value that failed. A
`decode_failed` cause names the invariants the row broke, not its executable
state. See [Durable values](../concepts/durable-values.md).

## Assert on a counter in a test

Provide a registry, run the work, and read the count:

```ts
import { RunStore, RunStoreMetrics } from "@smthrs/run-store"
import * as TestRunStore from "@smthrs/run-store/test/TestRunStore"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"

const lostFences = Effect.gen(function*() {
  const runs = yield* RunStore.RunStore
  yield* runs.heartbeat("missing-run", { hostId: "host-a", pid: 1, nonce: "n" }, 0)
  return yield* Metric.value(RunStoreMetrics.heartbeat.NotFound)
}).pipe(
  Effect.provide(TestRunStore.layer),
  Effect.provideService(Metric.MetricRegistry, new Map()),
  Effect.scoped
)
```

Counting outcomes is how a test proves a race resolved the way it claims: a
takeover test that asserts one `steal` `claimed` and one `heartbeat`
`fence_lost` has pinned both halves of the exchange.

## Next steps

- [Test against the real stores](./testing.md): the layer used here.
- [Troubleshooting](../troubleshooting.md): what each outcome means when it is
  the one you did not expect.
