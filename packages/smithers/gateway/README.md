# @smthrs/gateway

**Documentation:** https://gateway.smithers.sh

The assembled workspace gateway: one HTTP surface carrying the control plane, the sync read path, the served projections, and a health probe. It also defines the gateway wire schemas and the stale-run supervision port, and re-exports the durable journal synchronization package gateway hosts use.

```sh
npm install @smthrs/gateway
```

The mounts, the bind and credential policy, the projections and their rows, the subscription and cursor semantics, every failure code with the status it answers, and the resource limits are documented once, on [the API page](https://smithers.sh/api/gateway). This file lists what the package exports and shows how a host composes it.

## Public API

The root entry point exports these namespaces; local modules are also importable from `@smthrs/gateway/<Module>`.

| Module                      | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Description                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `GatewayError`              | `GatewayErrorCode`, `GatewayError`, `settingRefusal`                                                                                                                                                                                                                                                                                                                                                                                                                           | Defines the stable failure codes and the refusal a bad setting earns.                   |
| `GatewaySchema`             | `Workspace`, `GatewayConfig`, `GatewayStatus`, `GatewayHealth`, `ProjectionName`, `WorkspaceRunsSelector`, `RunSummarySelector`, `RunEventsSelector`, `TranscriptSelector`, `RunTreeSelector`, `ApprovalsSelector`, `NodeOutputSelector`, `ProjectionSelector`, `rowSchemaFor`, `ProjectionCursor`, `ProjectionSnapshot`, `SnapshotStartFrame`, `RowFrame`, `SnapshotEndFrame`, `DeltaFrame`, `HeartbeatFrame`, `GatewayFrame`, `SingletonRecord`, `TokenScope`, `TokenRecord` | Supplies the wire schemas for projections, cursors, snapshots, and frames.              |
| `Diagnosis`                 | `RunStatus`, `Refusal`, `Digest`, `clip`, `digest`, `duration`, `verdict`, `Subject`, `render`                                                                                                                                                                                                                                                                                                                                                                                 | Computes and renders what happened to a run, from that run's own control events.        |
| `GatewayProjection`         | `RunSummaryRow`, `RunTreeRow`, `ApprovalRow`, `NodeOutputRow`, `TranscriptRow`, `runSummary`, `runTree`, `approvals`, `nodeOutput`, `transcript`                                                                                                                                                                                                                                                                                                                               | Defines the served wire rows and the pure folds that compute them.                      |
| `GatewayRpcs`               | `Decision`, `SubmitApprovalInput`, `SubmitApprovalOutput`, `GatewayRpcs`                                                                                                                                                                                                                                                                                                                                                                                                       | Declares the served read path and the composite approval mutation.                      |
| `GatewayServer`             | `Health`, `layerHealth`, `layerHandlers`, `watchHeartbeatKind`, `layerKeepAlive`, `layerControlHttp`, `layerProjectionsHttp`, `layerSyncHttp`, `rpcPaths`, `protectedPaths`, `routedPath`, `defaultMaxRequestBodyBytes`, `IngressOptions`, `exceededBodyLimit`, `bodyRefusal`, `carriesRpcRequest`, `layerIngress`, `LayerOptions`, `layer`                                                                                                                                    | Assembles the whole HTTP surface as one application layer a host serves.                |
| `Projections`               | `heartbeatIntervalMillis`, `maxWorkspaceRuns`, `maxEventsPerRun`, `maxProjectionBytes`, `Service`, `Projections`, `make`, `layer`, `layerWith`                                                                                                                                                                                                                                                                                                                                 | Serves the bounded read path as snapshots and followed deltas.                          |
| `SuperviseRuntime`          | `StaleRunningCandidate`, `QuotaDueCandidate`, `StaleClaimCandidate`, `Candidate`, `ResumeLease`, `ResumeErrorCode`, `ResumeError`, `Service`, `SuperviseRuntime`, `make`, `makeNoop`, `layerNoop`                                                                                                                                                                                                                                                                              | Declares the host seam used to discover and resume stale or quota-due work.             |
| `Sync`                      | `RunCatalog`, `SyncClient`, `SyncError`, `SyncProtocol`, `SyncRpcs`, `SyncServer`                                                                                                                                                                                                                                                                                                                                                                                              | Re-exports `@smthrs/sync`, the read-only journal replication protocol.                  |
| `node/NodeGateway`          | `ServerOptions`, `defaultServerOptions`, `isLoopbackHost`, `bindRefusal`, `listenOptions`, `layerAuth`, `layer`                                                                                                                                                                                                                                                                                                                                                                | Binds the assembled gateway to a Node HTTP server under the bind and credential policy. |
| `test/TestSuperviseRuntime` | `TestSuperviseRuntimeOptions`, `TestSuperviseRuntime`, `make`, `layer`                                                                                                                                                                                                                                                                                                                                                                                                         | Provides a controllable supervision test service.                                       |

`test/ReadmeExports.test.ts` diffs this table against `Object.keys` of every module, so a new export cannot land without a row.

## Hosting it

```ts
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"

// The composition a `smithers serve` verb hosts. The caller supplies
// `Control`, `Projections`, `SyncServer`, and the `SyncAuth` middleware.
const gateway = NodeGateway.layer(
  { workspaceHash: "…", gatewayId: "…", protocolVersion: "1", version: "1.0.0-rc.0" },
  { host: "0.0.0.0", port: 7331, listen: true, credential: process.env.SMITHERS_API_KEY }
)
```

A bind the policy or operating system refuses fails the layer with a sanitized `bind_failed` `GatewayError`. A host can inspect policy before composing the layer:

```ts
const refusal = NodeGateway.bindRefusal({ host: "0.0.0.0", port: 7331 })
// => GatewayError { code: "bind_failed", message: "Refusing non-loopback gateway bind 0.0.0.0 without an explicit --listen opt-in" }
```

## Supervision posture at 1.0.0-rc.0

The package ships no production supervision layer. `makeNoop` and `layerNoop` are closed stubs: unless overridden, scanning returns no candidates and resuming performs no work. Nothing wires this port to the durable engine's run-driver sweep, so a run abandoned through the gateway is not automatically discovered, reclaimed, or resumed.

Recovery is a reclaim rather than a supervisor. A run becomes reclaimable once the heartbeat its owner stopped renewing is older than 30 seconds, and any running `smithers` process with the flow registered takes it over. Nothing outside such a process watches for dead owners, so an operator either brings up a host composition running the durable engine driver with the relevant flows registered, or recovers the run explicitly.

```ts
import { SuperviseRuntime } from "@smthrs/gateway"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const runtime = yield* SuperviseRuntime.SuperviseRuntime
  return yield* runtime.scan(Date.now())
}).pipe(Effect.provide(SuperviseRuntime.layerNoop()))
```

`@smthrs/gateway/package.json` is also exported. `internal/*` and nested `*/index` subpaths are not public.
