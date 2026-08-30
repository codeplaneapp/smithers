# @smthrs/sync

Browser-safe, read-only replication of canonical `@smthrs/journal` entries.
It defines the wire protocol, RPC group, server, and replay-then-follow client;
journal mutation remains outside this package.

It also defines **branch collaboration**: a branch is one shared live document
whose durable state is exactly one journal run (`BranchProtocol.branchRunId`),
so multiplayer reuses the canonical `seq`, cursors, gap detection, and resumable
follow rather than introducing a second source of truth. Presence is a lease and
is never journalled; commands are admitted through a client-minted idempotency
key; every branch operation after `Branch.CreateBranch` authorizes through a
signed, expiring, branch-scoped share capability.

Authorization is fail-closed along two boundaries:

- **Branch runs** authorize through the branch share capability carried in
  each request (`BranchShare`). A share link grants exactly its branch's run.
- **Non-branch runs and workspace listings** authorize through the
  authenticated workspace principal (`SyncPrincipal`, default anonymous). Over
  RPC, `SyncAuth.layer` establishes the principal by verifying the
  `WorkspaceShare` capability presented in the `flows-sync-workspace` request
  header; secrets are provisioned as a `Redacted` keyring with rotation-ready
  `kid`s (`WorkspaceShare.layerHmac`, `WorkspaceShare.layerConfig`). A
  connection with no valid credential is refused every non-branch read.

```sh
pnpm add @smthrs/sync
```

## Public API

The root exports these namespaces, also available from matching
`@smthrs/sync/*` subpaths.

| Namespace          | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SyncError`        | `ErrorCode` schema/type, general `SyncError` with guard `SyncError.is`, and terminal `SyncGapError`.                                                                                                                                                                                                                                                                                                                                                |
| `SyncProtocol`     | Scope schemas `WorkspaceScope`, `RunScope`, and `Scope`; cursor schemas/types `RunCursor` and `WorkspaceCursor`; `ReadRequest`, `ReadResponse`, and `SubscribeRequest`; `EntriesFrame`, `HeartbeatFrame`, `ClosedFrame`, and `Frame`; `covers(scope, runId)`.                                                                                                                                                                                       |
| `SyncRpcs`         | `SyncRpcs` defines `Sync.Read` and streaming `Sync.Subscribe`; `SyncAuth` is the RPC middleware service every served group must implement.                                                                                                                                                                                                                                                                                                          |
| `RunCatalog`       | `RunCatalog` / `Service` list runs and expose changes. `make`, `layerStatic`, `makeMemory` (`MemoryOptions`, `defaultChangesCapacity`), `makePolling` / `layerPolling` (`PollingOptions`, `defaultPollIntervalMs`), and `layerNoop` provide implementations. `makePolling` is the one a workspace follower learns from: it re-reads a durable source on an interval, so a run another engine created is announced within one interval of appearing. |
| `SyncServer`       | `SyncServer` / `Service`, `make`, `makeNoop`, and `layerNoop`; `makeLive` / `layer` implement journal replay and follow using `Journal` and `RunCatalog`; `makeLiveWith` / `layerWith` take an explicit `Options` policy (`maxFrameBytes`, `concurrency` with `defaultConcurrency`, `tailIntervalMs` with `defaultTailIntervalMs`); `layerHandlers` projects the service onto `SyncRpcs`.                                                           |
| `SyncClient`       | `Sync` / `Service` expose `subscribe` and materialized `cursors`; `SubscribeOptions` (`credit`, default `defaultCredit`), `make`, `makeNoop`, `layer`, and `layerNoop` construct the browser-safe client.                                                                                                                                                                                                                                           |
| `BranchProtocol`   | `BranchId`, `ParticipantId`, `CommandId`, `Access`; `branchRunId` / `branchOfRunId` / `commandSourceId` / `commandSourceSeq`; `CommandEvent` and `SayCommand`; `ShareClaims`, `ShareCapability`, `Cursor`, `Participant`, `CommandSubmission`, `CommandReceipt`.                                                                                                                                                                                    |
| `BranchShare`      | `BranchShare` / `Service` with `mint` and `verify`; `AuthorizeRequest`, `MintRequest`, `make`, `makeNoop`, `layerNoop`, `makeHmac`, `layerHmac`.                                                                                                                                                                                                                                                                                                    |
| `WorkspaceShare`   | `WorkspaceShare` / `Service` with `mint` and `verify` over a `Redacted` `Keyring` with `kid` rotation; `WorkspaceClaims`, `WorkspaceCapability`, `AuthorizeRequest`, `MintRequest`, `make`, `makeNoop`, `layerNoop`, `makeHmac`, `layerHmac`, `layerConfig`.                                                                                                                                                                                        |
| `SyncPrincipal`    | `Principal` (`Anonymous` / `Workspace`), `anonymous`, `workspace`, `isWorkspace`, the `SyncPrincipal` reference (default anonymous), and `layerWorkspace` for in-process owners.                                                                                                                                                                                                                                                                    |
| `SyncAuth`         | Implementations of the `SyncRpcs.SyncAuth` middleware: `layer` verifies the `capabilityHeader` workspace capability, `layerClient` stamps it on outgoing requests, `encodeCapability` / `decodeCapability` are the header codec.                                                                                                                                                                                                                    |
| `BranchPresence`   | `BranchPresence` / `Service` with `announce`, `leave`, `list`, `changes`; `Announcement`, `RosterRequest`, `LeaveRequest`, `PresenceOptions` (`changesCapacity`, default `defaultChangesCapacity`), `make`, `makeNoop`, `layerNoop`, `makeMemory`, `layer`.                                                                                                                                                                                         |
| `BranchCommands`   | `BranchCommands` / `Service` with `submit`; `SubmitRequest`, `submission`, `make`, `makeNoop`, `layerNoop`, `makeLive`, `layer`.                                                                                                                                                                                                                                                                                                                    |
| `BranchIds`        | `BranchIds` / `Service` with `fresh`, the port `BranchServer.layerHandlers` mints branch and capability ids through; `make`, `makeWebCrypto`, `layer` (Web Crypto UUIDs), and `layerSequential(prefix)` for deterministic tests.                                                                                                                                                                                                                    |
| `BranchProjection` | `State`, `Message`, `AppliedCommand`, `Field`; `empty`, `apply`, `project`, and the explicit `resolveField` conflict policy.                                                                                                                                                                                                                                                                                                                        |

Public test subpaths are `@smthrs/sync/test/TestSocket` (`FrameFilter`,
`TestFaults`, `Pair`, `makePair`) and `@smthrs/sync/test/TestSync`
(`layerTest`, `layerWorkspaceAuth`, `layerNoop`, `connect`).

```ts
import { RunCatalog, SyncServer } from "@smthrs/sync"
import { Effect, Layer } from "effect"

const serverLayer = SyncServer.layer.pipe(
  Layer.provide(RunCatalog.layerStatic([]))
)

const program = Effect.gen(function*() {
  return yield* SyncServer.SyncServer
}).pipe(Effect.provide(serverLayer))
```

`Read` pages durable entries, then the client subscribes from exclusive
per-run cursors. A non-contiguous journal sequence is valid; `SyncGapError`
means the server skipped beyond the interval covered by the client's cursor.

## Bounds

Every fan-out surface is bounded, so one follower's cost is a function of the
configured bound rather than of the workspace's size or of how far behind that
follower has fallen.

| Bound                                            | Default                                       | What it caps                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SyncServer.Options.concurrency`                 | `SyncServer.defaultConcurrency` (64)          | Journal reads one workspace subscription holds open at once. Each round walks every covered run's unserved entries as a bounded page read, so the bound caps what one follower costs without capping what it sees.                                                                                        |
| `SyncServer.Options.tailIntervalMs`              | `SyncServer.defaultTailIntervalMs` (1000)     | Milliseconds a workspace subscription waits before revisiting every covered run when nothing wakes it. A journal entry committed in this process for a covered run, or a catalog announcement, wakes the round at once, so the interval is the freshness policy for the runs another engine process owns. |
| `SyncServer.Options.maxFrameBytes`               | `SyncProtocol.defaultMaxFrameBytes` (1 MiB)   | Summed encoded entries of one read page or subscription frame.                                                                                                                                                                                                                                            |
| `SyncClient.SubscribeOptions.credit`             | `SyncClient.defaultCredit` (256)              | Frames one subscription round carries before the follow replenishes the window by resubscribing from its acknowledged cursors.                                                                                                                                                                            |
| `RunCatalog.MemoryOptions.changesCapacity`       | `RunCatalog.defaultChangesCapacity` (1024)    | Announcements a stalled `changes` subscriber may fall behind by; the oldest slide out.                                                                                                                                                                                                                    |
| `RunCatalog.PollingOptions.intervalMs`           | `RunCatalog.defaultPollIntervalMs` (1000)     | Milliseconds between reads of the durable run set: one bounded query per interval per composition, not per subscriber.                                                                                                                                                                                    |
| `BranchPresence.PresenceOptions.changesCapacity` | `BranchPresence.defaultChangesCapacity` (256) | Roster notifications a stalled `changes` subscriber may fall behind by; the oldest slide out.                                                                                                                                                                                                             |

Both change feeds slide rather than block: a publisher never waits on a stalled
subscriber, and never grows the process on its behalf. A subscriber that loses
a notification re-lists — `RunCatalog.list` and `BranchPresence.list` are the
authoritative state — so a dropped notification never loses state.

See the [sync reference](../../docs/pages/api/sync.md) and
[sync concepts](../../docs/pages/concepts/sync.md).
