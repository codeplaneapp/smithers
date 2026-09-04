# @smthrs/sync

This package declares `effect` as an exact
`4.0.0-rc.108` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://sync.smithers.sh

Browser-safe, read-only replication of canonical `@smthrs/journal` entries.
It defines the wire protocol, RPC group, server, and replay-then-follow client;
journal mutation remains outside this package.

It also defines **branch collaboration**: a branch is one shared live document
whose durable state is exactly one journal run (`BranchProtocol.branchRunId`),
so multiplayer reuses the canonical `seq`, cursors, gap detection, and resumable
follow rather than introducing a second source of truth. Presence is a lease and
is never journalled; commands are admitted through a client-minted idempotency
key; every branch operation after `Branch.CreateBranch` authorizes through a
signed, expiring, branch-scoped share capability. Branch collaboration ships
unserved at 1.0.0-rc.0: the gateway mounts `SyncRpcs`, and nothing mounts
`BranchRpcs` yet.

Authorization is fail-closed along two boundaries:

- **Branch runs** authorize through the branch share capability carried in
  each request (`BranchShare`). A share link grants exactly its branch's run.
- **Non-branch runs and workspace listings** authorize through the
  authenticated workspace principal (`SyncPrincipal`, default anonymous). Over
  RPC, `SyncAuth.layer` establishes the principal by verifying the
  `WorkspaceShare` capability presented in the `flows-sync-workspace` request
  header. A connection with no valid credential is refused every non-branch
  read.

Both authorities take `Redacted` secrets and lead their signed encoding with a
scheme label; `WorkspaceShare` additionally carries a rotation-ready `kid`. An
open subscription ends with `unauthorized` when the credential that opened it
expires, because a stream authorized once at open is otherwise the one thing a
signed expiry cannot revoke.

```sh
pnpm add @smthrs/sync
```

## Public API

The root exports these namespaces, also available from matching
`@smthrs/sync/*` subpaths. The per-export reference is generated from the
source: see [sync.smithers.sh](https://sync.smithers.sh/reference/api/).

| Namespace          | What it owns                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `SyncError`        | `ErrorCode`, `SyncError` with the structural guard `SyncError.is`, and terminal `SyncGapError`.   |
| `SyncProtocol`     | Scopes, cursors, `Resync`, request and response schemas, frames, and the size and request limits. |
| `SyncRpcs`         | The read-path RPC group (`Sync.Read`, `Sync.Subscribe`) and the `SyncAuth` middleware service.    |
| `SyncAuth`         | Implementations of that middleware: `layer`, `layerClient`, and the header codec.                 |
| `SyncPrincipal`    | The per-request identity reference, its constructors, and `layerWorkspace` for in-process owners. |
| `WorkspaceShare`   | The workspace capability authority over a `Redacted` keyring with `kid` rotation.                 |
| `RunCatalog`       | The workspace run set a subscription reconciles against, in-memory, polling, and static forms.    |
| `SyncServer`       | The read-path implementation, its policy, and `layerHandlers`.                                    |
| `SyncClient`       | The browser-safe replay-then-follow client and its subscription options.                          |
| `BranchProtocol`   | The branch vocabulary: ids, claims, capabilities, submissions, receipts, and the run-id mapping.  |
| `BranchShare`      | The branch capability authority.                                                                  |
| `BranchIds`        | The port branch and capability ids are minted through.                                            |
| `BranchCommands`   | Idempotent command admission onto a branch's journal run.                                         |
| `BranchPresence`   | The ephemeral, lease-expiring roster.                                                             |
| `BranchProjection` | The fold from branch commands to a document view.                                                 |
| `BranchRpcs`       | The branch collaboration wire group.                                                              |
| `BranchServer`     | The handler layer that projects the branch services onto that group.                              |

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
follower has fallen. The table lives with the rest of the contract at
[sync.smithers.sh](https://sync.smithers.sh/reference/api/#bounds), and every numeric
option is validated where it enters: a value that is not a positive safe
integer fails the constructor with `invalid_request` rather than quietly
disabling the comparison it configures.

Both change feeds slide rather than block, and neither is a source of truth.
`RunCatalog.list` and `BranchPresence.list` are the authoritative state, and
every reader re-lists on a cadence of its own, so a dropped notification costs
latency and never state.

See [sync concepts](https://smithers.sh/concepts/sync) for the protocol, and
`docs/README.md` in this package for where each published sentence lives.

## Rewinds and cursor generations

`RunCursor` and `EntriesFrame` carry a `generation`; omission means generation
zero for existing append-only histories and persisted cursors. SQL journals
persist it independently of sequence numbers. Rewind increments it atomically
with truncation, so a follower at 100 cannot silently discard a replacement
entry at 51 after rewinding to 50.

Both reads and subscriptions fail with `SyncError.code = "lineage_changed"`
when generations differ. Live run and workspace subscriptions also check while
idle, within `tailIntervalMs`. This failure is terminal: rebuild the projection from the current retained
history through the archive boundary, create a fresh sync client, and resume
from the server error's
`rewind: { runId, generation, afterSeq }`. For `afterSeq: -1`, omit the cursor
to replay the entire current history. Keep the generation with every persisted
cursor. Compaction recovery remains separate.

Append-only journal adapters may omit `Journal.Service.generation`. Any adapter
that truncates or replaces history must implement it and advance the generation
in its truncation transaction. Upgrade sync clients and servers together;
older clients cannot detect generation changes.
