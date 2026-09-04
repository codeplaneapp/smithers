---
title: "Forward logs to the run journal"
description: "Install JournalLogger.layerJournalForwarding so a run's Effect log records become durable telemetry.log entries, and read them back: capacity, bounds, redaction, and the three ways a record is lost."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/observability/docs/guides/forward-logs-to-the-journal.md"
---

`JournalLogger` turns a run's Effect log records into durable, structured
`telemetry.log` entries on that run's journal. It is the second delivery path
beside [OTLP export](/guides/export-to-a-collector/), and it is the one an operator
reads without a collector: the records land next to the run's lifecycle events
and are read back with the same `Journal.entries` call.

## Install the layer

The layer names one run, and requires a `Journal.Journal` service from
[`@smthrs/journal`](https://journal.smithers.sh/reference/api/):

```ts
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as JournalLogger from "@smthrs/observability/JournalLogger"
import * as Schema from "effect/Schema"

const runId = Schema.decodeUnknownSync(JournalEvent.RunId)("deploy-status-1")

const journalLogs = JournalLogger.layerJournalForwarding({ runId })
```

`runId` is branded, so it comes from decoding a string rather than from a bare
literal. Decoding it here means a malformed id is reported where it was
written.

Provide the layer over your journal. In a test, the deterministic bundle is
enough:

```ts
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import * as Layer from "effect/Layer"

const layer = Layer.provideMerge(journalLogs, TestJournal.layer())
```

In production, the journal is the one your durable engine already composed;
provide the forwarder over it the same way.

## Read the records back

Each record is one journal entry with `eventType` `telemetry.log`, written on
the journal's lossy channel by source `flows/observability/logger`. The payload
decodes with the exported schema:

```ts
import * as Journal from "@smthrs/journal/Journal"
import * as Effect from "effect/Effect"

const read = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const page = yield* journal.entries({ runId, limit: 200 })
  return page.entries
    .filter((entry) => entry.eventType === "telemetry.log")
    .map((entry) => Schema.decodeUnknownSync(JournalLogger.TelemetryLog)(entry.payload))
})
```

A decoded record carries the level, the logged message, the log annotations,
the fiber id, an ISO-8601 timestamp, the active span's `traceId` and `spanId`
when there was one, and a structural `cause` that preserves the order and the
kind of every failure reason:

```text
{
  version: 1,
  level: "Error",
  message: [ "deploy failed" ],
  annotations: { lane: "api", attempt: 2 },
  cause: {
    version: 1,
    reasons: [
      { _tag: "Fail", error: { code: "timeout" } },
      { _tag: "Interrupt", fiberId: 7 }
    ]
  },
  fiberId: 12,
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  timestamp: "2026-09-03T12:00:00.000Z"
}
```

The durable journal allocates the per-source sequence, so restarting the layer
or running two of them for one run cannot make two records collide on one
identity.

## Choose the queue depth

The logger callback never blocks. It snapshots the record synchronously, then
offers it to a bounded queue that a forked worker drains into the journal.

```ts
const journalLogs = JournalLogger.layerJournalForwarding({
  runId,
  capacity: 4096,
  minimumLogLevel: "Debug",
  mergeWithExisting: true
})
```

- `capacity` defaults to 256 and accepts 1 through
  `JournalLogger.maximumCapacity` (65,536). Raise it for a chatty run on a slow
  journal; a full queue drops the incoming record.
- `minimumLogLevel` pins `References.MinimumLogLevel` for the whole
  application. Omitted, the layer leaves that reference alone and Effect's own
  `Info` default applies.
- `mergeWithExisting` defaults to `false`, which replaces the ambient logger
  set. Pass `true` to keep a console logger alongside the forwarder. See
  [Install a logger](/guides/install-a-logger/).

An invalid run id or capacity fails layer acquisition with
`InvalidJournalLoggerOptions`, before any worker starts.

## What the snapshot does to a value

The record is detached, bounded, and redacted before it joins the queue, so
mutating a logged object after the log call cannot change what is persisted,
and a hostile value cannot stall the logger.

| Ceiling                  | Value | What happens past it                             |
| ------------------------ | ----- | ------------------------------------------------ |
| `maximumSnapshotBytes`   | 1 MiB | Text is cut and marked `[Truncated]`             |
| `maximumSnapshotMembers` | 4,096 | Remaining members become one `[Truncated]` entry |
| `maximumSnapshotDepth`   | 64    | Deeper values become `[Deep]`                    |

Values that cannot be read at all, such as a throwing accessor or a revoked
proxy, become `[Unrenderable]`. Functions, symbols, and binary data are named
rather than serialized (`[Function]`, `[Symbol]`, `[Binary]`), and a cycle
becomes `[Circular]`. Text is bounded in one pass that never cuts a surrogate
pair, so a truncated string is still well formed.

Container-shaped fields keep their shape. Annotations whose snapshot spent the
whole budget arrive as `{ "[Truncated]": "[Truncated]" }` rather than as a
scalar the schema would refuse. A projection that still fails `TelemetryLog`
degrades to a total record with an empty cause, so every durable
`telemetry.log` row decodes.

The journal's own redaction rules run before queue admission, the same scrub
durable events get, so a credential in a logged object never reaches a
permanent row.

## Watch for lost records

Forwarding is lossy on purpose: a telemetry backlog must not become application
backpressure. Three losses are possible, and each advances
`Metric.droppedLogRecords` (`flows/observability/log/dropped`):

1. **Queue overflow.** The queue was full when the record arrived. Counted only.
2. **Journal delivery failure.** The write failed. Counted, and reported as a
   warning annotated with the run id.
3. **A defect from the journal implementation.** Counted and warned the same
   way, and the worker keeps draining rather than dying silently for the rest
   of the run.

Those warnings are safe to emit because the worker is forked before the logger
it feeds is installed, so its ambient logger set cannot contain that logger and
a warning cannot enqueue itself.

Interruption stays fatal: closing the layer's scope ends the worker and can
drop records queued behind an in-flight write. Flush the journal before you
assert on a short-lived run.

A nonzero `droppedLogRecords` with a healthy journal usually means the capacity
is too small for the run's log volume. See
[Read the runtime metrics](/guides/read-runtime-metrics/) for how to read the
counter.
