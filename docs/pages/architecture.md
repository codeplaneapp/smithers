---
description: "How the workspace packages fit together, which direction data moves, and where the substitutable boundaries are."
---

# Architecture

Smithers is one durable-execution engine assembled from the workspace packages listed in [package structure](/package-structure). This page shows how they fit together, which direction data moves, and where the boundaries you can substitute are. Read it before anything else; the pages after it assume the picture below.

## The whole system

```mermaid
flowchart TB
  subgraph app["Your application"]
    CALL["flow.execute(payload)"]
    BARREL["@smthrs/flows<br/>barrel, Node and browser"]
  end

  subgraph define["Definition and identity"]
    FLOW["@smthrs/flow<br/>Flow, Action, DurableDeferred,<br/>DurableClock, DurableQueue, RetryPolicy"]
    ENGINE["@smthrs/engine<br/>FlowEngine, FlowProxy"]
    KEYS["@smthrs/keys<br/>canonical Key"]
    PLAN["@smthrs/plan<br/>Node AST, Planned, KeyMaterial,<br/>StepKey, Plan, PlanDiff, PlanStore"]
    CRYPTO["@smthrs/crypto<br/>strict SHA-256"]
    CANONICAL["@smthrs/canonical<br/>RFC 8785 JSON"]
  end

  subgraph drive["Durable driver"]
    STORE["@smthrs/engine-store<br/>claims, fences, heartbeats,<br/>attempt persistence, cache admission"]
  end

  subgraph persist["Persistence"]
    JOURNAL["@smthrs/journal<br/>logical WAL, projections,<br/>redaction, OwnerId"]
    RUNSTORE["@smthrs/run-store<br/>RunStore, AttemptStore,<br/>Ownership"]
    STEPCACHE["@smthrs/step-cache<br/>CacheStore"]
    DB["@smthrs/database<br/>DurableWriter over SqlClient,<br/>write retry, composed migrations"]
    SQL[("SQLite<br/>Node file or wasm")]
  end

  subgraph guard["Host boundary"]
    KERNEL["@smthrs/kernel<br/>owns the closed 5-slot list<br/>FileSystem, Path, ChildProcessSpawner, Jj, HttpClient<br/>CapabilitySet, grants, permission-decorated services"]
    CAP["@smthrs/capability<br/>capability vocabulary,<br/>typed permission failures"]
    JJ["@smthrs/jj<br/>contract + node / bun / browser adapters"]
    SANDBOX["@smthrs/sandbox<br/>remote exec, liveness probe"]
    PN["@smthrs/platform-node<br/>NodeHost bundle"]
    PBUN["@smthrs/platform-bun<br/>BunHost bundle"]
    PB["@smthrs/platform-browser<br/>BrowserHost bundle:<br/>effect FileSystem + ChildProcessSpawner for a tab"]
    TESTHOST["@smthrs/kernel/test/TestHost<br/>deterministic host + contract suite"]
  end

  subgraph read["Read-only protocols"]
    SYNC["@smthrs/sync<br/>catch-up and follow over RPC"]
    TT["@smthrs/time-travel<br/>frames, replay, fork,<br/>rewind, compensation, recovery"]
  end

  CALL --> FLOW
  FLOW -->|FlowRuntime port| ENGINE
  BARREL -.re-exports.-> FLOW
  BARREL -.re-exports.-> ENGINE
  BARREL -.re-exports.-> STORE
  BARREL -.re-exports.-> SYNC
  BARREL -.re-exports.-> TT
  FLOW --> KEYS
  FLOW --> CRYPTO
  FLOW --> PLAN
  PLAN --> KEYS
  PLAN --> DB
  ENGINE --> KEYS
  KEYS --> CANONICAL
  KEYS --> CRYPTO
  ENGINE -->|Encoded seam| STORE
  STORE --> JOURNAL
  STORE --> RUNSTORE
  STORE --> STEPCACHE
  STORE --> CRYPTO
  STORE --> KERNEL
  STORE --> PLAN
  JOURNAL --> DB
  RUNSTORE --> JOURNAL
  RUNSTORE --> DB
  STEPCACHE --> DB
  DB --> SQL
  KERNEL --> CAP
  KERNEL --> JJ
  JJ --> CAP
  PN -->|fills the slots| KERNEL
  PBUN -->|fills the slots| KERNEL
  PB -->|fills the slots| KERNEL
  TESTHOST -->|fills the slots| KERNEL
  SANDBOX --> KERNEL
  JOURNAL --> SYNC
  JOURNAL --> TT
  TT --> STORE
  TT --> RUNSTORE
  TT --> STEPCACHE
  TT --> JJ
```

:::note[Reading the diagram]
Solid arrows are workspace dependencies that execute. Dotted arrows are re-exports.
:::

## What each boundary is for

Ask what would break if a boundary were removed, and its purpose becomes clear.

The **host boundary** exists so flow code can run in a browser. `@smthrs/kernel` declares a closed set of five service tags and nothing else; every platform implementation lives in its own package: `@smthrs/platform-node`, `@smthrs/platform-bun`, `@smthrs/platform-browser`. Four of those five tags are Effect's own: `FileSystem`, `Path`, `ChildProcessSpawner`, and `HttpClient` are contracts `effect` already declares, so Smithers supplies implementations rather than wrappers. One more, `Jj`, is a contract of `@smthrs/jj`, whose tag the kernel decorates in place rather than shadowing with a second one, so a consumer that needs only that capability does not take the whole host surface. A module that depends only on the kernel root never statically resolves a `node:` built-in, which is what makes browser bundling possible at all. `@smthrs/kernel` sits in front of that surface and decorates each service with a grant check, so a flow that asks for a file it was never granted fails in the error channel rather than reading the file.

{/* generated:kernel-contract start */}

`@smthrs/kernel` owns the closed host boundary and decorates the same service
tags supplied by each platform adapter. Capability checks happen before a host
operation, and mutable inputs are snapshotted so the operation executed after
an attended grant is the operation that was authorized. Native filesystems use
a descriptor-relative executor; isolated browser and test volumes may attest
whole-volume isolation. Process, network, Jujutsu, and filesystem refusals keep
their structured permission error through the host service's fixed error
channel. See the [Kernel API contract](/api/kernel) for the exact resources,
stable error codes, limits, and public test subpaths.

{/* generated:kernel-contract end */}

The **database and journal** split separates the storage driver from the shapes stored in it. `@smthrs/database` owns no domain tables; it wraps any Effect `SqlClient` and adds the transactional write retry that the rest of the system assumes. `@smthrs/journal`, `@smthrs/run-store`, `@smthrs/step-cache`, `@smthrs/plan`, and `@smthrs/engine-store` each own their own tables and the migration set that creates them, composed over one migrations table. Swap the driver and every shape survives.

The **canonical, crypto, keys, and engine** chain decides identity before storage sees anything. `@smthrs/canonical` owns RFC 8785 JSON, `@smthrs/crypto` owns SHA-256, [`@smthrs/keys`](/api/keys) owns canonical flow-key derivation and stored-key validation, and `@smthrs/engine` owns action-key policy above the seam. The engine computes a key before it calls `FlowEngine.Encoded.actionExecute`, so storage never implements key policy.

{/* generated:crypto-contract start */}

`@smthrs/crypto` owns the repository's SHA-256 policy and its only handwritten
implementation. `digest` sends a byte snapshot to an injected Effect `Crypto`
service; `digestSync` uses the package-owned synchronous FIPS 180-4 path. Both
reject unpaired UTF-16 surrogates, perform no Unicode normalization, and return
the same branded 64-character lowercase hexadecimal `Digest`. The API is
one-shot and whole-buffer; it does not offer streaming hashing. See the
[Crypto API contract](/api/crypto) for host requirements and failure codes.

{/* generated:crypto-contract end */}

The **plan** boundary separates describing work from doing it. `@smthrs/plan` holds the authoring AST a flow body builds, the key material a planner declares, the step-key compiler, the compiled graph, its diff, and its append-only store. Planning performs no I/O, so nothing in it reads a file, a clock, or a network: declared effects carry read and write paths, never digests. A node's key is a function of what it consumes, which is the whole invalidation mechanism. An edited declaration re-keys that node and its dependent cone and nothing else, so there is no reverse-dependency index. Driving a compiled plan is `@smthrs/engine-store`'s `PlanScheduler`.

The **flow, engine, and engine-store** chain separates what a durable program is from what runs it and from where it is written. `@smthrs/flow` defines flows, actions, durable deferreds, durable clocks, durable queues, and retry policy as typed values, written against the `FlowRuntime` port it declares. `@smthrs/engine` implements that port and puts an encoded seam beneath it. `@smthrs/engine-store` implements that seam over the journal: it claims a run row before driving it, fences continuing work with a heartbeat, admits and finishes attempt rows, and commits each lifecycle entry in the same transaction as the state transition it describes.

**Extension** has no package of its own, because it is Effect dependency injection. Every behavior a program may reasonably want to replace is either a named service (`Inconsistency` for cache-conflict verdicts, `OwnerIdentity` for owner minting, `StepBoundary` for hermeticity, `Jj` and the rest of the closed host list for host access, `Clock` and `Random` for time and nondeterminism) or a constructor option carrying the built-in behavior as its default, such as `clockFireRetryPolicy` and `suspendedRetryPolicy`, which bounds how long one caller polls a suspended flow and is deliberately not a run-level retry bound. Providing a different `Layer` at the composition root is the whole mechanism; there is no hook registry and no dispatch order to reason about. See [design decisions](/design-decisions).

The **read-only protocols** consume the journal without acquiring ownership. `@smthrs/sync` streams committed entries to a follower over Effect RPC and can neither mutate a run nor resume one. `@smthrs/time-travel` reads frames out of the same history and adds its own tables for snapshots, lineage edges, audits, receipts, and archived entries.

The **barrel**, `@smthrs/flows`, re-exports the engine packages as namespaces for a single-import application. A browser application may still prefer the per-package roots for a narrower dependency footprint.

## One execution, end to end

```mermaid
sequenceDiagram
  participant Caller
  participant Flow as @smthrs/flow
  participant Driver as @smthrs/engine-store
  participant Runs as RunStore
  participant Rows as AttemptStore / CacheStore
  participant Host as kernel over host
  participant Log as Journal

  Caller->>Flow: flow.execute(payload, executionId)
  Flow->>Driver: Encoded.execute
  Driver->>Runs: create or load the run row
  Driver->>Runs: claim(exact snapshot), then activate(claim)
  Driver->>Runs: heartbeat every second while owned
  Driver->>Flow: invoke the registered handler from the top
  Flow->>Driver: actionExecute(action, attempt, stepKey, tier)
  Driver->>Rows: admit the attempt
  Driver->>Log: attemptStarted, in the same transaction
  Driver->>Host: run the guarded effect
  Driver->>Rows: finish the attempt
  Driver->>Log: attemptFinished and cache provenance
  Driver->>Runs: completed, failed, suspended, or cancelled
```

Six things happen in that sequence, and each one is a decision you can inspect.

**Definition and registration.** `Flow.make` produces a typed value carrying payload, success, and error schemas, a stable tag, and the required pure `body` that is the flow's behavior. `Interpreter.layer(flow)` registers it in the active `FlowEngine` scope and drives that body; an action attaches its own implementation with `Action.toLayer`.

:::warning
Registration is in memory even when the state is durable. A restarted process must re-register its flows before it can drive stored runs.
:::

**Execution identity.** The caller supplies `executionId`, or the flow derives one from an opt-in `idempotencyKey`. The driver persists the encoded payload under that identity, and a second request with the same identity must present the same flow tag and the same encoded payload.

**Claim and heartbeat.** The driver reads an exact `RunSnapshot`, performs a compare-and-swap claim against it, activates the claim, and only then moves the row to `running`. A heartbeat fiber refreshes the fence every second. Losing the fence interrupts the driving fiber, so two processes cannot persist terminal state for one run.

**Replay and the frontier.** A resume invokes the handler from the top. At each recorded boundary the driver returns the stored result. The first boundary with no recorded state is the frontier, and that is where new work happens.

:::warning
Code between boundaries runs again on every replay, so it has to be deterministic.
:::

**Suspension.** `DurableDeferred.await` and long `DurableClock.sleep` calls return `Flow.Suspended` when no result exists. The driver parks the run with a reason, clears ownership, and waits for a wake. The in-process `WakeBus` completes the engine's `resumeSignal` when runnability durably changes (a deferred completes, a clock fires, an operator resumes); polling and sweeps remain the bounded fallback for cross-process wake.

**Terminal state.** A handler that returns stores its encoded `Flow.Result` and moves the row to `completed` or `failed`; interruption moves an owned run to `cancelled`. Every terminal transition clears ownership.

## What is authoritative

Executable state lives in `RunStore`, `AttemptStore`, `CacheStore`, and `DurableEngineState`. The journal is the account of what happened. Those two are kept consistent by one rule: every lifecycle entry commits in the same write transaction as the state transition it describes, opened by `Journal.transact`. Either both halves are durable or neither is.

:::warning[A local commit is not remote atomicity]
No database transaction makes an external effect atomic with it. An effect outside the database still needs an idempotency key, a fencing token, or a declared compensation.
:::

The journal has a second channel. `emitLossy` accepts telemetry into a bounded queue whose `Dropped` receipts and evictions are accepted outcomes, and `flush` is its only barrier. Nothing is ever reconstructed from that channel.

## Reading next

[Data structures](/data-structures) names every shape the arrows above carry. [Package structure](/package-structure) gives the workspace layout, the dependency graph as a table, and the browser and Node entry matrix. [Internal details](/internals) documents the rules the durable driver enforces and the tests that pin them.
