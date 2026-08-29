---
description: "@smthrs/gateway: the wire schemas, projections, and supervision port that smithers serve hosts for a UI."
---

# @smthrs/gateway

`@smthrs/gateway` is the contract half of the projection surface. It declares
the workspace and health schemas, the projection names and their selectors, the
frame protocol a subscription speaks, the session-token records, and the
`SuperviseRuntime` port. [`smithers serve`](/cli/serve) composes it with
`@smthrs/control` and `@smthrs/sync` to host the endpoints in
[the control plane](/control).

A UI depends on this package and on `@smthrs/control`. It never depends on
`@smthrs/engine-store`, and it never reads a store table: a projection is the
contract, and a store row is an implementation detail.

## Projections

A projection is a read model over the journal. Subscribing to one never claims
a run and never writes.

| Projection | Selector | Answers |
| --- | --- | --- |
| `workspace-runs` | `WorkspaceRunsSelector` | the run list for a workspace |
| `run-summary` | `RunSummarySelector` | one run's status, flow, and timing |
| `run-events` | `RunEventsSelector` | the run's control events after a cursor |
| `transcript` | `TranscriptSelector` | the human-readable transcript |
| `run-tree` | `RunTreeSelector` | the run and its linked children |
| `plan-cards` | `PlanCardsSelector` | the plan cards a run compiled |
| `approvals` | `ApprovalsSelector` | pending approval requests and their payloads |
| `node-output` | `NodeOutputSelector` | one node's registered output |

`ProjectionName` is the authority for that list. The set a release serves and
the set the schema declares are the same set.

## Frames

A subscription is a stream of tagged frames rather than a stream of rows, so a
client can tell a snapshot from a delta and an overflow from a close.

| Frame | Means |
| --- | --- |
| `SnapshotStartFrame`, `RowFrame`, `SnapshotEndFrame` | the initial state, row by row |
| `DeltaFrame` | one change after the snapshot |
| `HeartbeatFrame` | the connection is alive, sent below the idle cut of any proxy |
| `OverflowFrame` | the client fell too far behind and must resubscribe |
| `ExpiredFrame`, `TerminalFrame` | the cursor is gone, or the subscription ended |
| `UnauthorizedFrame` | the credential does not carry the scope |

## Health

`GET /health` answers `GatewayHealth`: the workspace hash, the gateway id, and
the protocol version. A deployment gates its behavior on those fields rather
than on a version string in a banner.

## Supervision

`SuperviseRuntime` is a port, not a feature. It declares how a host would
discover stale runs, quota-due work, and stale claims, and how it would take a
resume lease. This release ships `make`, `makeNoop`, and `layerNoop` only, and
no production consumer installs it: recovery in 1.0.0-rc.0 is a running engine
process with the flow registered. See
[known limitations](/release/known-limitations).

## Sync

The package re-exports `@smthrs/sync`, so a gateway host gets the read-only
journal replication protocol from the same import: `SyncClient`, `SyncServer`,
`SyncProtocol`, `RunCatalog`, and the cursor types. Sync is read-only in both
directions of the word: a follower cannot mutate a run, and it cannot resume
one. See [sync](/concepts/sync).

## Test layers

`@smthrs/gateway/test/TestSuperviseRuntime` provides a controllable supervision
service for tests that need the port without a host.
