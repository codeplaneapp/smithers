# @smthrs/gateway

The assembled workspace gateway: one HTTP surface carrying the control plane, the sync read path, the served projections, and a health probe. It also defines the gateway wire schemas and the stale-run supervision port, and re-exports the durable journal synchronization package gateway hosts use.

```sh
npm install @smthrs/gateway
```

## Public API

The root entry point exports these namespaces; local modules are also importable from `@smthrs/gateway/<Module>`.

| Module                      | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Description                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GatewayError`              | `GatewayErrorCode`, `GatewayError`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Defines typed gateway validation and projection failures.                                                        |
| `GatewaySchema`             | `Workspace`, `GatewayConfig`, `GatewayStatus`, `GatewayHealth`, `ProjectionName`, `WorkspaceRunsSelector`, `RunSummarySelector`, `RunEventsSelector`, `TranscriptSelector`, `RunTreeSelector`, `PlanCardsSelector`, `ApprovalsSelector`, `NodeOutputSelector`, `ProjectionSelector`, `ProjectionCursor`, `SubscriptionTick`, `SubscriptionWatch`, `SnapshotStartFrame`, `RowFrame`, `SnapshotEndFrame`, `DeltaFrame`, `HeartbeatFrame`, `OverflowFrame`, `ExpiredFrame`, `TerminalFrame`, `UnauthorizedFrame`, `GatewayFrame`, `SingletonRecord`, `TokenScope`, `TokenRecord` | Supplies schemas and inferred types for workspace configuration, projections, subscriptions, frames, and tokens. |
| `Diagnosis`                 | `Refusal`, `Digest`, `Subject`, `clip`, `digest`, `duration`, `verdict`, `render`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Computes and renders what happened to a run, from that run's own control events.                                 |
| `GatewayProjection`         | `RunSummaryRow`, `RunTreeRow`, `ApprovalRow`, `NodeOutputRow`, `TranscriptRow`, `runSummary`, `runTree`, `approvals`, `nodeOutput`, `transcript`                                                                                                                                                                                                                                                                                                                                                                                                                              | Defines the served wire rows and the pure folds that compute them.                                               |
| `GatewayRpcs`               | `Decision`, `SubmitApprovalInput`, `SubmitApprovalOutput`, `GatewayRpcs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Declares the served read path and the composite approval mutation.                                               |
| `GatewayServer`             | `Health`, `layerHealth`, `layerHandlers`, `watchHeartbeatKind`, `layerKeepAlive`, `layerControlHttp`, `layerProjectionsHttp`, `layerSyncHttp`, `layer`                                                                                                                                                                                                                                                                                                                                                                                                                        | Assembles the whole HTTP surface as one application layer a host serves.                                         |
| `Projections`               | `heartbeatIntervalMillis`, `Service`, `Projections`, `make`, `layer`, `layerWith`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Serves the read path over the control plane, as snapshots and followed deltas.                                   |
| `node/NodeGateway`          | `ServerOptions`, `defaultServerOptions`, `isLoopbackHost`, `listenOptions`, `layerAuth`, `layer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Binds the assembled gateway to a Node HTTP server under the bind and credential policy.                          |
| `SuperviseRuntime`          | `StaleRunningCandidate`, `QuotaDueCandidate`, `StaleClaimCandidate`, `Candidate`, `ResumeLease`, `ResumeErrorCode`, `ResumeError`, `Service`, `SuperviseRuntime`, `make`, `makeNoop`, `layerNoop`                                                                                                                                                                                                                                                                                                                                                                             | Defines the host port used to discover and resume stale or quota-due work.                                       |
| `Sync.RunCatalog`           | `Service`, `RunCatalog`, `make`, `makeMemory`, `layerStatic`, `layerNoop`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Defines the synchronized run-catalog service and its static, memory, and noop implementations.                   |
| `Sync.SyncClient`           | `SubscribeOptions`, `Service`, `Sync`, `make`, `makeNoop`, `layer`, `layerNoop`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Provides read and subscription synchronization through the RPC client.                                           |
| `Sync.SyncError`            | `ErrorCode`, `SyncError`, `SyncGapError`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Defines synchronization and cursor-gap failures.                                                                 |
| `Sync.SyncProtocol`         | `RunScope`, `WorkspaceScope`, `Scope`, `RunCursor`, `WorkspaceCursor`, `ReadRequest`, `ReadResponse`, `SubscribeRequest`, `EntriesFrame`, `HeartbeatFrame`, `ClosedFrame`, `Frame`, `covers`                                                                                                                                                                                                                                                                                                                                                                                  | Supplies schemas and cursor coverage checks for read and subscription synchronization.                           |
| `Sync.SyncRpcs`             | `SyncAuth`, `SyncRpcs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Declares the authenticated synchronization RPC group.                                                            |
| `Sync.SyncServer`           | `Service`, `SyncServer`, `make`, `makeLive`, `makeNoop`, `layer`, `layerNoop`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Serves synchronization reads and subscriptions over the journal.                                                 |
| `test/TestSuperviseRuntime` | `TestSuperviseRuntimeOptions`, `TestSuperviseRuntime`, `make`, `layer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Provides a controllable supervision test service at `@smthrs/gateway/test/TestSuperviseRuntime`.                 |

## Mounts

| Path                | Protocol           | Serves                                                 |
| ------------------- | ------------------ | ------------------------------------------------------ |
| `POST /rpc`         | RPC over HTTP      | `@smthrs/control` `ControlRpcs`                        |
| `/rpc/ws`           | RPC over WebSocket | `ControlRpcs`, including a kept-alive `Watch`          |
| `POST /projections` | RPC over HTTP      | `GatewayRpcs`                                          |
| `/projections/ws`   | RPC over WebSocket | `GatewayRpcs`, including `Projection.Subscribe`        |
| `POST /sync`        | RPC over HTTP      | `@smthrs/sync` `SyncRpcs`                              |
| `/sync/ws`          | RPC over WebSocket | `SyncRpcs`                                             |
| `GET /health`       | JSON               | `GatewaySchema.GatewayHealth` plus the package version |

`GET /health` is unauthenticated: a supervisor decides whether to keep or
replace a gateway process by asking which workspace it belongs to, and a probe
that needed a credential could not answer that about a gateway it did not
start. The response carries identity only.

Every other mount is authenticated. A loopback bind may run without a
credential, because the trust boundary there is the machine account. A
non-loopback bind requires both an explicit `listen` opt-in and a bearer
credential, and refuses to start without either.

Both WebSocket mounts emit a keepalive every 30 seconds, comfortably inside
the 600-second idle cut a relay applies, and each carries it in the shape its
own procedure answers with. `Projection.Subscribe` on `/projections/ws` sends a
`GatewaySchema.HeartbeatFrame`. `Watch` on `/rpc/ws` answers control events and
has no frame of its own, so the gateway merges an event whose kind is
`GatewayServer.watchHeartbeatKind` (`control.gateway.heartbeat`) into a
followed stream: it repeats the last sequence delivered, so a client resuming
from the sequence it last saw does not rewind, and a fold that does not know
the kind ignores it. A snapshot read (`follow: false`) carries none, because it
ends on its own. `NodeGateway.ServerOptions.heartbeatMillis` shortens the
cadence for a relay whose idle cut is shorter.

```ts
import { NodeGateway } from "@smthrs/gateway/node/NodeGateway"

// The composition a `smithers serve` verb hosts. The caller supplies
// `Control`, `Projections`, `SyncServer`, and the `SyncAuth` middleware.
const gateway = NodeGateway.layer(
  { workspaceHash: "…", gatewayId: "…", protocolVersion: "1", version: "1.0.0-rc.0" },
  { host: "0.0.0.0", port: 7331, listen: true, credential: process.env.SMITHERS_API_KEY }
)
```

```ts
import { SuperviseRuntime } from "@smthrs/gateway"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const runtime = yield* SuperviseRuntime.SuperviseRuntime
  return yield* runtime.scan(Date.now())
}).pipe(Effect.provide(SuperviseRuntime.layerNoop()))
```

## Alpha supervision posture

The package does not currently ship a production supervision layer.
`makeNoop` and `layerNoop` are closed stubs: unless overridden, scanning
returns no candidates and resuming performs no work. The gateway does not wire
this port to the durable engine's run-driver sweep, so a run abandoned through
the gateway is not automatically discovered, reclaimed, or resumed. Alpha
operators must recover such runs explicitly or use a host composition that
runs the durable engine driver with the relevant flows registered. See the
[private alpha notes](../../docs/alpha-notes.md) for the supported posture.

`@smthrs/gateway/package.json` is also exported. `internal/*` and nested `*/index` subpaths are not public.
