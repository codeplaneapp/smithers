# Design decisions

This page records the architectural decisions that explain the current source layout. It is a compact rationale index; linked concept pages contain operational detail and package references contain exact APIs.

## D1. Durable execution is application-neutral

Flow payloads, action inputs, and journal events remain application-defined values so the engine can be embedded without adopting a higher-level application model.

Consequence: the journal uses an open `eventType` plus `payload` envelope, and the engine records engine-specific events without closing the union around one application.

## D2. Flow bodies replay; actions record effects

A resume re-enters the registered handler from the top. Application effects must cross `Action`, `DurableDeferred`, clock, or another recorded boundary. This is the basis of [deterministic replay](../concepts/determinism-and-replay.md).

Consequence: local computation between boundaries must be deterministic, while action outputs may be nondeterministic because their encoded result is recorded.

## D3. Key computation sits above storage

`@smthrs/engine` computes content or ordinal step keys before calling `FlowEngine.Encoded.actionExecute`. Memory and durable engines therefore receive the same identity instead of implementing key policy independently.

Consequence: object-form sealed cache key inputs are caller-owned and
rename-stable. String idempotency keys are intentionally namespaced by the
action name and schema declaration, so those changes invalidate reuse.

## D4. Cache admission requires evidence

A cache key alone does not prove hermetic execution. `@smthrs/engine-store` caches only sealed actions that carry a hard `StepBoundary` descriptor, settle without a deviation, and explicitly attest whole-tree write verification.

Consequence: the filesystem-backed `StepBoundary.layer` measures declared read sets and materializes declared outputs, but cannot detect writes elsewhere and therefore does not admit shared cache rows. Cross-run admission requires a stronger whole-tree boundary, such as a future jj-diff-backed implementation.

## D5. Host access is closed and decorated

The Host surface is exactly FileSystem, Path, ChildProcessSpawner, Jujutsu, and HttpClient, with Effect Clock and Random treated as swappable built-ins. Four of those slots hold Effect's own tags: `flows` supplies implementations rather than wrappers. The `Shell` service that used to occupy the third slot was deleted for duplicating `effect/unstable/process`, and the one-hop `HttpTransport` that used to occupy the fifth was deleted once Effect's `HttpClient.followRedirects`, composed above the kernel's grant check, gave the same hop-by-hop authorization. The kernel decorates these services rather than asking each flow to remember permission checks. PTY support is deliberately outside core because the engine has no production interactive-session consumer.

Consequence: ambient authority can only shrink through `CapabilitySet.attenuate`, and because the kernel decorates each service tag in place, capability failures reach every consumer — as typed `Permission` failures where `flows` owns the contract, and as `PlatformError` with the structured failure on `cause` where Effect does.

## D6. The journal becomes the authoritative logical WAL; only telemetry admission is optimistic

The target architecture makes the journal flows' own authoritative logical (domain) write-ahead log. The SQLite or PostgreSQL WAL beneath it is the storage durability substrate only, and is never consumed as the application event API.

Lifecycle evidence takes `emitDurable`, which allocates inside the write transaction and returns only once the row is committed. A durable boundary must not advance the run or expose its result before that commit. Telemetry takes `emitLossy`, a bounded non-blocking queue whose `Dropped` receipts and evictions are accepted outcomes; `flush` is the explicit barrier for that channel.

Consequence: a lossy `Accepted` receipt is not a durability guarantee — process failure can lose accepted but unflushed telemetry, and dropping overflow policies create valid sequence holes. Nothing may be reconstructed from telemetry alone. Local commit is also not remote atomicity: external effects still need idempotency keys, fencing tokens, or compensation.

Executable authority stays in `RunStore`, `AttemptStore`, `CacheStore`, and `DurableEngineState` rather than being derived from the log — but a state transition and its lifecycle entry commit in ONE transaction, opened by `Journal.transact`, so the log can be read as the account of record. See [implementation status](implementation-status.md).

## D7. One owner drives a run

Run execution begins only after exact-snapshot claim and activation compare-and-swaps. Heartbeats fence continuing work, and stale-owner takeover requires liveness evidence.

Consequence: all starts and wakes pass through `RunCoordinator` and the same claim path. Durable state mutation must not invoke a handler directly.

## D8. Failure policy follows effect tier

The implemented tiers are sealed, compensable, and irreversible. Sealed work may replay from cache; compensable work restores a Jujutsu snapshot before retry; irreversible retry requires an idempotency key.

Consequence: a proposed graph-wide `halt`/`quarantine`/`continue` policy is not part of the current API. See [failure and retry](../concepts/failure-and-retry.md).

## D9. Time travel is a separate protocol

Replay is read-only. Fork creates a new run prefix and workspace. Rewind is an ownership-fenced protocol with preflight, audit, compensation, workspace restore, atomic archive/truncation, and startup recovery.

Consequence: time travel depends on explicit effect-boundary records, lineage edges, and snapshot pointers. Engine execution does not populate all of those records automatically today.

## D10. Remote sync is read-only

`@smthrs/sync` exports catch-up and follow RPCs over journal entries. Mutation, resume, and permission decisions are deliberately outside this protocol.

Consequence: consumers can rebuild read models without acquiring run ownership or receiving write authority.

## D11. Core extension is dependency injection; cell-loop extension uses the plugin kernel

`flows` is extended by providing an Effect `Layer`, and a behavior is replaced by providing a different implementation of the service — or a different constructor option — at the seam that owns it. The rule for what becomes a seam: external effects, nondeterminism, and policies a user may reasonably replace become named services or options with defaults; deterministic algorithms stay ordinary functions.

`@smthrs/plugin` is the narrower extension point for the assembled agent loop in `@smthrs/agent`. It resolves and orders plugins, runs the `config` waterfall and `configResolved` observers, merges plugin layers, and lets the cell host add only the waterfalls it dispatches: `cellRegistry`, `cellFlows`, and `cellModelRequest`. The broader speculative engine lifecycle catalog was trimmed rather than advertised: run, step, retry, cache, wait, checkpoint, and journal hooks are not extension points unless a runtime first owns and dispatches them. Those policies continue to use their existing services and constructor options, including `Inconsistency`, `OwnerIdentity`, `StepBoundary`, and the closed Host services.

Consequence: durable-core behavior is still extended at the composition root, where `Layer` requirements say which behaviors a program supplies or overrides. Cell-loop plugins are resolved once at `Agent.run` startup and may affect only resolved configuration, contributed layers, registry disclosure and resolution, executable flow bindings, and provider-neutral model requests. There is no engine-wide hook registry or lifecycle event bus. This settles the open disagreement recorded for publishing `@smthrs/plugin` in [design decisions](../pages/design-decisions.md) by blessing the package for that bounded cell-host role.
