---
description: "Why the engine looks the way it does. Each entry states the decision, the alternatives, and what the choice costs."
---

# Design decisions

Why the engine looks the way it does. Each entry states the decision, the alternatives that were on the table, what was chosen, and what the choice costs. Where a decision was contested during the release-readiness review, the disagreement is recorded rather than smoothed over.

## D1. Durable execution stays application-neutral

Flow payloads, action inputs, and journal events are application-defined values. The journal envelope is an open `eventType` plus a `payload`, and the engine writes its own events into that same open space.

The alternative was a closed union of engine event types with application events pushed into a side channel. That reads better in a type signature and makes the engine unembeddable in anything that wants its own vocabulary.

Cost: no exhaustive match over event types, and consumers filter on strings. `event_type` is indexed for exactly that reason.

## D2. Flow bodies replay, actions record effects

A resume re-enters the registered handler from the top. Application effects have to cross an `Action`, `DurableDeferred`, clock, queue, or child-flow boundary to be recorded.

The alternative is snapshotting a continuation, which is what a language-level durable runtime does. That needs either a custom interpreter or serializable stacks, and neither is available to a library that wants to be an ordinary Effect dependency.

Cost: local computation between boundaries must be deterministic. `Date.now()`, unseeded randomness, global mutable state, unordered external reads, and inline environment reads are all unsafe in a flow body. Action outputs may be nondeterministic, because the encoded exit is what gets recorded.

## D3. Key computation sits above storage

`@smthrs/engine` computes a cache key or an invocation key before it calls `FlowEngine.Encoded.actionExecute`. The memory engine and the durable engine receive the same identity.

The alternative was letting each engine derive identity from its own storage addresses, which produces two key policies that drift.

Cost: caller-owned object identities can be wrong. String identities are namespaced by the action name and schemas, so renaming an action or changing its schemas invalidates reuse. A missing complete cache environment scopes the key to the current execution.

## D4. Cache admission requires evidence, not just a key

A cache key says an output is a function of some declarations. It cannot see an undeclared file read or a network call. So the key alone never admits a row to the shared cache. Admission needs a sealed tier, a `FileBoundary` in `metadata`, `boundaryMode: "hard"`, a successful prepare and settle, no expected-set deviation, and an explicit `wholeTreeWritesVerified: true`.

The alternative, admitting on the key, is what most build caches do and it is why they need hermetic sandboxes to be trustworthy.

Cost: the production sandbox composition admits results only when it has this evidence. `WorkspaceSandbox` supplies whole-tree write evidence, so a sealed action with a hard boundary can enter the shared cache; the production-composition regression test pins that path. The filesystem-backed `StepBoundary.layer` alone still measures declared read sets and materializes declared outputs but cannot detect writes outside those sets, so its evidence is deliberately refused. A jj-diff-backed boundary that could attest is Planned. One near-miss is journalled rather than silent: when every gate passes but read-set verification fails, the run continues on its own result and a `cache-provenance` entry with action `unverified_read_set` explains the missing row.

## D5. Host access is closed and decorated

The host surface is exactly `FileSystem`, `Path`, `ChildProcessSpawner`, `Jj`, and `HttpClient`, four of them Effect's own tags, with Effect's `Clock` and `Random` treated as swappable built-ins. `@smthrs/kernel` decorates those services with grant checks instead of asking every flow to remember to check permissions. A Smithers-defined one-hop `HttpTransport` used to sit in the last slot so redirects could be authorized hop by hop; it was deleted once the same guarantee could be had from Effect alone. Host bundles hand over a client that never follows a redirect, and the kernel composes Effect's own `HttpClient.followRedirects` above the grant check.

Four of those five slots hold Effect's own tags rather than Smithers wrappers, and the last two arrived by the same argument. Smithers used to define a `Shell` service with `exec` and `stream`, which was `effect/unstable/process` with fewer features and a second error type to keep honest. It was deleted; Smithers now supplies implementations of Effect's spawner (Node, Bun, an in-browser just-bash one) and adds only the `proc:spawn` capability check on top. `HttpTransport` went the same way once its one genuine contribution, hop-by-hop redirect authorization, turned out to be expressible as `followRedirects` composed above the guard. A wrapper earns its place by adding something; the shell wrapper added a `timeoutMs` option that `Effect.timeout` already covers, and the transport added a second way to reach the network.

The alternative was an open host surface with per-call permission arguments. An open surface cannot be audited, and per-call arguments are forgotten.

Cost: anything the closed surface does not name has to be added to the surface. Ambient authority can only shrink, through `CapabilitySet.attenuate`, and because the kernel decorates each service tag in place there is no unguarded raw tag left to call: capability failures reach every consumer, as typed `Permission` failures where Smithers owns the contract and as `PlatformError` (reason `PermissionDenied`, structured failure on `cause`) where Effect does.

## D6. The journal is the authoritative logical WAL, and only telemetry is optimistic

The journal is the domain write-ahead log. The SQLite or Postgres WAL beneath it is a storage substrate and is never consumed as the application event API. Lifecycle evidence takes the durable channel through `emitDurable`, which allocates the canonical sequence inside the write transaction and returns only once the row is committed. Telemetry takes `emitLossy`, a bounded non-blocking queue whose `Dropped` receipts and evictions are accepted outcomes.

This was the review's release blocker. At the time of the review, `attempts.finish` committed and then `attemptFinished` emitted, and `transitionOwned` committed and then its decision emitted. A crash in that gap left the journal incomplete. The review offered two postures, fix the gap or downgrade the library to an experimental preview, and a third pass proposed a third: ship with the journal documented as best-effort and time travel and sync marked non-authoritative.

The third posture was rejected on the grounds that time travel and journal-backed sync are two of the four things this library is launched on, and shipping them with a documented hole invites the first public reviewer to re-litigate the same finding. The fix was to widen a transaction boundary rather than invent one, since `SqlJournal.emitDurable` was already internally transactional. Eight state-and-entry pairs are now closed inside `Journal.transact`.

Cost: the unit is all-or-nothing, so a crash before COMMIT loses the whole unit and an action body that had already run re-executes on the next drive. Temporal makes the same trade when it submits mutable state and its event batches as one persistence request. Nothing that is not storage work may run inside the transaction, which rules out flow bodies, host calls, jj snapshots, boundary prepare and settle, and the lossy `flush`. And a local commit is still not remote atomicity.

## D7. One owner drives a run

Execution starts only after an exact-snapshot claim compare-and-swap and an activation compare-and-swap. Heartbeats fence continuing work, and taking over a stale owner requires liveness evidence rather than elapsed time alone.

The alternative, starting on a status read, is what most first drafts do, and it lets two processes persist terminal state for one run.

Cost: `EngineStore.Options.isAlive` is application-supplied, because a library cannot answer the liveness question for a deployment it has never seen. A deployment that cannot answer it within the 30-second staleness window should say so rather than assume. All starts and wakes pass through the same keyed `RunCoordinator`, so durable state mutation must never invoke a handler directly.

## D8. Failure policy follows effect tier

The implemented tiers are sealed, compensable, and irreversible. Sealed work may replay from cache, compensable work restores a Jujutsu snapshot before retry, and irreversible retry requires an idempotency key.

The alternative considered was a graph-wide policy of halt, quarantine, or continue. It is not part of the current API.

Cost: failure handling is per-action. There is no way to say that one failing branch should quarantine the run while another continues.

## D9. Time travel is a separate protocol

Replay is read-only: `TimeTravel.inspect` folds committed entries into a projection and never invokes a handler. `TimeTravel.fork` creates a new run prefix and workspace. `TimeTravel.rewind` is an ownership-fenced protocol with preflight, audit, compensation, workspace restore, atomic archive and truncation, and startup recovery.

The alternative was building rewind into the engine's own resume path, which would put a destructive operation behind the same entry point as an ordinary wake.

Cost: time travel depends on explicit effect-boundary records, lineage edges, and snapshot pointers, and ordinary engine execution does not populate all of them yet. `SqlTimeTravelStore.createFork` folds state at the frame from the journal's own run-decision records and copies only the attempts that prefix explains; the parent's current row is a compatibility fallback for a journal written before frame-derived state existed.

## D10. Remote sync is read-only

`@smthrs/sync` exports catch-up and follow over journal entries. Mutation, resume, and permission decisions are outside the protocol on purpose.

The alternative, a bidirectional protocol, turns every follower into a potential writer and makes ownership a distributed problem.

Cost: a follower can rebuild a read model but cannot act on it through this protocol. Anything that wants to act has to enter the claim path.

## D11. The engine vendors Effect's unstable workflow surface

`@smthrs/flow` and `@smthrs/engine` vendor Effect's `unstable/workflow` rather than depending on it, because the upstream API is explicitly unstable and this engine needs to change its identity and retry semantics.

Cost: an attribution obligation, discharged by `packages/engine/THIRD_PARTY_NOTICES.md` reproducing Effect's MIT notice and `VENDOR.md` recording what was taken and why. Upstream changes have to be merged by hand.

## D12. Effect v4, with no `@effect/*` ecosystem packages

The runtime is `effect@4.0.0-rc.*`. Most of the former `@effect/*` ecosystem now lives at `effect/unstable/*`, and the AI, RPC, cluster, persistence, and workflow surfaces are imported from there. `@effect/sql-sqlite-node` is a dependency because it is a driver, not a rewritten core module.

Cost: a release-candidate pin, exact at `4.0.0-rc.108` across every workspace manifest, and Effect 3 documentation does not apply.

## D13. No pseudo-terminal service in core

The host surface has no `Pty` service and the engine has no interactive-session hijack. Smithers 0.x needed both because its underlying agents were the Claude Code and Codex CLIs: interactive terminal programs a human may take over mid-run, which requires a real pseudo-terminal between the gateway and the CLI. The 1.0 core does not depend on those agent CLIs, so nothing in it ever drives an interactive terminal.

If an application extension later wraps agent CLIs into workflows the way Smithers 0.x did, the PTY adapter and the hijack handshake belong in that higher-level extension package, injected as a capability beside its gateway, not in the closed host list, where every platform bundle would have to carry or explicitly refuse it forever. Non-interactive process execution is already covered by Effect's `ChildProcessSpawner` behind the kernel's `proc:spawn` check.

The alternative was keeping the `@smthrs/pty` package that once shipped here. It was removed: its contract had no production consumer, and its Node implementation was piped stdio rather than a pseudo-terminal, so it could not honestly back the contract it named.

## Decisions the review contested and their outcome

| Question | Review position | Outcome |
| --- | --- | --- |
| Ship 0.1.0 or an experimental preview | a full 0.1.0, with WAL atomicity fixed first | atomicity landed; the version is `0.1.0` |
| Package naming | keep the `@smthrs/*` names | kept |
| Publish `@smthrs/plugin` | hold it back as private until dispatch is wired, because publishing sells an extension API nothing calls | settled for the bounded assembled cell loop: `@smthrs/agent` dispatches its configuration, registry, flow-binding, and model-request hooks; durable-core policy remains dependency injection, with no engine-wide lifecycle hook catalog. The package exists and the decision whether to publish it remains open for the agent track. |
| Browser claim | narrow the claim and gate it, rather than restructure subpaths for 0.1.0 | narrowed and gated by `pnpm run browser`; the gate has since grown to twenty-four browser entry points as each Node read moved behind a port, so the barrel and engine-store now bundle too; only the platform bundles, the jj and SQLite drivers, and the test host stay Node-only |
| Positioning against Temporal, Restate, Inngest | lead with Effect integration, embeddability, content addressing, and time travel; do not lead with parity | adopted, see [External](/external) |

## Reading next

[Internal details](/internals) is the operational half of D4, D6, and D7. [External](/external) is where the costs listed above are collected as deployment limits.
