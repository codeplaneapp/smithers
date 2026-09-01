---
description: "Read-only journal replication: cursor-based reads and credit-bounded subscriptions over Effect RPC."
---

# Journal synchronization

This page defines the current journal replication protocol in `@smthrs/sync`: cursor-based reads and credit-bounded subscriptions over Effect RPC. It does not describe bidirectional event writes.

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

A run cursor stores the last observed sequence. A workspace cursor is an array of per-run cursors. Because journal sequences may have holes, a cursor means “read entries after this number,” not “expect the next number to be exactly one greater.”

## Read

`Sync.Read` accepts a scope, cursor, and limit and returns journal entries plus the next cursor. `RunCatalog` supplies the run list for workspace reads; `SyncServer.layer` combines it with `Journal`.

The server merges workspace entries deterministically. Consumers should persist the returned cursor only after applying the returned batch.

A page is also bounded by the encoded-entry ceiling, `maxFrameBytes`, which defaults to 1 MiB. The ceiling is a budget on the page, not a verdict on the read: the server serves entries until the next one would cross it, then returns `done: false` so the client asks for the rest. Only a single entry whose own encoded size exceeds the ceiling fails, with `frame_too_large`, because no page can carry it.

## Subscribe

`Sync.Subscribe` streams:

- `Entries` frames with events and the next cursor,
- `Heartbeat` frames when no entries arrive,
- one terminal `Closed` frame.

The request includes a credit count. Credit is a hard limit on frames emitted by that subscription, not a sliding acknowledgement window. There is currently no Ack RPC. A client that needs more data opens another subscription from the last durable cursor.

`SyncClient.subscribe` wraps the RPC stream and detects invalid cursor movement as `SyncGapError`. Transport, authentication, and reconnect policy remain application concerns.

## Compacted runs

A cursor below a run's compaction floor names entries the journal has deleted. The read or the subscription fails with `SyncError` code `compacted`, and the error carries a `Resync` of `{ runId, checkpointSeq }`: the floor to resume from. `SyncClient.subscribe` handles it rather than surfacing it. It moves that run's cursor to `checkpointSeq`, logs the skipped range, and restarts the subscription, so a workspace subscription costs one reconnect per compacted run instead of dying over one of them.

:::warning
The resync moves a cursor, not state. The entries below `checkpointSeq` are never delivered, and no sync RPC serves the checkpoint state that stands for them. A follower rebuilding a projection from scratch reads that prefix out of band: `journal.latestCheckpoint(runId)`, apply `checkpoint.state`, then continue from the sync stream. See [Checkpoints and compaction](/compaction).
:::

## Authentication

`SyncAuth` is an Effect RPC middleware service, and the package ships its production implementation: `SyncAuth.layer` verifies a `WorkspaceShare` capability, the branch share scheme extended with a signed `kid` for key rotation, presented in the `flows-sync-workspace` request header, and installs the resulting `SyncPrincipal` for the request. The principal defaults to anonymous, and the server refuses anonymous access to every non-branch run and to workspace listings, so an unauthenticated connection can read only branch runs it holds a branch share capability for. Signing secrets are provisioned as `Redacted` values through `WorkspaceShare.layerHmac` (explicit keyring) or `WorkspaceShare.layerConfig` (`FLOWS_SYNC_SECRET`, `FLOWS_SYNC_KEY_ID`); there is no default secret. A deployment may substitute its own `SyncAuth` implementation at the transport boundary.

## Directionality

Current RPCs are read-only: `Read` and `Subscribe`. Client-to-server event submission, bidirectional reconciliation, acknowledgement windows, and resumable transport sessions are **Planned**.

See [Journal](/concepts/journal) and the [`@smthrs/sync` reference](/api/sync).
