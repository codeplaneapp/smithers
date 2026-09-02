---
description: "What you can see while a flow runs: journal queries, spans, metrics, logs, and the debugging layers that ship."
---

# Observability

What you can see while a flow runs, and what you cannot. This page lists only surfaces that exist in `packages/*/src` today. Everything absent is named at the bottom rather than left implied.

## The journal is the primary surface

Most of what you would want from an observability stack is already a durable row. Lifecycle evidence goes through `emitDurable`, so it is committed in the same transaction as the state it describes and cannot be dropped.

| Question                            | Query                                      |
| ----------------------------------- | ------------------------------------------ |
| what happened to this run, in order | `Journal.entries({ runId, limit })`        |
| what is happening now               | `Journal.stream({ runId, afterSequence })` |
| a derived view over history         | `Journal.project(projection, options)`     |
| the same from another process       | `@smthrs/sync` `Read` and `Subscribe`      |
| the state at a past point           | `TimeTravel.inspect(position, projection)` |
| the resync point of a compacted run | `Journal.latestCheckpoint(runId)`          |

The engine event types are listed in [Data structures](/data-structures). Filtering on `event_type` is indexed.

Three properties matter when you build on this. Entries publish after COMMIT, so a subscriber never sees an entry that later rolls back. Sequences may have holes, so a reader follows cursors rather than assuming adjacency. A compacted run reports itself: a read whose cursor starts below the compaction floor fails with a `compacted` error carrying the checkpoint to resync from. See [Checkpoints and compaction](/compaction).

## Redaction

`Redaction` runs at the single `payload` and `meta` encode chokepoint. `defaultRules` plus `isSensitiveKey` decide what is replaced with the placeholder, and `SqlJournal.layer` takes a `redact` option including an opt-out.

Executable state is deliberately outside that chokepoint. Run state, attempt checkpoints, errors, outcomes and metadata, and cache results round-trip verbatim, because rewriting them resumes a flow with the wrong data and can make persisted state fail to decode.

:::danger
Redaction does not cover executable state. A secret that must not persist belongs in a `Redacted` field of the caller's own state schema.
:::

## Tracing

`@smthrs/flow` and `@smthrs/engine` open the spans below through Effect's tracer. These packages install no exporter. Provide one from your application and these spans appear in it; [`@smthrs/observability`](/api/observability) is the shipped default, wired on [Telemetry](/telemetry).

| Span                         | Attributes                                                  | Source                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `<FlowTag>.execute`          | `executionId`                                               | `@smthrs/flow` `Flow/make.ts`                                                                                                   |
| `<FlowTag>.poll`             | `executionId`                                               | `@smthrs/flow` `Flow/make.ts`                                                                                                   |
| `<FlowTag>.interrupt`        | `executionId`                                               | `@smthrs/flow` `Flow/make.ts`                                                                                                   |
| `<FlowTag>.resume`           | `executionId`                                               | `@smthrs/flow` `Flow/make.ts`                                                                                                   |
| `Action.execute`             | `executionId`, `action`, `attempt`, `tier`, `outcome`       | `@smthrs/flow` `Action/make.ts`, around every action dispatch; the computed key is on its `FlowEngine.actionExecute` child span |
| `FlowEngine.deferredResult`  | `name`, `executionId`                                       | `@smthrs/engine` `FlowEngine/make.ts`                                                                                           |
| `FlowEngine.deferredDone`    | `name`, `executionId`                                       | `@smthrs/engine` `FlowEngine/make.ts`                                                                                           |
| `FlowEngine.scheduleClock`   | `executionId`, `name`                                       | `@smthrs/engine` `FlowEngine/make.ts`                                                                                           |
| `DurableQueue/<name>/worker` | parented to the offering span through `Tracer.externalSpan` | `@smthrs/flow` `DurableQueue.ts`                                                                                                |

The store packages open one `Effect.fn` span per service operation, named `Module.method` (`RunStore.claim`, `CacheStore.get`, `Journal.emitDurable`, `ActionPersistence.execute`, `PlanScheduler.dispatch`, `WorkspaceSandbox.materialize`, `TimeTravel.fork`, `BranchShare.verify`, `SandboxHealth.probe`, and so on). Every hot-path span annotates the identifiers a debugger needs, as the operation's first statement (`Effect.annotateCurrentSpan`). Values computed mid-operation, such as a key digest or a diff identity, are annotated the moment they exist:

| Path                                                                | Attributes                                                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| dispatch (`FlowEngine.actionExecute`, `ActionPersistence.execute`)  | `runId`, `key`/`keyDigest`, `attempt`, `tier`, `outcome`; child boundary and sandbox spans inherit the dispatch identity |
| scheduler (`PlanScheduler.run`/`.dispatch`)                         | `runId`, `planId`, `admissions`, `nodeId`, `dispatchKey`, `attempt`, `outcome`                                           |
| claims and transitions (`RunDriver.claimAndActivate`, `RunStore.*`) | `runId`, `status`, `outcome`, the CAS target and claimant                                                                |
| attempts (`AttemptStore.*`)                                         | `runId`, `stepKeyDigest`, `attempt`                                                                                      |
| cache (`CacheStore.*`, remote and combined tiers)                   | `keyDigest`                                                                                                              |
| boundary and sandbox (`StepBoundary.*`, `WorkspaceSandbox.*`)       | `boundaryMode`, read/write/change counts, `diffIdentity`, `path`                                                         |
| journal (`Journal.*`)                                               | `runId`, `sourceId`, `eventType`, cursors                                                                                |
| time-travel (`TimeTravel.*`, `TimeTravelStore.*`)                   | `runId`, `lineageId`, `seq`                                                                                              |
| sync (`BranchShare.*`, `BranchPresence.*`, `BranchCommands.*`)      | `branchId`, `participantId`, `access`; never capability material                                                         |

The explicit `Effect.withSpan` and `useSpan` sites set `captureStackTrace: false`; `Effect.fn` spans keep Effect's default capture behavior. The queue worker is the one place trace context crosses a durable boundary: the offer records `traceId`, `spanId`, and `sampled` on the item, and the worker reattaches to that external span, so a persisted queue item stays connected to the flow that offered it.

## Metrics

The store packages define `Metric` handles beside the code that updates them, one `<Service>Metrics` module per package: journal write receipts, durable write replays, run claim and heartbeat and transition outcomes (fencing events included), step-cache lookups and recordings, artifact puts and gets, and, through `EngineStoreMetrics`, the engine-store hot paths: dispatch outcomes with a latency histogram, effective step-cache decisions after verification and materialization, scheduler admissions, per-dispatch latency and per-node outcomes, sandbox executions and materializations with their copy-back conflicts, boundary settlements by classification, and the run driver's claim decisions. `@smthrs/observability/Metric` adds the cross-package run-throughput, active-seat, and quota-park signals at their production seams. Durations land in `Metric.timer` histograms through Effect's own `Effect.trackDuration`, and outcome counters observe the exit through `Effect.onExit`, so instrumentation can never alter a result or a cause. [Telemetry](/telemetry) tables every series with its attributes and shows the export wiring. The handles themselves are exported, so a program can read them with `Metric.value` without any exporter.

:::warning
Read an outcome-dimensioned counter through its tagged attribute view (`CacheStoreMetrics.hit`, `EngineStoreMetrics.dispatch.Success`). The bare counter handle reads the attribute-less series the packages never update, which stays at zero.
:::

## Logging

Logging is sparse and deliberate. The engine logs where an operator needs to know something the error channel cannot carry.

| Log                                | Level   | Meaning                                                                                                            |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| unregistered flow on wake          | warning | a sweeper found a parked run for a flow this process never registered; the row stays parked, once per run          |
| sweeper defect                     | warning | a transient failure escaping the sweep, retried next tick                                                          |
| deferred persistence failure       | warning | a lossy-sink failure after the durable completion already committed                                                |
| queue worker failure               | warning | a worker handler cause, before the loop continues                                                                  |
| journal auto-compaction failure    | warning | a compaction-policy attempt failed or was refused; damped and retried after the next threshold                     |
| time-travel anchor refresh failure | warning | a fork or rewind proceeds on the last recorded anchors; the cause travels structurally, `runId` in the annotations |
| run claim decisions                | debug   | steal refused, claim lost, or activation lost, with the store outcome                                              |
| run activated                      | debug   | a drive claimed and re-entered a run, with its flow name                                                           |
| action dispatch lifecycle          | trace   | a durable dispatch started or settled, with run, key, attempt, tier, and outcome context                           |
| scheduler lifecycle                | debug   | a plan run started or completed, with its plan identity and settlement totals                                      |
| scheduler admission launched       | debug   | one admission pass that opened dispatch permits: admission, ready, admitted, agents, in-flight counts              |

Ambient log context rides on `Effect.annotateLogs`: the run driver annotates `runId` across an entire drive (every log a flow body emits inherits it), `ActionPersistence` annotates `runId` across a dispatch, and `PlanScheduler` annotates `runId` and `planId` across a plan run. `DurableQueue` (`package`, `module`, `fiber`, `queueName`) and `FlowProxyServer` annotate their own fibers as before.

## Debugging aids

| Aid                                    | Where                                  | Use                                                                                    |
| -------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------- |
| `Notifying.wrap` and `Notifying.layer` | `@smthrs/journal/test/Notifying`       | inject a crash or fence loss at a chosen interstitial around any Effect service        |
| `TestHost.layer`                       | `@smthrs/kernel/test/TestHost`         | in-memory filesystem, scripted command interpreter, seeded random, deterministic clock |
| `TestJournal.layer()`                  | `@smthrs/journal/test/TestJournal`     | the SQL journal over in-memory SQLite                                                  |
| `TestStores.layer()`                   | `@smthrs/engine-store/test/TestStores` | the four SQL stores over ONE in-memory SQLite database                                 |
| `TestDatabase.layer`                   | `@smthrs/database/test/TestDatabase`   | in-memory SQLite                                                                       |
| `TestSocket.makePair`                  | `@smthrs/sync/test/TestSocket`         | a fault-injecting socket pair for sync                                                 |
| `DurableEngineState.layerMemory`       | `@smthrs/engine-store`                 | deterministic waits with no database                                                   |
| `Inconsistency.layerStrict`            | `@smthrs/engine-store`                 | fail the run on a cache conflict rather than continuing                                |
| stable error codes                     | `EngineStore.Errors`                   | switch on `code` or `_tag` when triaging                                               |

## What is missing

| Surface                                                                                      | Status                                                             |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Gauges (queue depths, roster sizes); the shipped series are counters and duration histograms | Planned                                                            |
| A run inspector or dashboard                                                                 | Planned; the journal and sync are the substrate one would build on |
| Structured audit of permission decisions beyond the grant events                             | Planned                                                            |

Latency histograms and store-span attributes, formerly listed here as planned or absent, shipped: dispatch, scheduler-dispatch, and sandbox durations are `Metric.timer` histograms in `EngineStoreMetrics`, and the store spans carry the identifier attributes tabled under Tracing above.

Journal checkpointing and compaction, formerly listed here as planned, shipped in `@smthrs/journal`: [Checkpoints and compaction](/compaction).
