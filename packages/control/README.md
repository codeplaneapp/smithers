# @smthrs/control

Browser-safe control-plane contracts and projections for flows. It defines the transport-independent Control service, its runtime and execution ports, local and RPC implementations, verified ingress channels, credentials, and shared wire schemas.

```sh
npm install @smthrs/control
```

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/control/<Module>`.

| Module             | Public exports                                                                                                                                                                                                                                                   | Description                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `Channels`         | `RawInbound`, `InboundResult`, `Delivery`, `DeliveryProjection`, `Channel`, `IngestRequest`, `ProjectRequest`, `Channels`, `make`, `layer`                                                                                                                       | Verifies, decodes, dispatches, and projects inbound channel deliveries.                              |
| `Control`          | `PlanInput`, `RunInput`, `ApprovalTarget`, `ApprovalInput`, `SteerInput`, `SignalInput`, `RunMutationInput`, `Service`, `Control`, `make`, `layerNoop`                                                                                                           | Defines the authoritative plan, run, approval, steering, signal, lifecycle, list, and watch service. |
| `ControlClient`    | `isControlError`, `ClientConfig`, `layer`                                                                                                                                                                                                                        | Provides Control through the Effect RPC client and normalizes transport failures.                    |
| `ControlError`     | `RunNotFound`, `FlowNotFound`, `PlanDigestMismatch`, `EnvelopeMismatch`, `ClaimLost`, `AlreadyResolved`, `InvalidInput`, `Unauthorized`, `Unavailable`, `TransportError`, `PersistenceError`, `LaunchFailed`, `ControlError`                                     | Defines the serializable error classes and their union.                                              |
| `ControlExecutor`  | `Launch`, `Acceptance`, `Service`, `ControlExecutor`, `make`, `makeNoop`, `layer`, `layerNoop`                                                                                                                                                                   | Accepts approved launches into a real run executor.                                                  |
| `ControlLive`      | `layer`                                                                                                                                                                                                                                                          | Implements Control in process over ControlRuntime, Journal, and Registry.                            |
| `ControlRpcs`      | `ControlPrincipal`, `ControlAuth`, `ControlRpcs`, `Authenticator`, `BearerAuthOptions`, `bearerAuthenticator`, `layerAuth`, `layerBearerAuth`, `layerNoopAuth`                                                                                                   | Declares the schema-native RPC group and authentication middleware.                                  |
| `ControlRuntime`   | `StoredPlan`, `ApprovalToken`, `BulkGrant`, `LaunchResult`, `MutationRecord`, `MemoryFlow`, `MemoryOptions`, `Service`, `ControlRuntime`, `make`, `layerMemory`                                                                                                  | Defines the engine-state port and its deterministic in-memory layer.                                 |
| `ControlSchema`    | `RunId`, `FlowId`, `IdempotencyKey`, `Principal`, `Envelope`, `GrantScope`, `ApprovalTarget`, `ApprovalPayload`, `PlanCard`, `RunStatus`, `RunSummary`, `SteerMessage`, `SignalPayload`, `WatchFilter`, `ControlEvent`, `ListRequest`, `ListResponse`, `Receipt` | Supplies schemas and inferred types shared by local and RPC projections.                             |
| `ControlServer`    | `layer`, `layerHttp`                                                                                                                                                                                                                                             | Serves Control through RPC handlers and HTTP/WebSocket transports.                                   |
| `Credential`       | `CredentialRef`, `Credential`, `makeNoop`, `layerNoop`                                                                                                                                                                                                           | Defines opaque credential references and the redacted resolution boundary.                           |
| `SystemFlows`      | `SystemFlowEntry`, `catalog`                                                                                                                                                                                                                                     | Owns the reserved system-flow verb catalogue.                                                        |
| `WebhookChannel`   | `SignatureVerifier`, `Config`, `make`, `handler`                                                                                                                                                                                                                 | Builds a schema-declared, signature-verified webhook channel and HTTP handler.                       |
| `test/TestControl` | `layer`                                                                                                                                                                                                                                                          | Provides the public in-memory Control test layer at `@smthrs/control/test/TestControl`.              |

```ts
import { Control } from "@smthrs/control"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const control = yield* Control.Control
  return yield* control.list({ _tag: "runs" })
}).pipe(Effect.provide(Control.layerNoop))
```

Use `ControlLive.layer` for in-process operation, `ControlClient.layer({ url, credential })` for authenticated RPC, or `ControlRuntime.layerMemory()` when assembling a deterministic runtime. `@smthrs/control/package.json` is also exported; `internal/*` and nested `*/index` subpaths are blocked.
