---
title: "@smthrs/sync"
description: "Browser-safe, read-only replication of a workspace's journal: the wire protocol, the fail-closed server, the replay-then-follow client, and the branch collaboration surface built on the same runs."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/sync/docs/README.md"
---

`@smthrs/sync` replicates [`@smthrs/journal`](https://journal.smithers.sh/reference/api/) entries to readers
that do not own the journal. A second process, a browser tab, or an operator's
dashboard opens one subscription, receives the durable history it has never
seen, and then receives new entries as they commit.

The package is read-only by construction. `SyncRpcs` carries exactly two
procedures, `Sync.Read` and `Sync.Subscribe`, and nothing in it appends to a
journal. Replication therefore introduces no second source of truth: the
canonical sequence a follower sees is the sequence the journal assigned.

Three properties follow from that, and they are what the package is for:

- **A cursor is per run and tolerates holes.** `afterSeq` means "entries after
  this number", never "expect the next number to be one greater". Dropped
  admissions leave legitimate gaps, and a follower that treats a gap as
  corruption stalls on ordinary traffic.
- **Every fan-out surface is bounded.** One follower's cost is a function of
  the configured bound, not of the workspace's size or of how far behind that
  follower has fallen.
- **Authorization fails closed.** A connection that presents no credential
  reads no non-branch run, and a subscription ends with `unauthorized` when the
  credential that opened it expires.

`BranchProtocol` and the six modules around it add **branch collaboration** on
top of the same runs: a branch is one shared live document whose durable state
is exactly one journal run, so multiplayer reuses the sequence, cursors, gap
detection, and resumable follow that already exist. Branch collaboration ships
unserved at 1.0.0-rc.0; see [Branch collaboration](/concepts/branches/).

## Who uses this package

Host authors serve the read path: they compose `SyncServer` over a journal and
a run catalog and mount `SyncRpcs` on a transport.
[`@smthrs/gateway`](https://gateway.smithers.sh/reference/api/) is the shipped host, and it mounts the group
on `POST /sync` and `/sync/ws`.

Client authors follow a run: they compose `SyncClient` over an RPC protocol and
consume a stream of entries. The client is browser safe, so a tab following a
run runs the same code a Node follower does.

If you are writing a flow, you do not reach this package at all. The engine
writes the journal, and sync is how something else watches.

## Install

```bash
pnpm add @smthrs/sync
```

For the import forms, the browser posture, and the packages a serving
composition adds, see [Installation](/installation/).

## The smallest real example

A follower subscribes to one run and receives its history, then its live
entries, through one stream:

```ts
import type { JournalEvent } from "@smthrs/journal"
import * as SyncClient from "@smthrs/sync/SyncClient"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

const runId = "build-42" as JournalEvent.RunId

const follow = Effect.gen(function*() {
  const sync = yield* SyncClient.Sync
  return yield* Stream.runCollect(
    sync.subscribe({ scope: { _tag: "Run", runId }, cursors: [] }).pipe(Stream.take(10))
  )
})
```

`cursors: []` starts from the beginning of the run. The client pages through
`Sync.Read` until the server reports it reached the durable tail, then switches
to `Sync.Subscribe` and stays there. For a version that runs end to end against
a real server, see the [Quickstart](/quickstart/).

## The package at a glance

The root entry point exports these namespaces, and each is also importable from
`@smthrs/sync/<Module>`:

| Namespace          | What it is                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `SyncProtocol`     | The wire contract: scopes, cursors, requests, responses, frames, and the size and count limits.                                  |
| `SyncError`        | `ErrorCode`, the `SyncError` every procedure declares with its structural guard `SyncError.is`, and the terminal `SyncGapError`. |
| `SyncRpcs`         | The read-path RPC group and the `SyncAuth` middleware tag it is bound to.                                                        |
| `SyncServer`       | The workspace-side implementation of the read path, its policy, and `layerHandlers`.                                             |
| `SyncClient`       | The browser-safe replay-then-follow client and its subscription options.                                                         |
| `RunCatalog`       | The workspace run set a workspace subscription reconciles against: static, in-memory, and polling forms.                         |
| `SyncAuth`         | The middleware implementations: `layer` verifies a header, `layerClient` sends one, plus the header codec.                       |
| `SyncPrincipal`    | The per-request identity reference, its constructors, and `layerWorkspace` for in-process owners.                                |
| `WorkspaceShare`   | The workspace capability authority over a `Redacted` keyring with `kid` rotation.                                                |
| `BranchProtocol`   | The branch vocabulary: ids, claims, capabilities, submissions, receipts, and the branch-to-run mapping.                          |
| `BranchShare`      | The branch capability authority: one branch, one access level, one expiry, signed.                                               |
| `BranchIds`        | The port fresh branch and capability ids are minted through.                                                                     |
| `BranchCommands`   | Idempotent admission of commands onto a branch's journal run.                                                                    |
| `BranchPresence`   | The ephemeral, lease-expiring roster, which is never journalled.                                                                 |
| `BranchProjection` | The order-independent fold from branch commands to a document view.                                                              |
| `BranchRpcs`       | The branch collaboration wire group.                                                                                             |
| `BranchServer`     | The handler layer that projects the branch services onto that group.                                                             |

Two test doubles ship under explicit subpaths: `@smthrs/sync/test/TestSocket`
is an in-memory socket pair with fault injection, and
`@smthrs/sync/test/TestSync` binds a real server and client over it.

Every export, with signatures and error codes, is in the
[API reference](/reference/api/).

## Where to go next

- [Installation](/installation/): the import forms, the browser posture, and
  what a serving composition adds.
- [Quickstart](/quickstart/): write two entries, follow the run, and watch a
  third arrive live.
- [Wire protocol](/protocol/): the normative message shapes, for a client
  written against the wire rather than against `SyncClient`.
- Concepts: [scopes and cursors](/concepts/scopes-and-cursors/),
  [replay then follow](/concepts/replay-then-follow/),
  [authorization](/concepts/authorization/),
  [compaction and resync](/concepts/compaction/), and
  [branch collaboration](/concepts/branches/).
- Guides: [follow a run](/guides/follow-a-run/),
  [serve the read path](/guides/serve-the-read-path/),
  [authorize a connection](/guides/authorize-a-connection/),
  [list a workspace's runs](/guides/list-workspace-runs/),
  [handle a compacted run](/guides/handle-a-compacted-run/), and
  [test a follower](/guides/test-a-follower/).
- [Troubleshooting](/troubleshooting/): every `SyncError` code, the symptom
  it produces, and what to change.
