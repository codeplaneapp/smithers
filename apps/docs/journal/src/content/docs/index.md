---
title: "@smthrs/journal"
description: "The Smithers event journal: the immutable history of a run, a durable lifecycle channel fenced on the run's owner, a lossy telemetry channel, and redaction applied once on the write path."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/journal/docs/README.md"
---

`@smthrs/journal` is the durable record of what happened during a run. It owns
two SQLite tables above the driver-neutral [`@smthrs/database`](https://database.smithers.sh/reference/api/)
contract, `flows_journal_events` and `flows_journal_checkpoints`, and exposes
them as one Effect service with two write channels.

The journal is Smithers' own logical write-ahead log. An entry is append-only,
permanent, and replayed verbatim to every reader: a follower, a projection, a
time-travel consumer, a support bundle. Three properties follow from that, and
they are what this package is for:

- **Two channels, chosen by the caller.** `emitDurable` commits before it
  returns, so a durable boundary can refuse to advance a run until its
  lifecycle entry is on disk. `emitLossy` is a bounded, optimistic queue for
  telemetry, where a `Dropped` receipt is an acceptable answer.
- **An owner fence on the durable channel.** `emitDurable`, `checkpoint`, and
  `compact` take an `OwnerId` and land only while the run still records that
  owner. A process that lost the run writes nothing.
- **Redaction on the write path.** Every payload passes one scrub before it is
  encoded, so a credential never reaches a permanent row that every reader
  replays.

Run and attempt state live in [`@smthrs/run-store`](https://run-store.smithers.sh/reference/api/), sealed
step results in [`@smthrs/step-cache`](https://step-cache.smithers.sh/reference/api/), and the durable
deferred and clock tables in [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/). This
package holds history and nothing else.

## Who uses this package

Engine and control-plane authors write lifecycle evidence through
`emitDurable` and keep it consistent with executable state through `transact`.
Read-path authors fold entries into a served view with `project`, or follow a
run with `stream`. Host authors install `RedactedLogger.layer()` so the
terminal gets the same redaction the durable rows get.

If you are writing a flow, you almost certainly reach the journal through the
engine rather than directly.

## Install

```bash
pnpm add @smthrs/journal
```

For the database layers a runnable composition adds, and for what a fenced
write needs on top, see [Installation](/installation/).

## The smallest real example

`emitDurableUnfenced` is the one write that needs nothing but the journal's own
tables, so it is the shortest end-to-end path:

```ts
import { Journal, JournalEvent } from "@smthrs/journal"
import * as Effect from "effect/Effect"

const runId = "run-1" as JournalEvent.RunId
const sourceId = "engine" as JournalEvent.SourceId

const program = Effect.gen(function*() {
  const journal = yield* Journal.Journal

  const receipt = yield* journal.emitDurableUnfenced({
    runId,
    sourceId,
    eventType: "run.created",
    payload: { flow: "build", apiKey: "sk-ant-not-persisted" }
  })

  const page = yield* journal.entries({ runId, limit: 100 })
  return { receipt, entries: page.entries }
})
```

The receipt is `Accepted` with the committed `seq`, and the entry read back
carries `payload.apiKey` as `"[REDACTED]"`: the credential was scrubbed before
the row was encoded. For the layers that make this run, see the
[Quickstart](/quickstart/).

## The package at a glance

The root entry point exports these namespaces, and each is also importable from
`@smthrs/journal/<Module>`:

| Namespace        | What it is                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Journal`        | The service: 12 operations over one run's history, plus the receipt, option, checkpoint, and error models.               |
| `JournalEvent`   | The event envelope: branded `RunId`, `Seq`, `SourceId`, `SourceSeq`, the `Input` and `Entry` schemas, and `makeEventId`. |
| `SqlJournal`     | The production layer over `@smthrs/database`, with the queue, byte, index, redaction, and compaction options.            |
| `OwnerId`        | The fencing token the durable channel accepts: `hostId`, `pid`, `nonce`.                                                 |
| `Redaction`      | The scrub applied to every payload before it is persisted, and the display-surface form for an already-encoded column.   |
| `RedactedLogger` | The same rules applied to log output, so a credential does not reach the terminal or an OTLP collector.                  |
| `Projection`     | A reproducible fold over entries: `{ name, initial, reduce }`.                                                           |
| `JournalMetrics` | The `flows_journal_writes` counter and its per-channel, per-receipt views.                                               |
| `Migrations`     | The journal's namespaced migration set, and the layer that installs it alone.                                            |

Two test doubles bind a Node SQLite database and therefore live under explicit
subpaths: `@smthrs/journal/test/TestJournal` and
`@smthrs/journal/test/Notifying`. The root itself bundles for the browser.

Every export, with signatures and error codes, is in the
[API reference](/reference/api/).

## Where to go next

- [Installation](/installation/): the database layers, the migration sets,
  and what a fenced write needs.
- [Quickstart](/quickstart/): write, flush, and read one run end to end.
- Concepts: [the two channels](/concepts/two-channels/),
  [the owner fence](/concepts/owner-fence/),
  [producer identity and idempotency](/concepts/idempotency/),
  [redaction](/concepts/redaction/), and
  [checkpoints and compaction](/concepts/compaction/).
- Guides: [write a fenced lifecycle event](/guides/write-lifecycle-events/),
  [commit state and its entry together](/guides/commit-state-and-entry/),
  [read and follow a run](/guides/read-a-run/),
  [fold a run into a projection](/guides/fold-a-projection/),
  [compact a long-running run](/guides/compact-a-run/),
  [keep credentials out of log output](/guides/redact-log-output/), and
  [test against a real journal](/guides/testing/).
- [Troubleshooting](/troubleshooting/): every `JournalError` code, what
  causes it, and what to change.

`@smthrs/chain` has a journal of its own, an in-process event array that is a
chain's only state. It is a different object with a different contract; see
[the chain journal](https://chain.smithers.sh/concepts/journal/).
