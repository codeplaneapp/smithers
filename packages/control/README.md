# @smthrs/control

Control services and RPC projections for flows. It defines the
transport-independent Control service, its runtime and execution ports, local
and RPC implementations, verified ingress channels, credentials, and the shared
wire schemas both halves decode.

```sh
npm install @smthrs/control
```

Nothing here imports `node:*`, but the 1.0.0-rc.0 support matrix records
`@smthrs/control` as **no claim (no `node:` imports)**: it is not one of the 28
entry points `scripts/browser-check.mjs` bundles, so no gate proves it bundles
in a browser. Read the claim as what it is, an absence of `node:` imports rather
than a tested guarantee.

## Public API

The root entry point exports these namespaces; each is also importable from
`@smthrs/control/<Module>`. The table is generated from `src/index.ts` by
`node packages/control/scripts/docs.mjs`, so an export that gains an
`@category` tag appears here without anyone remembering to add it.

{/* generated:control-modules start */}

| Module | Export | Kind | Summary |
| --- | --- | --- | --- |
| `Control` | `PlanInput` (interface) | models | Raw input submitted to planning. |
| `Control` | `RunInput` (type) | models | Starts an approved plan or joins/resumes an existing run. |
| `Control` | `ApprovalInput` (interface) | models | Full approval decision submitted to the authenticated server boundary. |
| `Control` | `SteerInput` (type) | models | Steering mutation arguments. |
| `Control` | `SignalInput` (type) | models | Signal mutation arguments. |
| `Control` | `RunMutationInput` (interface) | models | Run lifecycle mutation arguments. |
| `Control` | `Service` (interface) | models | Transport-independent control operations. |
| `Control` | `Control` (class) | services | Service key for the authoritative control-plane vtable. |
| `Control` | `make` (const) | constructors | Constructs a control service from an implementation record. |
| `Control` | `layerNoop` (const) | layers | Provides an unavailable control implementation for optional integrations. |
| `ControlError` | `RunNotFound` (class) | errors | No run with this id exists. |
| `ControlError` | `PlanNotFound` (class) | errors | No plan with this id exists. |
| `ControlError` | `PlanDenied` (class) | errors | The plan was denied and cannot be launched. |
| `ControlError` | `FlowNotFound` (class) | errors | No flow with this id is registered. |
| `ControlError` | `PlanDigestMismatch` (class) | errors | The submitted plan does not hash to the digest the caller declared, so the control plane refuses to store it. |
| `ControlError` | `EnvelopeMismatch` (class) | errors | The plan's effect envelope differs from the one the caller declared. |
| `ControlError` | `ClaimLost` (class) | errors | The caller's claim on this run lapsed or was fenced by a newer owner. |
| `ControlError` | `AlreadyResolved` (class) | errors | This request was already answered; a second answer is refused rather than overwriting the first. |
| `ControlError` | `InvalidInput` (class) | errors | The request did not satisfy its schema or a stated precondition. |
| `ControlError` | `Unauthorized` (class) | errors | The caller presented no usable credential for this operation. |
| `ControlError` | `Unavailable` (class) | errors | The operation is not implemented in this deployment. |
| `ControlError` | `TransportError` (class) | errors | The request did not reach the control plane, or its reply did not come back. |
| `ControlError` | `PersistenceError` (class) | errors | A control-plane store operation failed. |
| `ControlError` | `LaunchFailed` (class) | errors | The executor refused or could not start the run. |
| `ControlError` | `NoMatchingWait` (class) | errors | A signal named a wait point the run does not have open. |
| `ControlError` | `CredentialConflict` (class) | errors | A credential write lost a race: the record moved on before this writer committed, so the update is refused rather than silently overwriting the winner. |
| `ControlError` | `ControlErrorSchema` (const) | errors | Every stable failure emitted by the control plane, as one schema. |
| `ControlError` | `ControlError` (type) | errors | Every stable failure emitted by the control plane. |
| `ControlSchema` | `RunId` (const) | models | A durable control-plane run identifier. |
| `ControlSchema` | `RunId` (type) | models | A durable control-plane run identifier. |
| `ControlSchema` | `FlowId` (const) | models | A registry flow identifier. |
| `ControlSchema` | `FlowId` (type) | models | A registry flow identifier. |
| `ControlSchema` | `IdempotencyKey` (const) | models | A caller-supplied key that makes a control mutation idempotent. |
| `ControlSchema` | `IdempotencyKey` (type) | models | A caller-supplied key that makes a control mutation idempotent. |
| `ControlSchema` | `Principal` (const) | models | A server-authenticated identity stamped at the control boundary. |
| `ControlSchema` | `Principal` (type) | models | A server-authenticated identity stamped at the control boundary. |
| `ControlSchema` | `Envelope` (const) | models | The capabilities, flows, budget, and placement approved for a plan. |
| `ControlSchema` | `Envelope` (type) | models | The capabilities, flows, budget, and placement approved for a plan. |
| `ControlSchema` | `GrantScope` (const) | models | The durability selected for an approval grant. |
| `ControlSchema` | `GrantScope` (type) | models | The durability selected for an approval grant. |
| `ControlSchema` | `ApprovalTarget` (const) | models | A plan or in-run approval target. |
| `ControlSchema` | `ApprovalTarget` (type) | models | A plan or in-run approval target. |
| `ControlSchema` | `ApprovalPayload` (const) | models | The complete, reviewable payload emitted by planning and submitted unchanged when an approval decision is made. |
| `ControlSchema` | `ApprovalPayload` (type) | models | The complete, reviewable payload emitted by planning. |
| `ControlSchema` | `PlanNodeStatus` (const) | models | What `smithers plan` reports for one node before anything runs. |
| `ControlSchema` | `PlanNodeStatus` (type) | models | What `smithers plan` reports for one node before anything runs. |
| `ControlSchema` | `PlanNode` (const) | models | One keyed node of the plan an approval is being taken on. |
| `ControlSchema` | `PlanNode` (type) | models | One keyed node of the plan an approval is being taken on. |
| `ControlSchema` | `PlanCard` (const) | models | The reviewable, signed payload returned by planning and resubmitted to approval without reconstructing authority client-side. |
| `ControlSchema` | `PlanCard` (type) | models | The reviewable, signed payload returned by planning and resubmitted to approval without reconstructing authority client-side. |
| `ControlSchema` | `RunStatus` (const) | models | Stable statuses projected for a durable run. |
| `ControlSchema` | `RunStatus` (type) | models | Stable statuses projected for a durable run. |
| `ControlSchema` | `RunOrigin` (const) | models | How a run came to exist, when it did not start on its own. |
| `ControlSchema` | `RunOrigin` (type) | models | How a run came to exist, when it did not start on its own. |
| `ControlSchema` | `CancelSource` (const) | models | Where a cancellation came from. |
| `ControlSchema` | `CancelSource` (type) | models | Where a cancellation came from. |
| `ControlSchema` | `Cancellation` (const) | models | Who cancelled a run, why, and on whose behalf. |
| `ControlSchema` | `Cancellation` (type) | models | Who cancelled a run, why, and on whose behalf. |
| `ControlSchema` | `RunSummary` (const) | models | A compact summary for run listings and status projections. |
| `ControlSchema` | `RunSummary` (type) | models | A compact summary for run listings and status projections. |
| `ControlSchema` | `MessageSteer` (const) | models | An operator message inserted into the transcript at the next turn boundary. |
| `ControlSchema` | `SeatSteer` (const) | models | A model-seat change that applies from the next turn on. |
| `ControlSchema` | `ThinkingSteer` (const) | models | A thinking-level change that applies from the next turn on. |
| `ControlSchema` | `ToolsSteer` (const) | models | Tools added to the active set for future turns. |
| `ControlSchema` | `SteerMessage` (const) | models | A durable operator steer delivered at an execution turn boundary. |
| `ControlSchema` | `SteerMessage` (type) | models | A durable operator steer delivered at an execution turn boundary. |
| `ControlSchema` | `steerItem` (const) | conversions | The stored steering item one steer carries. |
| `ControlSchema` | `SignalPayload` (const) | models | A durable, named signal delivered to a waiting run. |
| `ControlSchema` | `SignalPayload` (type) | models | A durable, named signal delivered to a waiting run. |
| `ControlSchema` | `PlanInputSchema` (const) | models | The RPC request schema for planning. |
| `ControlSchema` | `RunInputSchema` (const) | models | The RPC request schema for starting a plan or resuming a run. |
| `ControlSchema` | `ApprovalInputSchema` (const) | models | The RPC request schema for an approval decision. |
| `ControlSchema` | `SteerInputSchema` (const) | models | The RPC request schema for steering a run. |
| `ControlSchema` | `SignalInputSchema` (const) | models | The RPC request schema for signaling a run. |
| `ControlSchema` | `RunMutationInputSchema` (const) | models | The shared fields of an RPC run mutation request. |
| `ControlSchema` | `ReasonedMutationInputSchema` (const) | models | The RPC request schema for a lifecycle mutation that records a reason. |
| `ControlSchema` | `CancelInputSchema` (const) | models | The RPC request schema for cancellation. |
| `ControlSchema` | `WatchFilter` (const) | models | A journal-projection cursor, optional run restriction, and delivery mode. |
| `ControlSchema` | `WatchFilter` (type) | models | A resumable journal-projection watch cursor and optional run restriction. |
| `ControlSchema` | `ControlEvent` (const) | models | One ordered journal-projection delta streamed by `watch`. |
| `ControlSchema` | `ControlEvent` (type) | models | One ordered journal-projection delta streamed by `watch`. |
| `ControlSchema` | `defaultPageSize` (const) | models | How many items a listing returns when the caller names no `limit`. |
| `ControlSchema` | `maxPageSize` (const) | models | The largest `limit` a listing accepts. |
| `ControlSchema` | `PageLimit` (const) | models | A page size a listing can actually make progress on. |
| `ControlSchema` | `ListRequest` (const) | models | A typed listing request for discovered flows or durable runs. |
| `ControlSchema` | `ListRequest` (type) | models | A typed listing request for discovered flows or durable runs. |
| `ControlSchema` | `ListResponse` (const) | models | A typed page returned for a flow or run listing. |
| `ControlSchema` | `ListResponse` (type) | models | A typed page returned for a flow or run listing. |
| `ControlSchema` | `Receipt` (const) | models | The idempotent outcome returned by every control mutation. |
| `ControlSchema` | `Receipt` (type) | models | The idempotent outcome returned by every control mutation. |
| `Cancellation` | `requestedEventType` (const) | constants | The journal event type the control plane records an attributed cancel under. |
| `Cancellation` | `interruptedEventType` (const) | constants | The journal event type the engine records an interruption under. |
| `Cancellation` | `Request` (interface) | models | One attributed cancel request, as the control plane journaled it. |
| `Cancellation` | `Evidence` (interface) | models | What one run row discloses about its own cancellation. |
| `Cancellation` | `Input` (interface) | models | Everything the fold reads. |
| `Cancellation` | `attribute` (const) | projections | Attributes every cancelled run in one pass. |
| `Lineage` | `Origin` (const) | models | How a run came to exist. |
| `Lineage` | `Origin` (type) | models | How a run came to exist. |
| `Lineage` | `Ancestry` (interface) | models | The ancestry facts an origin is decided from. |
| `Lineage` | `runDecisionEventType` (const) | constants | The journal event type carrying an engine run decision. |
| `Lineage` | `forkCreatedEventType` (const) | constants | The journal event type time travel writes on a forked child. |
| `Lineage` | `lineageEventType` (const) | constants | The kind `watch` reports a derived ancestry delta under. |
| `Lineage` | `originOf` (const) | projections | Decides how a run came to exist from its ancestry facts. |
| `Lineage` | `derive` (const) | projections | Derives the ancestry edge one journal entry discloses, if it discloses one. |
| `Lineage` | `expand` (const) | projections | Expands one projected entry into itself plus any ancestry delta it discloses. |
| `Monitor` | `attemptStartedEventType` (const) | constants | The journal event type the engine records when an action attempt starts. |
| `Monitor` | `attemptFinishedEventType` (const) | constants | The journal event type the engine records when an action attempt settles. |
| `Monitor` | `beatEventType` (const) | constants | The journal event type one monitor beat is recorded under. |
| `Monitor` | `healedEventType` (const) | constants | The journal event type one applied remedy is recorded under. |
| `Monitor` | `Health` (const) | models | What a run looks like to a monitor. |
| `Monitor` | `Health` (type) | models | What a run looks like to a monitor. |
| `Monitor` | `Observation` (interface) | models | Everything one classification is decided from. |
| `Monitor` | `classify` (const) | projections | Decides what a run's state means. |
| `Monitor` | `Remedy` (type) | models | What a monitor does about one unhealthy run. |
| `Monitor` | `remedyFor` (const) | projections | The remedy a health warrants, before `autoHeal` decides whether to apply it. |
| `Monitor` | `Beat` (interface) | models | One beat of a monitor. |
| `Monitor` | `Report` (interface) | models | What a monitor found. |
| `Monitor` | `Options` (interface) | models | How a monitor beats. |
| `Monitor` | `run` (const) | constructors | Watches one run and, when told to, heals it. |
| `Steering` | `promotedEventType` (const) | constants | The journal event type the notification queue records a promotion under. |
| `Steering` | `deliveredEventType` (const) | constants | The kind `watch` reports one delivered steer under. |
| `Steering` | `enqueuedEventType` (const) | constants | The kind `Control.steer` records an accepted steer under. |
| `Steering` | `derive` (const) | projections | Derives one delivery delta per message a promotion entry named. |
| `Steering` | `expand` (const) | projections | Expands one projected entry into itself plus any deliveries it discloses. |
| `ControlRuntime` | `StoredPlan` (interface) | models | A decoded input and immutable plan stored before execution. |
| `ControlRuntime` | `ApprovalToken` (interface) | models | One unresolved durable approval token. |
| `ControlRuntime` | `BulkGrant` (interface) | models | One bulk permission grant. |
| `ControlRuntime` | `LaunchResult` (type) | models | Result of launching an approved plan. |
| `ControlRuntime` | `PlanOutcome` (interface) | models | A plan card and whether this call is the one that created it. |
| `ControlRuntime` | `MutationRecord` (interface) | models | A stored idempotency-key outcome and the mutation fingerprint that produced it. |
| `ControlRuntime` | `MemoryFlow` (interface) | models | Flow metadata used by the memory runtime's input-decoding hook. |
| `ControlRuntime` | `MemoryOptions` (interface) | models | In-memory runtime configuration. |
| `ControlRuntime` | `PendingResume` (interface) | models | One run that has been told to resume, and the sequence of the request. |
| `ControlRuntime` | `Service` (interface) | models | Execution-engine operations required by `ControlLive`. |
| `ControlRuntime` | `ControlRuntime` (class) | services | Service key for the execution-engine port. |
| `ControlRuntime` | `make` (const) | constructors | Constructs a runtime service from an implementation record. |
| `ControlRuntime` | `layerMemory` (const) | layers | Deterministic in-memory runtime. |
| `ControlExecutor` | `Launch` (interface) | models | One stored plan and the run summary it is being started as. |
| `ControlExecutor` | `Acceptance` (type) | models | Whether the executor took the launch now or queued it. |
| `ControlExecutor` | `CancelRequest` (interface) | models | One run whose cancellation has to become durable on the engine row. |
| `ControlExecutor` | `CancelTerminal` (interface) | models | The engine row a cancel request arrived too late for. |
| `ControlExecutor` | `CancelRecord` (type) | models | What the executor did with a cancel request. |
| `ControlExecutor` | `ResumeRequest` (interface) | models | One parked run that has been told to resume. |
| `ControlExecutor` | `ResumeUptake` (type) | models | What the executor did with a resume request. |
| `ControlExecutor` | `Signal` (interface) | models | One signal to deliver to a run's open wait point. |
| `ControlExecutor` | `SignalDelivery` (type) | models | What the executor did with a signal. |
| `ControlExecutor` | `Service` (interface) | services | The executor port: the control plane hands work over to a real run executor and learns only what the executor did with it. |
| `ControlExecutor` | `ControlExecutor` (class) | services | The `Service` tag. |
| `ControlExecutor` | `make` (const) | constructors | Builds a `Service` from an implementation of its methods. |
| `ControlExecutor` | `makeNoop` (const) | constructors | A `Service` that accepts every launch as `pending` and starts nothing. |
| `ControlExecutor` | `layer` (const) | layers | Provides `ControlExecutor` from an implementation. |
| `ControlExecutor` | `layerNoop` (const) | layers | Provides `makeNoop`. |
| `ControlLive` | `layer` (const) | layers | Live in-process Control layer. |
| `SystemFlows` | `SystemFlowEntry` (interface) | models | The projection metadata for one reserved system flow. |
| `SystemFlows` | `catalog` (const) | models | The authoritative command-line verb to reserved-flow map. |
| `SystemFlows` | `plannable` (const) | models | The catalog entries a control runtime may offer as flows. |
| `ControlRpcs` | `ControlPrincipal` (class) | services | Authenticated principal made available to control RPC handlers. |
| `ControlRpcs` | `ControlAuth` (class) | middleware | Middleware boundary that authenticates control RPC requests. |
| `ControlRpcs` | `ControlRpcs` (const) | groups | The ten remote procedures corresponding to `Control` operations. |
| `ControlRpcs` | `Authenticator` (interface) | models | Header authenticator used by the control RPC boundary. |
| `ControlRpcs` | `BearerAuthOptions` (interface) | models | Configuration for the single-token bearer authenticator. |
| `ControlRpcs` | `bearerAuthenticator` (const) | constructors | Authenticates one shared bearer token and stamps its server-owned principal. |
| `ControlRpcs` | `layerAuth` (const) | layers | Provides `ControlAuth` from a transport-header authenticator. |
| `ControlRpcs` | `layerBearerAuth` (const) | layers | Provides `ControlAuth` using one shared bearer token. |
| `ControlRpcs` | `layerNoopAuth` (const) | layers | Permissive authentication middleware for tests and trusted in-process use. |
| `ControlServer` | `layer` (const) | layers | Control RPC handlers delegating to the transport-independent service. |
| `ControlServer` | `layerHttp` (const) | layers | Mounts control RPC on the ambient `HttpRouter`: unary procedures over POST `/rpc` and the `watch` stream over WebSocket `/rpc/ws`. |
| `ControlClient` | `isControlError` (const) | refinements | Whether a value is one of the control plane's declared failures, as opposed to a defect that escaped some other layer. |
| `ControlClient` | `ClientConfig` (interface) | models | Client transport configuration. |
| `ControlClient` | `layer` (const) | layers | Provides `Control` through an RPC client while preserving the local vtable. |
| `Channels` | `RawInbound` (interface) | models | Opaque request data passed to a channel before decoding. |
| `Channels` | `InboundResult` (type) | models | The channel mapping after a verified payload has been decoded. |
| `Channels` | `Delivery` (interface) | models | A persisted per-channel delivery record. |
| `Channels` | `DeliveryProjection` (interface) | models | A side-effect-free outbound projection. |
| `Channels` | `Channel` (interface) | services | A bidirectional platform adapter. |
| `Channels` | `IngestRequest` (interface) | models | Arguments for ingesting one authenticated channel request. |
| `Channels` | `ProjectRequest` (interface) | models | Arguments for projecting one run onto a channel. |
| `Channels` | `Channels` (interface) | services | The channel coordinator. |
| `Channels` | `Channels` (const) | services | Service tag for channel registration, ingestion, and pure projection. |
| `Channels` | `make` (const) | constructors | Builds the coordinator over Control's durable mutation store. |
| `Channels` | `makeMemory` (const) | constructors | Builds a process-local coordinator for adapter unit tests. |
| `Channels` | `layer` (const) | layers | Channel layer with durable inbound receipts supplied by `ControlRuntime`. |
| `Channels` | `layerMemory` (const) | layers | Process-local channel layer for adapter unit tests only. |
| `WebhookChannel` | `SignatureVerifier` (type) | models | Signature verifier injected by a webhook transport. |
| `WebhookChannel` | `Config` (interface) | models | Configuration for a schema-declared webhook channel. |
| `WebhookChannel` | `make` (const) | constructors | Builds a webhook channel. |
| `WebhookChannel` | `handler` (const) | handlers | Reads an abstract Effect HTTP request and dispatches it through Channels. |
| `Credential` | `CredentialRef` (interface) | models | A journal-safe name for a stored connection credential. |
| `Credential` | `Operation` (type) | models | One credential operation, as seen by a host authorization policy. |
| `Credential` | `Credential` (interface) | services | Adapter-bound credential resolution. |
| `Credential` | `Credential` (const) | services | Service tag for credential resolution. |
| `Credential` | `makeNoop` (const) | constructors | A credential implementation that explicitly reports unavailable storage. |
| `Credential` | `layerNoop` (const) | layers | Layer for the unavailable credential-storage boundary. |
| `Credential` | `Options` (interface) | models | The collaborators a working credential boundary needs. |
| `Credential` | `make` (const) | constructors | Constructs a working credential boundary over a store and a cipher. |
| `Credential` | `layer` (const) | layers | Provides a working credential boundary over the ambient store and cipher. |
| `CredentialCipher` | `Sealed` (interface) | models | One encrypted secret: base64 ciphertext and the nonce it was sealed under. |
| `CredentialCipher` | `Service` (interface) | services | Authenticated encryption over credential plaintext. |
| `CredentialCipher` | `CredentialCipher` (class) | services | Service key for credential encryption. |
| `CredentialCipher` | `make` (const) | constructors | Constructs a cipher from an implementation record. |
| `CredentialCipher` | `unavailable` (const) | constructors | The typed failure a host reports when no secure key material is reachable. |
| `CredentialCipher` | `makeNoop` (const) | constructors | A cipher that reports unavailable key material for every operation. |
| `CredentialCipher` | `layerNoop` (const) | layers | Provides a cipher that reports unavailable key material. |
| `CredentialStore` | `SealedRecord` (interface) | models | One credential at rest: opaque metadata plus the sealed secret. |
| `CredentialStore` | `Service` (interface) | services | The persistence operations `Credential` needs. |
| `CredentialStore` | `CredentialStore` (class) | services | Service key for encrypted credential persistence. |
| `CredentialStore` | `make` (const) | constructors | Constructs a store from an implementation record. |
| `CredentialStore` | `makeNoop` (const) | constructors | A store that reports unavailable persistence for every operation. |
| `CredentialStore` | `layerNoop` (const) | layers | Provides a store that reports unavailable persistence. |
| `CredentialStore` | `makeMemory` (const) | constructors | Constructs a process-local store. |
| `CredentialStore` | `layerMemory` (const) | layers | Provides a process-local store. |
| `SqlCredentialStore` | `migrate` (const) | migrations | Creates the credential table if it does not exist. |
| `SqlCredentialStore` | `make` (const) | constructors | Constructs a durable credential store over the ambient database. |
| `SqlCredentialStore` | `layer` (const) | layers | Provides durable credential persistence over the ambient database. |
| `WebCryptoCipher` | `Options` (interface) | models | Host-managed key material for the cipher. |
| `WebCryptoCipher` | `make` (const) | constructors | Imports the host key and constructs the cipher. |
| `WebCryptoCipher` | `layer` (const) | layers | Provides AES-256-GCM credential encryption under a host-managed key. |
| `SqlControlRuntime` | `DurableFlow` (type) | models | A flow the durable runtime can plan. |
| `SqlControlRuntime` | `Options` (interface) | models | Durable runtime configuration. |
| `SqlControlRuntime` | `migrate` (const) | migrations | Creates every control-plane table. |
| `SqlControlRuntime` | `layer` (const) | layers | Provides a durable runtime over the ambient database and run store. |
| `SqlControlRuntime` | `layerWithStore` (const) | layers | Provides a durable runtime and the run store it needs over the ambient database. |

{/* generated:control-modules end */}

```ts
import { Control } from "@smthrs/control"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const control = yield* Control.Control
  return yield* control.list({ _tag: "runs" })
}).pipe(Effect.provide(Control.layerNoop))
```

Use `ControlLive.layer` for in-process operation, `ControlClient.layer({ url, credential })`
for authenticated RPC, or `ControlRuntime.layerMemory()` when assembling a
deterministic runtime. `@smthrs/control/package.json` is also exported;
`internal/*` and nested `*/index` subpaths are blocked.

## Receipts and failures

Every mutation answers a `ControlSchema.Receipt` rather than throwing on a
second ask. `Accepted` means this call did the work, `AlreadyApplied` means an
earlier call under the same idempotency key did, `Conflict` means the key names
a different intent, `Parked` means the plan is waiting for an approval, and
`Terminal` means the run had already settled and reports the status it settled
with.

| Verb | Receipts | Typed failures |
| --- | --- | --- |
| `plan` | returns a `PlanCard`, not a receipt | `FlowNotFound`, `InvalidInput`, `PersistenceError`, `Unavailable` |
| `run` (`Plan`) | `Accepted`, `AlreadyApplied`, `Conflict`, `Parked` | `PlanNotFound`, `PlanDenied`, `PlanDigestMismatch`, `EnvelopeMismatch`, `ClaimLost`, `LaunchFailed`, `PersistenceError`, `Unavailable` |
| `run` (`Resume`), `resume` | `Accepted`, `AlreadyApplied`, `Conflict`, `Terminal` | `RunNotFound`, `ClaimLost`, `PersistenceError`, `Unavailable` |
| `approve`, `deny` | `Accepted`, `AlreadyApplied`, `Conflict`, `Terminal` | `PlanDigestMismatch`, `EnvelopeMismatch`, `AlreadyResolved`, `PlanNotFound`, `RunNotFound`, `PersistenceError`, `Unavailable` |
| `steer` | `Accepted`, `AlreadyApplied`, `Conflict`, `Terminal` | `RunNotFound`, `InvalidInput`, `PersistenceError`, `Unavailable` |
| `signal` | `Accepted`, `AlreadyApplied`, `Conflict`, `Terminal` | `RunNotFound`, `NoMatchingWait`, `PersistenceError`, `Unavailable` |
| `cancel` | `Accepted`, `Terminal` | `RunNotFound`, `ClaimLost`, `PersistenceError`, `Unavailable` |
| `list`, `watch` | a page or a stream | every member of `ControlError` |

`ControlError.ControlErrorSchema` is the single membership list for the union,
including `CredentialConflict`, and `ControlClient.isControlError` is derived
from it. Each class carries a stable `code` (`plan_not_found`, `plan_denied`,
`run_not_found`, `claim_lost`, `no_matching_wait`, `invalid_input`, and so on)
that clients may branch on.

## Deployment requirements

`SqlControlRuntime` reads the engine's own columns for the projections it
reports: `flows_runs.waiting_reason`, the `flows_run_parents` spawn edges, fork
markers and `flows.engine.interrupted` entries in `flows_journal_events`, and
`cancel_requested_at_ms`. It reads them through the `SqlClient` it was built
over, so a composition that wants `RunSummary.waitingReason`, engine-created
children and forks in `list`, or `source: "engine"` cancel attribution must give
the control runtime and the engine ONE database.

The shipped `smithers` CLI does not: it keeps `.flows/control.db` and
`.flows/engine.db` as two files, so one run has two rows. Cancellation still
converges, because the request is recorded on the engine row through the
`ControlExecutor` port and the owning driver settles from it. The projections
above are empty there.

## Limits

| Bound | Value | Refusal |
| --- | --- | --- |
| `list` page size | `ControlSchema.defaultPageSize` (100) by default, `ControlSchema.maxPageSize` (500) maximum | `InvalidInput` with code `invalid_input`, naming `limit` |
| `list` cursor | only a cursor a previous page returned | `InvalidInput`, naming `cursor` |
| `list` run filters | `runId`, `flowId`, `status`, `parentRunId`, `lineageId` | `InvalidInput` for `principalId`, which rc.0 records nothing to evaluate |
| `watch` cursor | `afterSequence` requires `runId` | `InvalidInput`, naming `afterSequence` |
| `watch` follow-mode deduplication | the last 1024 `(runId, sequence)` keys | none; an older duplicate can be re-emitted after eviction |

A `steer` whose `message.runId` disagrees with the run the call names is
refused with `InvalidInput` before anything is admitted to the queue.
