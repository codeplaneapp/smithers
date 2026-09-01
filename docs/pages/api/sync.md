---
description: "Read-only journal replication over Effect RPC, plus the branch protocol for shared run views."
---

# @smthrs/sync

Read-only journal replication over Effect RPC, plus a branch protocol for shared, presence-aware run views.

:::note
Nothing in this package mutates a run. Mutation, resume, and permission decisions are outside the protocol on purpose.
:::

```ts
import { SyncClient } from "@smthrs/sync"
import * as Effect from "effect/Effect"

const frames = Effect.gen(function*() {
  const sync = yield* SyncClient.Sync
  return sync.subscribe({ scope: { _tag: "Run", runId: "build-42" }, cursors: [] })
})
```

## Entry points

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/sync` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/index.ts) | any |
| `@smthrs/sync/test/TestSync` | [src/test/TestSync.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/test/TestSync.ts) | any |
| `@smthrs/sync/test/TestSocket` | [src/test/TestSocket.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/test/TestSocket.ts) | any |

## SyncProtocol

[src/SyncProtocol.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/SyncProtocol.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Scope`, `RunScope`, `WorkspaceScope` | schemas + type | one run, or every run in a workspace |
| `RunCursor`, `WorkspaceCursor` | schemas + types | `afterSeq` per run |
| `Resync` | schema + type | `runId` plus `checkpointSeq`, the floor a compacted run resumes from |
| `ReadRequest`, `ReadResponse` | schemas + types | catch-up; `done: false` means another page follows |
| `SubscribeRequest` | schema + type | includes a credit count |
| `Frame`, `EntriesFrame`, `HeartbeatFrame`, `ClosedFrame` | schemas + types | subscription frames |
| `covers` | predicate | whether a cursor covers an entry |
| `defaultMaxFrameBytes`, `encodedByteLength` | const + function | the 1 MiB ceiling both ends enforce, and the UTF-8 JSON byte length it measures |

:::warning
Credit is a hard limit on frames emitted by one subscription. There is no acknowledgement RPC, so a client that needs more opens another subscription from its last durable cursor.
:::

## SyncRpcs, SyncServer, SyncClient

| Export | Source | Notes |
| --- | --- | --- |
| `SyncRpcs.SyncRpcs`, `SyncAuth` | [src/SyncRpcs.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/SyncRpcs.ts) | `Read` and `Subscribe`; `SyncAuth` is the RPC middleware; `SyncAuth.layer` in [src/SyncAuth.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/SyncAuth.ts) is the shipped header-verifying implementation |
| `WorkspaceShare.WorkspaceShare`, `Service`, `WorkspaceClaims`, `WorkspaceCapability`, `Keyring`, `makeHmac`, `layerHmac`, `layerConfig`, `layerNoop` | [src/WorkspaceShare.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/WorkspaceShare.ts) | workspace-read capability authority: HMAC claims with `kid` rotation over a `Redacted` keyring |
| `SyncPrincipal.SyncPrincipal`, `Principal`, `anonymous`, `workspace`, `isWorkspace`, `layerWorkspace` | [src/SyncPrincipal.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/SyncPrincipal.ts) | per-request principal reference, default anonymous; non-branch reads refuse anonymous callers |
| `SyncServer.SyncServer`, `Service`, `make`, `makeLive`, `makeLiveWith`, `makeNoop`, `layer`, `layerWith`, `layerHandlers`, `layerNoop` | [src/SyncServer.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/SyncServer.ts) | serves reads over `Journal` and `RunCatalog` |
| `SyncClient.Sync`, `Service`, `SubscribeOptions`, `make`, `makeNoop`, `layer`, `layerNoop` | [src/SyncClient.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/SyncClient.ts) | detects invalid cursor movement as `SyncGapError`; resyncs a `compacted` run from the checkpoint the server names |
| `RunCatalog.RunCatalog`, `Service`, `make`, `makeMemory`, `layerStatic`, `layerNoop` | [src/RunCatalog.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/RunCatalog.ts) | supplies the run list for workspace reads |

## SyncError

[src/SyncError.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/SyncError.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `SyncError` | class | carries an `ErrorCode`, and a `Resync` in the optional `resync` field on `compacted` |
| `SyncGapError` | class | cursor moved past an entry the client never saw |
| `ErrorCode` | const + type | code literals, including the recoverable `compacted` |

`compacted` is the one recoverable code. Every other code reports a fault the
follower can only surface. A read or a subscription whose cursor for one run
starts below that run's compaction floor fails with `compacted`, and `resync`
names the run and the checkpoint sequence to resume from.

:::warning
This is a CURSOR resync, not a STATE resync. The entries below `checkpointSeq`
are deleted, so they are never delivered, and this wire carries no checkpoint
state to stand in for them. A follower rebuilding a projection from scratch
must read that prefix out of band with `Journal.latestCheckpoint(runId)` and
apply `checkpoint.state` before it continues from the sync stream. No sync RPC
serves it today.
:::

## Branch protocol

| Export | Source | Notes |
| --- | --- | --- |
| `BranchProtocol.BranchId`, `ParticipantId`, `CommandId`, `Access` | [src/BranchProtocol.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/BranchProtocol.ts) | branded ids and access levels |
| `BranchProtocol.branchRunId`, `branchOfRunId`, `commandSourceId`, `commandSourceSeq` | functions | id derivations |
| `BranchProtocol.ShareClaims`, `ShareCapability`, `Cursor`, `Participant`, `CommandSubmission`, `CommandReceipt`, `CommandEvent`, `SayCommand` | schemas | the branch vocabulary |
| `BranchProjection.State`, `Message`, `AppliedCommand`, `Field`, `empty`, `apply`, `project`, `resolveField` | [src/BranchProjection.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/BranchProjection.ts) | folds branch commands into a view |
| `BranchRpcs.BranchRpcs` plus the `SubmitPayload`, `AnnouncePayload`, `LeavePayload`, `RosterPayload`, `CreateBranchPayload`, `CreateBranchResponse`, `MintSharePayload`, `RosterFrame` schemas | [src/BranchRpcs.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/BranchRpcs.ts) | the branch RPC group |
| `BranchServer.layerHandlers` | [src/BranchServer.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/BranchServer.ts) | handler layer; requires `BranchIds` |
| `BranchIds.BranchIds`, `Service`, `make`, `makeWebCrypto`, `layer`, `layerSequential` | [src/BranchIds.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/BranchIds.ts) | the port the handlers mint branch and capability ids through. `layer` is Web Crypto UUIDs; `layerSequential(prefix)` is a deterministic counter for tests only |
| `BranchCommands.BranchCommands`, `Service`, `SubmitRequest`, `make`, `makeLive`, `makeNoop`, `layer`, `layerNoop`, `submission` | [src/BranchCommands.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/BranchCommands.ts) | command submission |
| `BranchPresence.BranchPresence`, `Service`, `Announcement`, `RosterRequest`, `LeaveRequest`, `PresenceOptions`, `make`, `makeMemory`, `makeNoop`, `layer`, `layerNoop` | [src/BranchPresence.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/BranchPresence.ts) | roster and presence |
| `BranchShare.BranchShare`, `Service`, `AuthorizeRequest`, `MintRequest`, `make`, `makeHmac`, `makeNoop`, `layerHmac`, `layerNoop` | [src/BranchShare.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/BranchShare.ts) | share-token minting and authorization |

## Test helpers

| Export | Source | Notes |
| --- | --- | --- |
| `TestSync.layerTest`, `layerNoop`, `connect` | [src/test/TestSync.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/test/TestSync.ts) | a real server and client over an in-memory socket pair |
| `TestSocket.makePair`, `Pair`, `TestFaults`, `FrameFilter` | [src/test/TestSocket.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/test/TestSocket.ts) | fault-injecting socket pair |

## Directionality

The shipped RPCs are `Read` and `Subscribe`.

:::warning
Client-to-server event submission, bidirectional reconciliation, acknowledgement windows, and resumable transport sessions are Planned.
:::

## API reference

This page is the public API reference for read-only journal synchronization over Effect RPC. The protocol currently supports catch-up and credit-bounded follow, not remote journal writes.

### `SyncProtocol`

| Export | Purpose |
| --- | --- |
| `WorkspaceScope`, `RunScope`, `Scope` | Replication selection schemas |
| `RunCursor`, `WorkspaceCursor` | Per-run and canonical cursor collection |
| `Resync` | Where a compacted run resumes: `runId` and `checkpointSeq` |
| `ReadRequest`, `ReadResponse` | Paged catch-up schemas |
| `SubscribeRequest` | Follow request with credit |
| `EntriesFrame`, `HeartbeatFrame`, `ClosedFrame`, `Frame` | Stream frames |
| `covers(scope, runId)` | Scope predicate |
| `defaultMaxFrameBytes`, `encodedByteLength(value)` | The 1 MiB encoded-entry ceiling and its measurement |

Cursor field names are `runId` and `afterSeq`. `Resync` field names are `runId`
and `checkpointSeq`. `Resync` rides on `SyncError` as one optional field rather
than as a new frame variant or a new RPC, so a follower that never meets a
compacted run sees no change on the wire.

### RPC group

`SyncRpcs.SyncRpcs` contains `Sync.Read` and streaming `Sync.Subscribe`. `SyncRpcs.SyncAuth` is the RPC middleware service; `SyncAuth.layer` is the shipped implementation, authenticating the `flows-sync-workspace` header against `WorkspaceShare` and installing the request's `SyncPrincipal` (default anonymous, non-branch reads refused). `SyncServer.layerHandlers` projects the server onto the group.

### Server

`SyncServer.Service` has `read(request)` and `subscribe(request)`. Exports include `SyncServer`, `make`, `makeNoop`, `layerNoop`, `makeLive`, and `layer`. `makeLiveWith(options)` and `layerWith(options)` take an `Options` of `maxFrameBytes`, `concurrency`, and `tailIntervalMs`.

The live layer requires `Journal` and `RunCatalog`. `RunCatalog` exposes `list` and `changes`; constructors include `make`, `layerStatic`, `makeMemory`, and `layerNoop`.

`maxFrameBytes` is a PAGE budget on a read, not a verdict on it. `read` serves
entries until the next one would cross the ceiling, then stops and reports
`done: false`, so the follower asks for the rest; the returned cursors track
what was served, so no entry is skipped and none is served twice. Only a SINGLE
entry whose own encoded size exceeds the ceiling still fails, with
`frame_too_large`, because no page can ever carry it. Failing the whole read
instead wedged the follower: `frame_too_large` is neither retried nor
retryable, so the next bootstrap carried the same cursors and got the same
refusal.

### Client

`SyncClient.Sync` is the browser-safe service tag. Its service exposes:

- `subscribe({ scope, cursors })`, a stream of `JournalEvent.Entry`
- `cursors`, the locally admitted cursor set

`make({ client })` adapts an Effect RPC client; `layer` derives that client from `RpcClient.Protocol`. `makeNoop` and `layerNoop` provide a closed client.

The client advances its local cursor as each entry is admitted to the consumer, so interruption of a partial frame does not acknowledge entries that were never observed. The acknowledged cursor set is shared service state in a `Ref`, and a commit only ever advances it, so concurrent subscriptions cannot move it backward. A live follow that loses its transport reconnects under exponential backoff (capped at five seconds), resuming from the acknowledged cursors; gaps, authorization refusals, and server closes propagate to the consumer instead of retrying.

### Compaction and resync

Compaction deletes a run's entries below a checkpoint, so a cursor under that
floor names history that no longer exists. Both ends handle it:

- The server maps the journal's `compacted` failure onto the boundary with its
  own code and the run id the read was issued for. `SyncError.resync` carries
  `{ runId, checkpointSeq }`. The run id comes from the call site because the
  journal error carries only the sequence, and a workspace read fans out over
  many runs. A `compacted` journal error that records no floor stays `unknown`,
  because it names no resume point.
- The client catches it, advances that run's cursor to `checkpointSeq`, logs
  the skipped range at warning level with `runId` and `checkpointSeq`, and
  restarts the subscription from the moved cursors. A checkpoint at or below
  what the subscription already covers cannot move the cursor forward, so it
  stays a failure rather than a retry that re-reads the same refusal.

Before this, a `compacted` refusal was terminal. The client retries only
`transport_failed`, so every resubscribe from the same cursors failed
identically, and because a whole-workspace subscription merges per-run reads,
one compacted run took down the whole subscription.

:::warning
The resync moves a cursor; it does not deliver state. Entries below
`checkpointSeq` are gone from the journal and are never delivered. A follower
rebuilding a projection from scratch must obtain that prefix out of band:
`Journal.latestCheckpoint(runId)`, apply `checkpoint.state`, then continue from
the sync stream. There is no sync RPC that serves checkpoint state today.
:::

A workspace subscription now survives a compacted run instead of dying with it,
but it does not continue in place: it reconnects once per compacted run, from
the cursors that run's resync moved.

### Errors

`SyncError` has stable transport, authorization, request, closure, and
compaction codes. `compacted` is the only recoverable one, and it is the only
one that sets `resync`. `SyncGapError` reports a non-monotonic or inconsistent
server interval.

See [Journal synchronization](/concepts/sync) and [Journal](/concepts/journal).

### Fan-out budgets

Subscription fan-out is covered by budget assertions, not only by frame assertions: `test/ServerSoak.test.ts` runs five concurrent workspace subscribers and requires an identical frame set from each, drains 200 subscribe/complete cycles and requires every per-run journal stream to be released afterwards, and soaks 200 five-subscriber rounds under a retained-heap budget. A regression that retains per-subscriber state passes every frame assertion in the other suites, so these are the tests that see it.
