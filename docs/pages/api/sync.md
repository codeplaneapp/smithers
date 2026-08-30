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
| `ReadRequest`, `ReadResponse` | schemas + types | catch-up |
| `SubscribeRequest` | schema + type | includes a credit count |
| `Frame`, `EntriesFrame`, `HeartbeatFrame`, `ClosedFrame` | schemas + types | subscription frames |
| `covers` | predicate | whether a cursor covers an entry |

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
| `SyncClient.Sync`, `Service`, `SubscribeOptions`, `make`, `makeNoop`, `layer`, `layerNoop` | [src/SyncClient.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/SyncClient.ts) | detects invalid cursor movement as `SyncGapError` |
| `RunCatalog.RunCatalog`, `Service`, `make`, `makeMemory`, `layerStatic`, `layerNoop` | [src/RunCatalog.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/RunCatalog.ts) | supplies the run list for workspace reads |

## SyncError

[src/SyncError.ts](https://github.com/smithersai/smithers/blob/main/packages/sync/src/SyncError.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `SyncError` | class | carries an `ErrorCode` |
| `SyncGapError` | class | cursor moved past an entry the client never saw |
| `ErrorCode` | const + type | code literals |

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
| `ReadRequest`, `ReadResponse` | Paged catch-up schemas |
| `SubscribeRequest` | Follow request with credit |
| `EntriesFrame`, `HeartbeatFrame`, `ClosedFrame`, `Frame` | Stream frames |
| `covers(scope, runId)` | Scope predicate |

Cursor field names are `runId` and `afterSeq`.

### RPC group

`SyncRpcs.SyncRpcs` contains `Sync.Read` and streaming `Sync.Subscribe`. `SyncRpcs.SyncAuth` is the RPC middleware service; `SyncAuth.layer` is the shipped implementation, authenticating the `flows-sync-workspace` header against `WorkspaceShare` and installing the request's `SyncPrincipal` (default anonymous, non-branch reads refused). `SyncServer.layerHandlers` projects the server onto the group.

### Server

`SyncServer.Service` has `read(request)` and `subscribe(request)`. Exports include `SyncServer`, `make`, `makeNoop`, `layerNoop`, `makeLive`, and `layer`.

The live layer requires `Journal` and `RunCatalog`. `RunCatalog` exposes `list` and `changes`; constructors include `make`, `layerStatic`, `makeMemory`, and `layerNoop`.

### Client

`SyncClient.Sync` is the browser-safe service tag. Its service exposes:

- `subscribe({ scope, cursors })`, a stream of `JournalEvent.Entry`
- `cursors`, the locally admitted cursor set

`make({ client })` adapts an Effect RPC client; `layer` derives that client from `RpcClient.Protocol`. `makeNoop` and `layerNoop` provide a closed client.

The client advances its local cursor as each entry is admitted to the consumer, so interruption of a partial frame does not acknowledge entries that were never observed. The acknowledged cursor set is shared service state in a `Ref`, and a commit only ever advances it, so concurrent subscriptions cannot move it backward. A live follow that loses its transport reconnects under exponential backoff (capped at five seconds), resuming from the acknowledged cursors; gaps, authorization refusals, and server closes propagate to the consumer instead of retrying.

### Errors

`SyncError` has stable transport, authorization, request, and closure codes. `SyncGapError` reports a non-monotonic or inconsistent server interval.

See [Journal synchronization](/concepts/sync) and [Journal](/concepts/journal).

### Fan-out budgets

Subscription fan-out is covered by budget assertions, not only by frame assertions: `test/ServerSoak.test.ts` runs five concurrent workspace subscribers and requires an identical frame set from each, drains 200 subscribe/complete cycles and requires every per-run journal stream to be released afterwards, and soaks 200 five-subscriber rounds under a retained-heap budget. A regression that retains per-subscriber state passes every frame assertion in the other suites, so these are the tests that see it.
