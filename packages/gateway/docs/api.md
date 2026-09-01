A UI depends on this package and on [`@smthrs/control`](/api/control). It never
depends on `@smthrs/engine-store`, and it never reads a store table: a
projection is the contract, and a store row is an implementation detail.
[`smithers serve`](/cli/serve) composes the assembly with `@smthrs/control` and
`@smthrs/sync` to host it.

## Mounts

`GatewayServer.layer` mounts seven routes, and `NodeGateway.layer` binds them to
a socket.

| Path                | Protocol           | Serves                                          |
| ------------------- | ------------------ | ----------------------------------------------- |
| `POST /rpc`         | RPC over HTTP      | `@smthrs/control` `ControlRpcs`                 |
| `/rpc/ws`           | RPC over WebSocket | `ControlRpcs`, including a kept-alive `Watch`   |
| `POST /projections` | RPC over HTTP      | `GatewayRpcs`                                   |
| `/projections/ws`   | RPC over WebSocket | `GatewayRpcs`, including `Projection.Subscribe` |
| `POST /sync`        | RPC over HTTP      | `@smthrs/sync` `SyncRpcs`                       |
| `/sync/ws`          | RPC over WebSocket | `SyncRpcs`                                      |
| `GET /health`       | JSON               | `GatewayServer.Health`                          |

`GatewayServer.rpcPaths` is the three `POST` mounts that carry RPC request
messages. `GatewayServer.protectedPaths` adds the three sockets: every path in
it passes edge authentication before a body is read or an upgrade is answered.

A request target is classified the way the router will resolve it, not by its
literal spelling. The router reaches `/rpc` from `/%72pc`,
`/rpc;transport-parameter`, `/rpc/`, `//rpc`, `/rpc//`, `/RPC`, and `/foo/../rpc`,
so the guard resolves dot segments, takes each segment without its `;`
parameter, drops empty segments, decodes the rest with `decodeURI`, and
compares without regard to case. A reserved character left encoded stays
encoded, so `/rpc%2f` is a different path here exactly as it is to the router.
This matters for more than aliases: `ControlClient`'s HTTP protocol posts every
call to `/rpc/`, which a literal comparison did not recognize, so the credential
check and the body limit were skipped on the path the product's own client uses.

`GET /health` is deliberately unauthenticated. A supervisor decides whether to
keep or replace a gateway process by asking which workspace it belongs to, and
a probe that needed a credential could not answer that about a gateway it did
not start. The response carries identity only: the workspace hash, the gateway
id, the protocol version, and the package version. It never carries a token, a
run, or a path.

## Bind and credential policy

Two rules decide whether a bind is allowed, and both fail closed.

1. A non-loopback host requires an explicit `listen` opt-in. Binding `0.0.0.0`
   because a port was free is how a workspace gateway ends up on a shared
   network by accident.
2. A non-loopback bind requires a bearer credential. The control plane can
   launch runs, cancel them, and approve capability grants; reachable from
   another machine, an unauthenticated one is a remote execution service.

A loopback bind with no credential is allowed and is the local default: the
trust boundary there is the machine account. `NodeGateway.isLoopbackHost`
accepts `127.0.0.1`, `::1`, and `localhost` and nothing else.

`NodeGateway.bindRefusal` answers the policy as a value: a `bind_failed`
`GatewayError` naming the rule that refused, or `undefined`.
`NodeGateway.listenOptions` and `NodeGateway.layer` raise exactly what it
returns, because a layer is built rather than run. A listen failure the
operating system reports, such as an address already in use, is not mapped: it
stays the `NodeHttpServer` failure it is.

One shared bearer authenticates every mount and binds one principal. There are
no users, no roles, no per-run ownership, and no scopes.

## Projections

A projection is a read model folded from the ordered `ControlEvent` deltas
`Control.watch` publishes. Subscribing to one never claims a run and never
writes. `GatewaySchema.ProjectionName` is the authority for the list, and the
set a release serves is the set the schema declares.

| Projection       | Selector                | Answers                                                                                         |
| ---------------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| `workspace-runs` | `WorkspaceRunsSelector` | one summary row per run in the workspace                                                        |
| `run-summary`    | `RunSummarySelector`    | one run's card: status, timing, activity counts, and the diagnosis of what happened to it       |
| `run-events`     | `RunEventsSelector`     | the run's ordered control events, unfolded                                                      |
| `transcript`     | `TranscriptSelector`    | one turn-numbered line per reported event                                                       |
| `run-tree`       | `RunTreeSelector`       | the agent cell calls the run made, keyed `call-1`, `call-2`, and so on                          |
| `approvals`      | `ApprovalsSelector`     | with a run, that run's gates including decided ones; without one, the workspace's pending gates |
| `node-output`    | `NodeOutputSelector`    | the value one settled call produced                                                             |

`run-tree` folds agent cell calls, not child runs. Neither
`control.agent.cell-call-started` nor `control.agent.cell-call-settled` names a
node, so a call's published key is the ordinal it opened on, and a settlement is
paired with the oldest open call of the same flow name. `node-output` keys its
rows the same way, so a node id a tree view shows is a node id
`smithers output` accepts.

`GatewaySchema.rowSchemaFor` maps a selector to the schema of the rows it
answers with, so a client decodes a snapshot instead of casting it.

## Subscriptions

`Projection.Subscribe` answers a stream of tagged frames rather than a stream of
rows, so a client can tell a snapshot from a change.

| Frame                | Means                                |
| -------------------- | ------------------------------------ |
| `SnapshotStartFrame` | the snapshot begins, at this cursor  |
| `RowFrame`           | one row of the snapshot              |
| `SnapshotEndFrame`   | the snapshot is complete             |
| `DeltaFrame`         | the selector's rows after one change |
| `HeartbeatFrame`     | the connection is alive              |

A delta is a full replacement of the selector's rows, recomputed from the
events accumulated so far, because a projection is a reproducible fold and
recomputation is the only delta that cannot disagree with a fresh snapshot.
`run-events` is the exception: its rows are the ordered events, so its delta is
the one event that arrived.

One subscription reads the control plane once. The rows, the cursor the
snapshot advertises, and the sequence the deltas start after all come from that
single read, so a client that follows the same selector from the advertised
cursor sees each later change exactly once.

`Projection.Subscribe` accepts an `after` cursor. With one it skips the snapshot
and answers the deltas after that cursor. A cursor that names a different
projection or a different run is refused with `malformed_request`, and so is a
negative, fractional, or ahead-of-run cursor. A cursor on a workspace selector
is refused too: control journal sequences belong to per-run partitions, so a
workspace cursor is always `0` with a null run and no workspace projection is
resumable from one.

A workspace subscription follows every run partition and answers a full
replacement of its rows on each change. It admits a run the snapshot did not
see with one read and folds at most `Projections.maxWorkspaceRuns` runs, the
same allowance as the snapshot. The unscoped follow replays each partition's
history, so the gateway discards the prefix each snapshot already folded. The
subscription is still not resumable because control journal sequences belong
to per-run partitions, and its cursor is always `0` with a null run.

## Failures

`GatewayErrorCode` is the whole failure vocabulary, and every member is
constructed by a real path.

| Code                | Status | Produced by                                                                                                                                              |
| ------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bind_failed`       | none   | `NodeGateway.bindRefusal`, `NodeGateway.listenOptions`, `GatewayServer.layer`, `GatewayServer.layerIngress`, and `Projections.make`, at composition time |
| `unauthorized`      | 401    | the ingress guard, on any protected path without the configured credential                                                                               |
| `malformed_request` | 400    | the ingress guard, for a `POST` body carrying no RPC request message or a body it could not read, and the read path, for an invalid resume cursor        |
| `request_too_large` | 413    | the ingress guard, for a body over the configured limit                                                                                                  |
| `run_unavailable`   | none   | the read path, when listing runs, reading a run's events, or following a run or the workspace failed                                                     |
| `run_not_found`     | none   | the read path, for a run the control plane does not have, identically for every run-scoped selector                                                      |

`GatewayError.cause` carries only a redacted summary of an internal failure: its
tag and its stable code. The whole cause is logged server-side instead, because
this error is the RPC error schema, so anything left on it is serialized to
every bearer holder and forwarded to the browser by a relay.

## Limits

An HTTP RPC request body is capped at `GatewayServer.defaultMaxRequestBodyBytes`,
one MiB, overridable per bind with `ServerOptions.maxRequestBodyBytes`. A
declared `content-length` over the limit is refused without reading the body; a
body that declares no length is measured as it is read.

An idle subscription emits a keepalive every
`Projections.heartbeatIntervalMillis`, thirty seconds, well inside the
600-second idle cut a relay applies. `ServerOptions.heartbeatMillis` shortens it
for a relay that cuts sooner. Both settings must be positive safe integers, and
a value that is not is refused with `bind_failed` before anything binds.

A workspace listing pages the control plane with an explicit limit and folds at
most `Projections.maxWorkspaceRuns` runs. A workspace with more runs is answered
as its first `maxWorkspaceRuns` runs.

A workspace delta re-reads the run row of the run whose event arrived, which is
one indexed listing per event, and reads a run it has not seen before once.
Neither cost grows with a run's length.

What is not bounded at 1.0.0-rc.0: a projection read collects each selected
run's whole journal. There is no event ceiling, no encoded-byte ceiling, and no
overflow frame.

## Supervision

`SuperviseRuntime` is a host seam, not a feature. It declares how a host would
discover stale runs, quota-due work, and stale claims, and how it would take a
resume lease. This release ships `make`, `makeNoop`, and `layerNoop` only, and
no production host installs it: recovery is a running engine process with the
flow registered, reclaiming a run whose owner stopped renewing its heartbeat.
See [known limitations](/release/known-limitations).

## Sync

The package re-exports `@smthrs/sync`, so a gateway host gets the read-only
journal replication protocol from the same import: `SyncClient`, `SyncServer`,
`SyncProtocol`, `RunCatalog`, and the cursor types. Sync is read-only in both
directions of the word: a follower cannot mutate a run, and it cannot resume
one. See [sync](/concepts/sync).

## Declared but not served

`GatewaySchema.Workspace`, `GatewayConfig`, `GatewayStatus`, `SingletonRecord`,
`TokenScope`, and `TokenRecord` describe a workspace singleton handshake that
1.0.0-rc.0 has no route for. No code in this release mints, reads, persists, or
serves one. `docs/migration/plue-consumer-contract.md` records the same fact
against its `connect` handshake row: the schemas exist and the route does not.
Read them as a proposal, not as a contract a client can call.

Everything else the schema declares is served. `ProjectionName` in particular
equals the set the read path answers, which is ruling R-8.

## Test layers

`@smthrs/gateway/test/TestSuperviseRuntime` provides a controllable supervision
service for tests that need the port without a host.
