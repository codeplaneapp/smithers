---
title: "Wire protocol"
description: "The normative message shapes of the sync read path: scopes, cursors, read requests and responses, subscription frames, and the limits every side enforces."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sync/docs/protocol.md"
---

## Scopes and cursors

A client reads either one run or every run in a workspace:

```ts
import { SyncProtocol } from "@smthrs/sync"
import { Schema } from "effect"

const scope = Schema.decodeUnknownSync(SyncProtocol.RunScope)({
  _tag: "Run",
  runId: "build-42"
})
const cursor = Schema.decodeUnknownSync(SyncProtocol.RunCursor)({
  runId: "build-42",
  afterSeq: 17
})
```

A run cursor stores the last sequence the client was delivered. A workspace
cursor is an array of per-run cursors with at most one entry per run: a request
that names one run twice is refused with `invalid_request`, because the read
position and the echoed response state would otherwise disagree. Journal
sequences may have holes, so a cursor means "read entries after this number",
not "expect the next number to be exactly one greater".

## Read

`Sync.Read` accepts a scope, a cursor set, and a limit, and returns journal
entries plus the cursor set the page served through. `RunCatalog` supplies the
run list for workspace reads; `SyncServer.layer` combines it with `Journal`.

`limit` is bounded at `SyncProtocol.maxReadLimit`. A page is also bounded by
the encoded-entry ceiling, `maxFrameBytes`, which defaults to 1 MiB. The
ceiling is a budget on the page, not a verdict on the read: the server serves
entries until the next one would cross it, then returns `done: false` so the
client asks for the rest. Only a single entry whose own encoded size exceeds
the ceiling fails, with `frame_too_large`, because no page can carry it.

Persist the returned cursors only after applying the returned batch.

## Subscribe

`Sync.Subscribe` streams `Entries` frames, each carrying one run's entries and
the interval the server covered (`runId`, `fromSeq`, `toSeq`), and a terminal
`Closed` frame when the server ends the subscription. `fromSeq` and `toSeq`
describe the covered interval, not the sequences actually carried: dropped
admissions leave legitimate holes. No frame carries a cursor; a client tracks
its own, which is what `SyncClient` does.

The `Heartbeat` variant is RESERVED. No server emits one at 1.0.0-rc.0, so a
client must not wait for one; it stays in the union so adding it later is not a
wire break. Keepalive is a transport concern, because a heartbeat here would
spend the subscription's credit.

The request includes a credit count between 1 and
`SyncProtocol.maxSubscribeCredit`. Credit is a hard limit on frames emitted by
that subscription, not a sliding acknowledgement window, and there is no Ack
RPC. A client that needs more resubscribes from the cursors it has
acknowledged, which is what `SyncClient` does once per window.

A subscription also ends when the credential that opened it expires, with
`SyncError` code `unauthorized`. Authorization happens once, at open, so
without that deadline a signed expiry could not revoke a stream that simply
stayed connected.

`SyncClient.subscribe` wraps the RPC stream. It detects invalid cursor movement
as `SyncGapError`, refuses a frame or a catch-up page that contradicts itself
as a `protocol_violation`, reconnects transport failures under exponential
backoff capped at five seconds, and resumes from the cursors it has
acknowledged. Authentication is `SyncAuth`, and both are part of the package
rather than left to the application.

## Compacted runs

A cursor below a run's compaction floor names entries the journal has deleted.
The read or the subscription fails with `SyncError` code `compacted`, and the
error carries a `Resync` of `{ runId, checkpointSeq }`: the floor to resume
from. `SyncClient.subscribe` handles it rather than surfacing it. It moves that
run's cursor to `checkpointSeq` and restarts the subscription, so a workspace
subscription costs one reconnect per compacted run instead of dying over one of
them.

:::warning
The resync moves a cursor, not state. The entries below `checkpointSeq` are
never delivered, and no sync RPC serves the checkpoint state that stands for
them. `SubscribeOptions.onResync` runs before the cursor moves and must
succeed, so a consumer that cannot restore the prefix fails instead of silently
skipping it. A Node follower reads that prefix out of band with
`journal.latestCheckpoint(runId)`, applies `checkpoint.state`, and continues
from the sync stream. See [Checkpoints and compaction](https://journal.smithers.sh/concepts/compaction/).
:::

## Directionality

`SyncRpcs` is read only: `Sync.Read` and `Sync.Subscribe`. Client-to-server
submission is not planned work, it is `BranchRpcs`: `Branch.Submit` admits one
command onto a branch's journal run under a client-minted idempotency key, and
`Branch.Announce`, `Branch.Leave`, `Branch.Roster`, and `Branch.WatchRoster`
carry ephemeral presence. `BranchRpcs` has no production mount at
1.0.0-rc.0; the gateway serves `SyncRpcs` alone.

Bidirectional reconciliation of the read path, acknowledgement windows, and
resumable transport sessions remain unplanned.
