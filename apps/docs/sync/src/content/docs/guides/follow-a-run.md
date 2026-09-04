---
title: "Follow a run"
description: "Compose a sync client over a transport, subscribe to one run or a whole workspace, acknowledge entries only after applying them, and persist a cursor a restart can resume from."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sync/docs/guides/follow-a-run.md"
---

This guide builds a follower: the side that reads. It assumes a host is already
serving `SyncRpcs`, whether that is [`@smthrs/gateway`](https://gateway.smithers.sh/reference/api/) on
`POST /sync` and `/sync/ws` or a host of your own.

## Provide the client

`SyncClient.layer` derives an RPC client from the ambient
`RpcClient.Protocol`, so the composition supplies the protocol and the
serialization:

```ts
import * as SyncClient from "@smthrs/sync/SyncClient"
import * as Layer from "effect/Layer"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import type * as Socket from "effect/unstable/socket/Socket"

export const clientLayer: Layer.Layer<SyncClient.Sync, never, Socket.Socket> = SyncClient.layer.pipe(
  Layer.provide(RpcClient.layerProtocolSocket()),
  Layer.provide(RpcSerialization.layerJson)
)
```

Supply the socket that protocol runs over from your platform. A browser
follower provides a WebSocket; a Node follower provides
`@effect/platform-node`'s socket layer; a test provides the in-memory pair from
[Test a follower](/guides/test-a-follower/).

To tune the catch-up page size or the frame ceiling the client enforces on
responses, build the service directly with `SyncClient.make` instead:

```ts
import { SyncRpcs } from "@smthrs/sync/SyncRpcs"
import * as Effect from "effect/Effect"
import * as RpcClient from "effect/unstable/rpc/RpcClient"

const makeClient = Effect.flatMap(
  RpcClient.make(SyncRpcs),
  (client) => SyncClient.make({ client, bootstrapLimit: 512 })
)
```

## Subscribe

One call runs both phases. The stream starts with durable history and continues
with live entries:

```ts
import type { JournalEvent } from "@smthrs/journal"
import * as Stream from "effect/Stream"

const runId = "build-42" as JournalEvent.RunId

const entries = Effect.gen(function*() {
  const sync = yield* SyncClient.Sync
  return sync.subscribe({ scope: { _tag: "Run", runId }, cursors: [] })
})
```

Pass `{ _tag: "Workspace" }` to follow every run the catalog lists and your
credential covers. A workspace subscription reconciles its covered run set on
every round, so a run created after it opened joins it.

## Acknowledge only what you applied

By default the cursor advances as an entry is handed to the consumer. If your
consumer writes somewhere durable, supply `apply` so the cursor advances only
after that write succeeds:

```ts
const followed = Effect.gen(function*() {
  const sync = yield* SyncClient.Sync
  return sync.subscribe({
    scope: { _tag: "Run", runId },
    cursors: [],
    apply: (entry) => Effect.logInfo(`applied ${entry.eventType}@${entry.seq}`)
  })
})
```

A failure in `apply` fails the subscription with that entry unacknowledged, so
the next subscription delivers it again. Make the callback idempotent:
redelivery is what a retry looks like here.

## Resume after a restart

`client.cursors` reports the acknowledged position, one entry per run, sorted
by run id. Persist it after the work it stands for, and hand it back on the
next subscription:

```ts
const resume = (saved: ReadonlyArray<{ readonly runId: JournalEvent.RunId; readonly afterSeq: JournalEvent.Seq }>) =>
  Effect.gen(function*() {
    const sync = yield* SyncClient.Sync
    return sync.subscribe({ scope: { _tag: "Workspace" }, cursors: saved })
  })
```

The effective start position is the later of your cursor and what this client
has already acknowledged. To replay from an earlier position, build a fresh
client: its acknowledged map is empty, so your cursor is the only one there is.

## Present a credential

A connection with no credential reads no non-branch run. Stamp every outgoing
request with a workspace capability:

```ts
import * as SyncAuth from "@smthrs/sync/SyncAuth"
import type * as WorkspaceShare from "@smthrs/sync/WorkspaceShare"

const authorized = (capability: WorkspaceShare.WorkspaceCapability) =>
  SyncClient.layer.pipe(Layer.provide(SyncAuth.layerClient(capability)))
```

To read a shared branch instead, pass that branch's capability on the
subscription itself as `capability`. See
[Authorize a connection](/guides/authorize-a-connection/).

## Handle the failures that reach you

The stream fails with `SyncError` or `SyncGapError`. The client already absorbs
two cases, so what reaches you is deliberately short:

- `transport_failed` is retried under exponential backoff capped at five
  seconds and only surfaces if the stream is otherwise ended.
- `compacted` is recovered by moving that run's cursor to the checkpoint the
  server named and restarting. See
  [Handle a compacted run](/guides/handle-a-compacted-run/).

Everything else is yours:

| Failure              | What it means                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `SyncGapError`       | The server's frame started beyond the cursor you covered. History was missed; rebuild rather than retry. |
| `unauthorized`       | No credential, a refused one, or a credential that expired while the subscription was open.              |
| `protocol_violation` | The server's page or frame contradicted itself. No cursor moved.                                         |
| `frame_too_large`    | A page or frame exceeded the client's frame ceiling.                                                     |
| `closed`             | The server ended the subscription with a `Closed` frame.                                                 |

[Troubleshooting](/troubleshooting/) has the full code table with causes and
fixes.

## Tune the window

`credit` bounds the frames one subscription round carries before the follow
replenishes it by resubscribing. The default is 256, and the ceiling the wire
allows is `SyncProtocol.maxSubscribeCredit`:

```ts
const narrow = Effect.gen(function*() {
  const sync = yield* SyncClient.Sync
  return sync.subscribe({ scope: { _tag: "Run", runId }, cursors: [], credit: 32 })
})
```

Lower it only for a deliberate reason. A small window makes the round-trip cost
proportional to traffic rather than to the window, which is what
[Replay then follow](/concepts/replay-then-follow/) explains.
