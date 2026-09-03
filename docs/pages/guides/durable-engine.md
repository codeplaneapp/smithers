---
description: "The services the durable engine requires, a local SQL composition, and what to replace before deploying more than one process."
---

# Assembling a durable engine

This guide describes the services required by `@smthrs/engine-store` and gives a local SQL-backed composition pattern. It also identifies which services must be replaced before a multi-process deployment is durable.

## Required services

`EngineStore.make` requires:

- `Journal`, `RunStore`, `AttemptStore`, and `CacheStore`
- `DurableEngineState`
- kernel `Jj`
- `StepBoundary`
- an Effect `Scope`

`TestStores.layer()` supplies the four SQL services, journal, run, attempt, and cache, over ONE in-memory SQLite database. It is useful for integration tests, not restart durability:

```ts
import { DurableEngineState, EngineStore, StepBoundary } from "@smthrs/engine-store"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Jj } from "@smthrs/kernel"
import { Effect, Layer } from "effect"

const jj = Jj.make({
  snapshot: () => Effect.succeed({ changeId: "local" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const Requirements = Layer.mergeAll(
  TestStores.layer(),
  DurableEngineState.layerMemory,
  StepBoundary.layerTest(),
  Layer.succeed(Jj.Jj, jj)
)

const EngineLayer = EngineStore.layer({
    owner: { hostId: "local-worker" },
    journalSource: "local-engine",
    isAlive: () => Effect.succeed(false)
}).pipe(Layer.provide(Requirements))
```

`EngineLayer` provides the `FlowEngine` service. Merge it with flow handler layers, then run flow operations inside the resulting layer scope.

## Persistent SQL composition

For a persistent deployment:

1. create a compatible Effect `SqlClient`,
2. wrap it with `DurableWriter.make` or a runtime adapter,
3. run `Journal.Migrations`,
4. construct `SqlJournal`, `RunStore`, `AttemptStore`, and `CacheStore` from that database,
5. construct `DurableEngineState.layer` from the same migrated database,
6. provide the resulting services to `EngineStore.layer`.

Migrations must complete before any store service is exposed. `DurableWriter.write` wraps a SQL transaction and retries retryable SQLite write failures; non-SQLite drivers retain their own transaction behavior.

## One call on Node

`@smthrs/flows/NodeRuntime` has two entry points, and the difference is how
much a program has to decide.

`NodeRuntime.layer(options, stepBoundary, workspaceSandbox, registerFlows)`
composes storage and the engine and leaves the host to the caller: `Jj`,
Effect's `FileSystem`, and `Crypto` stay requirements, and the boundary and
sandbox are arguments.

`NodeRuntime.layerHost(options, registerFlows)` adds the host:

```ts
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"

const runtime = NodeRuntime.layerHost(
  { filename: ".flows/engine.sqlite", owner: { hostId: "local-worker" } },
  registerFlows
)
```

That single call provides:

- the complete Node host from `@smthrs/platform-node`, with process
  containment on. A spawned process gets its own process group, is signalled
  and then killed when its action's scope closes, and is recorded in the
  `ProcessLedger`, so the next incarnation of the same `hostId` reaps whatever
  a crash left running;
- the kernel's guarded host surface over an unattended `GrantStore`, so a flow
  body reaches the host through the capability check. A capability no rule in
  `HostOptions.rules` allows is denied rather than escalated: there is no
  operator to ask;
- the default `StepBoundary` and the filesystem `WorkspaceSandbox`, which is
  the pairing that makes a sealed action's result eligible for the step cache;
- `HostLiveness.isAlive`, which answers from this machine's process table and
  never declares another host's owner dead;
- signal handling. `SIGINT` and `SIGTERM` close the runtime scope, which is
  what releases every run this host owns.

### The engine's own jj authority

A compensable action is snapshotted and restored by the engine, not by the flow
body. Both once resolved the same guarded `Jj`, which meant the engine's own
bookkeeping spent the flow's capability budget: a host with no `jj:*` rule could
not run a compensable action at all, and the refusal arrived before the body
started, aimed at the engine rather than at anything the flow asked for.

The engine now holds its own authority instead. `EngineJj` is a distinct service
tag, absent from the context an action body sees, and snapshot, restore, and
diff resolve it rather than the public `Jj`. An engine operation therefore never
grants the same authority to user code, and there is no rule list to keep in
step with the calls the engine makes: a capability the engine needs cannot be
one a host forgot to allow, because the engine does not ask the host for it.

A flow body that calls `jj` itself is unaffected. It resolves the public `Jj`
through the guarded host context and is refused or allowed by the configured
policy exactly as before.

### Shutdown

`SIGINT` and `SIGTERM` close the runtime scope, and closing it runs the engine's
finalizers so every owned run parks itself `released` rather than being left
`running` behind a dead owner.

Installing that handler also removes Node's default signal behavior, so the handler
keeps two escapes. A second signal leaves immediately, and a graceful shutdown
that outlasts `HostOptions.shutdownTimeoutMs` (default 30 seconds) leaves
anyway. Both exit with the status the default behavior would have produced:
`130` for `SIGINT`, `143` for `SIGTERM`. Without them a finalizer that never
returns would turn `Ctrl-C` into a program nothing short of `SIGKILL` can stop.

The engine's machinery and the flow bodies sit on opposite sides of the kernel
on purpose. The SQLite storage, the step boundary, and the workspace sandbox
run on the raw host: a database directory the engine must create to exist at
all is not something the engine asks permission for, and a whole-tree sandbox
copy is engine bookkeeping. What the engine hands a flow body is the guarded
surface, because a body is what the capability check exists for.

### Shutdown

A `SIGTERM` to a host composed this way is a release, not a kill. The handler
closes the runtime scope; the engine interrupts its drive fibers, and each
interrupted run parks itself `suspended` with the waiting reason `released`
while its fence is still validly held. Another host reclaims it immediately
instead of waiting out the 30-second stale window below. Pass `signals: []` to
install no handler at all when the program owns its own signal wiring.

## Services still owned by the application

Use `DurableEngineState.layer` for process-restart durability.
`DurableEngineState.layerMemory` remains intended for tests. On flow
registration, the SQL implementation re-arms every pending future or overdue
clock and re-delivers wakes for stored completions through the normal run
claim path.

`StepBoundary.layerTest` does not create a sandbox. `StepBoundary.layer` can
measure declared paths and materialize outputs, but cannot observe writes
elsewhere in the tree, so its results are not admitted to the shared cache.
Supply a stronger boundary that enforces declared writes and returns
`wholeTreeWritesVerified: true` before admitting cross-run cache entries.

`EngineStore` mints its owner identity through the `OwnerIdentity` service rather than reading `node:crypto.randomUUID` and `process.pid` directly, so the composition itself is edge-safe: the default draws an incarnation number from `Random` where the platform has no process, and `OwnerIdentity.layerConstant` pins the whole token where a host already holds a lease. What is still **Planned** is a browser SQL client behind the `DurableWriter` contract. Without one there is nothing for the composition to run against off Node.

## Ownership and liveness

Give each worker a stable `hostId`; the engine adds process identity and a random nonce for each engine instance. `isAlive` must return trustworthy evidence about another owner. Returning `false` unconditionally, as in tests, permits immediate takeover and is unsafe in a real multi-worker deployment.

## Wake behavior

Deferred and clock completion schedule a resume. A committed journal-driven `resumeSignal` is not implemented, so suspended execution can also rely on the flow engine’s polling schedule.

## Abandoned runs are not auto-resumed

**Nothing in this release watches for runs whose owner died and starts a process to pick them up.** `@smthrs/gateway`'s `SuperviseRuntime` declares the `scan`/`resume` supervision contract but ships only `make`, `makeNoop`, and `layerNoop` (`packages/gateway/src/SuperviseRuntime.ts:121,129,142`) plus a test double; there is no production implementation, and `@smthrs/gateway` is an agent-group package that the engine release train does not pack.

Recovery is scoped to a process that is already running the engine and has the flow registered. Each engine driver sweeps on the one-second heartbeat cadence (`packages/run-store/src/Heartbeat.ts:24`): it delivers pending cancels to parked runs, and it enumerates `running` rows whose heartbeat is older than the 30-second stale cutoff (`Heartbeat.ts:33`), re-driving up to 64 per tick through the ordinary claim/steal path (`packages/engine-store/src/internal/RunDriver.ts:160,1412`). That is what reclaims a SIGKILLed or OOM-killed owner's run. A wake for a flow the sweeping process has not registered logs a once-per-run warning and leaves the row parked for a worker that does register it (`RunDriver.ts:1074`).

To resume abandoned runs manually:

1. Start or restart a host process composed through `@smthrs/flows/NodeRuntime`, pointed at the same SQLite `filename`.
2. Pass a `registerFlows` layer that registers every flow with stored runs. It is the composition's final startup phase, so nothing resumes before its flow exists in the process.
3. Supply an `Options.isAlive` that reports the dead owner as not alive. Steal is gated on that answer; while it says the previous owner lives, its runs are not taken over.
4. Wait out the stale window. There is no command to invoke.

The 30-second cutoff is when a row becomes *eligible*, not when it is reclaimed. The steal predicate is strict (`heartbeat_at_ms < now - 30s`, `packages/run-store/src/RunStore.ts:1184`), the sweep that acts on it runs once per second, and one tick wakes at most 64 stale rows, oldest heartbeat first. So the earliest re-drive is the first tick after the heartbeat passes 30 seconds, and a run sitting behind a backlog of more than 64 stale rows waits for a later tick. `isAlive` gates the steal on top of that. Do not treat 30 seconds as an upper bound on recovery.

A run with no such process running stays put. Its state is durable and it does not advance.

See the [`@smthrs/engine-store` reference](/api/engine-store), [Journal](/concepts/journal), and [Implementation status](/release/support-matrix).
