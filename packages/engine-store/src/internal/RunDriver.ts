/**
 * Claim-gated durable flow run lifecycle.
 *
 * Governing design: `docs/specs/Concepts/Run Ownership.md`.
 *
 * @since 0.1.0
 */
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as DurableEngineState from "../DurableEngineState.ts"
import * as EngineStoreMetrics from "../EngineStoreMetrics.ts"
import { RunState } from "../RunState.ts"
import * as WakeBus from "../WakeBus.ts"
import * as ActionPersistence from "./ActionPersistence.ts"
import * as EffectRecords from "./EffectRecords.ts"
import * as JournalRecords from "./JournalRecords.ts"
import * as RunCoordinator from "./RunCoordinator.ts"

const RunStateJson = Schema.fromJsonString(RunState)

/**
 * Raised when a flow (directly or through mutual ancestry) attempts to
 * execute an execution id that already appears in its own persisted
 * `parentExecutionId` chain.
 *
 * Detection walks the already-persisted parent chain from the requesting
 * parent upward — an O(depth) check, not a dependency-graph DFS — because
 * `parentExecutionId` is the only edge our runtime model can express.
 *
 * The class is declared by `@smthrs/flow` (it is part of the `execute`
 * contract) and re-exported here for the detector's callers. See
 * `docs/specs/Concepts/Run Ownership.md`.
 *
 * @since 0.1.0
 * @category errors
 * @slop
 */
export const FlowCycleDetected = FlowRuntime.FlowCycleDetected

/**
 * The value form of {@link FlowCycleDetected}.
 *
 * @since 0.1.0
 * @category errors
 * @slop
 */
export type FlowCycleDetected = FlowRuntime.FlowCycleDetected

/**
 * Dependencies for the run driver.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Dependencies {
  readonly owner: Ownership.OwnerId
  readonly journalSource: string
  readonly isAlive: (owner: Ownership.OwnerId) => Effect.Effect<boolean>
  readonly engine: Effect.Effect<FlowRuntime.FlowRuntime["Service"]>
  /**
   * In-process wake bus announced to whenever a durable write makes a run
   * runnable — a scheduled resume (deferred, clock, operator) and a run
   * settling terminally. Optional so a direct construction without one keeps
   * the pre-existing polling-only behavior: the default drops every wake,
   * which the engine's suspension polling schedule already covers.
   */
  readonly wakeBus?: WakeBus.Service | undefined
  /**
   * Runs inside the uninterruptible finalizer that retains a suspended run's
   * flow scope, immediately after the entry is inserted and before the round's
   * settlement can start.
   *
   * Private to `packages/engine-store/test`. That boundary is where a pending
   * interruption first becomes observable again, and no public seam reaches
   * it, so the regression proving the retention is released there — rather
   * than stranded until the driver's own scope closes — raises the
   * interruption from here. This module is not exported from the package
   * (`"./internal/*": null`), and production compositions leave the hook
   * undefined, which costs one `undefined` check per suspension.
   */
  readonly unsafeOnScopeRetained?: ((runId: string) => Effect.Effect<void>) | undefined
}

/**
 * Claim-gated operations composed into the encoded flow engine.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Service {
  readonly register: FlowEngine.Encoded["register"]
  readonly execute: FlowEngine.Encoded["execute"]
  readonly poll: FlowEngine.Encoded["poll"]
  readonly interrupt: FlowEngine.Encoded["interrupt"]
  readonly interruptUnsafe: FlowEngine.Encoded["interruptUnsafe"]
  readonly resume: FlowEngine.Encoded["resume"]
  readonly scheduleResume: (
    flowName: string,
    executionId: string,
    reason: "deferred" | "clock" | "parent" | "operator",
    sourceId?: string | undefined
  ) => Effect.Effect<void>
  readonly active: Effect.Effect<ReadonlySet<string>>
  /**
   * The runs whose parked flow scope this driver still holds. Cancellation
   * and re-drive both release; the set is the leak assertion's observation
   * point.
   */
  readonly retainedRuns: Effect.Effect<ReadonlySet<string>>
}

interface Registration {
  readonly flow: Flow.Any
  readonly execute: (
    payload: object,
    executionId: string
  ) => Effect.Effect<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime>
}

/**
 * The effect kind a detached child spawn is journaled under, and therefore the
 * kind an engine composition registers a spawn-compensation handler for.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export const spawnEffectKind = "flows/engine-store/child-spawn"

const snapshot = (row: RunStore.RunRow): RunStore.RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

const samePayload = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

/**
 * Sentinel produced when the cancel-request poll observes a durable
 * cancellation before the flow settles.
 */
const cancelRequested = { _tag: "CancelRequested" } as const

/**
 * How many stale-running rows one heartbeat tick may wake (issue #79).
 * Oldest heartbeats surface first, so a backlog larger than the batch
 * drains across ticks; each successful steal removes the row from the
 * stale window, and losing drivers see a shrinking batch next tick.
 */
const staleRunningSweepBatch = 64

/**
 * The type of {@link cancelRequested}: the settlement a round takes when the
 * cancel-request poll wins the race against the flow.
 */
type CancelRequested = typeof cancelRequested

const withoutResult = (state: RunState): RunState => {
  const { cancellation: _, result: __, ...rest } = state
  return rest
}

/**
 * Constructs a scoped run driver.
 *
 * Every start and wake enters the same keyed coordinator and then the same
 * exact-snapshot claim/activation path.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make = (
  dependencies: Dependencies
): Effect.Effect<
  Service,
  never,
  | Crypto.Crypto
  | DurableEngineState.DurableEngineState
  | Journal.Journal
  | RunStore.RunStore
  | Scope.Scope
> =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const store = yield* RunStore.RunStore
    const engineState = yield* DurableEngineState.DurableEngineState
    const wakeBus = dependencies.wakeBus ?? WakeBus.makeNoop()
    const registrations = new Map<string, Registration>()
    /**
     * Runs already warned about waking without a registered flow (issue
     * #62): the sweep retries every heartbeat, so the warning is emitted
     * once per run, not once per tick. Cleared on every registration — a
     * newly registered flow makes previously dropped runs drivable again.
     */
    const warnedUnregistered = new Set<string>()
    const liveInstances = new Map<string, FlowRuntime.FlowInstance["Service"]>()
    /**
     * Flow scopes retained past a round's settlement.
     *
     * `Flow.intoResult` closes the flow scope for every settlement EXCEPT a
     * suspension — a parked flow keeps its scope so the resources its body
     * acquired outlive the park (`packages/flow/src/Flow/Runtime.ts`). Nothing
     * then owned that scope: the instance left `liveInstances` on the way out
     * and the `Scope.Closeable` became unreachable, so a cancelled parked flow
     * never ran its finalizers and every park leaked one scope for the
     * process's lifetime.
     *
     * The map is that owner. It holds at most one scope per run — an entry is
     * a state, not a queue — and every removal goes through
     * `releaseRetainedScope`, which deletes before it closes. That makes the
     * close idempotent by construction rather than by a flag: a second caller
     * finds no entry and does nothing, so concurrent cancel, resume, and
     * shutdown paths cannot double-finalize.
     */
    const retainedScopes = new Map<string, Scope.Closeable>()

    /**
     * Closes a run's retained flow scope exactly once, if it has one.
     *
     * `exit` decides what the finalizers see. A cancellation closes with an
     * interrupt exit so `Flow.withRollback` compensations run; a supersede
     * (the run re-entered execution under a fresh instance and scope) closes
     * with `Exit.void` so ordinary finalizers release resources while
     * rollbacks correctly stay out — a re-driven round is not an unsuccessful
     * exit.
     */
    const releaseRetainedScope = (
      runId: string,
      exit: Exit.Exit<unknown, unknown>
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        const scope = retainedScopes.get(runId)
        if (scope === undefined) return Effect.void
        retainedScopes.delete(runId)
        return Scope.close(scope, exit).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `engine-store: finalizers of parked run ${runId} failed while closing its retained flow scope`,
              cause
            )
          )
        )
      })

    /**
     * Snapshots the runs whose flow scope this driver is currently holding.
     * Exposed for the leak assertions in `packages/engine-store/test`, which
     * would otherwise have to reach into driver internals.
     */
    const retainedRuns = Effect.sync(() => new Set(retainedScopes.keys()))

    // Process shutdown must not strand parked scopes either: closing the
    // driver's own scope releases every scope still retained. `Exit.void`,
    // because a shutdown is a reclaimable release (issue #26) and not a
    // cancellation, so compensations must not fire.
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        Array.from(retainedScopes.keys()),
        (runId) => releaseRetainedScope(runId, Exit.void),
        { discard: true }
      )
    )
    const encodeState = (state: RunState): Effect.Effect<string> =>
      Schema.encodeEffect(RunStateJson)(state).pipe(Effect.orDie)

    const decodeState = (stateJson: string): Effect.Effect<RunState> =>
      Schema.decodeUnknownEffect(RunStateJson)(stateJson).pipe(Effect.orDie)

    /**
     * Run decisions are lifecycle records: they take the journal's durable
     * channel so a saturated lossy queue can never drop them (issue #10).
     * They stay ownerless because several decisions — `claim-lost`,
     * `steal-refused-owner-alive`, post-transition `transitioned` — are
     * legitimately recorded by a process that does not (or no longer does)
     * own the run; the ownership fence for these paths is the run-row CAS
     * that precedes each emit.
     *
     * `meta.lineageId` is a JOURNAL lineage id (`FlowEngine.Lineage`,
     * `<runId>/root`), because that is the space a time-travel frame addresses:
     * `docs/specs/Concepts/Time Travel.md` makes a frame `(lineageId, seq)`, and
     * replay skips an entry whose `meta.lineageId` names a different lineage.
     * The run row's `lineageId` column is a different space — the TRAMPOLINE
     * lineage of `docs/specs/Concepts/Trampoline Loops.md`, round 0's execution
     * id.
     *
     * DECIDED (2026-08-12): decisions address the journal lineage of the run
     * that records them, one per round, the same lineage that run's attempt
     * and snapshot records already carry. Reading the run row's trampoline
     * lineage here put a run's decisions in a lineage its own attempts do not
     * address, so a rewind of that run skipped them. The trampoline lineage is
     * not lost: `created` and `handed-off` carry `lineageId` and
     * `roundOrdinal` in the decision payload, which is what walks a whole
     * trampoline chain.
     */
    const emitDecision = (
      runId: string,
      payload: unknown,
      sourceId = dependencies.journalSource
    ): Effect.Effect<void> =>
      // Unfenced by design: a decision record commits in the SAME transaction
      // as the store-level owner CAS that is its fence (`transitionOwned`,
      // `activate`, `claim`/`steal` outcomes), and by then the run is often no
      // longer `running` under this owner, which is the exact predicate the
      // journal fence asserts. Several call sites (claim-lost,
      // steal-refused-owner-alive, activation-lost) also record decisions for
      // runs this driver never owned at all — first-writer-wins evidence,
      // which is what the unfenced channel exists for.
      journal.emitDurableUnfenced(
        JournalRecords.runDecision({
          runId,
          lineageId: FlowEngine.Lineage.root(runId),
          sourceId,
          ...(sourceId === dependencies.journalSource ? {} : { sourceSeq: 0 })
        }, payload)
      ).pipe(Effect.asVoid, Effect.orDie)

    /**
     * Commits a run-row transition and the decision describing it in ONE write
     * transaction, reporting the store outcome.
     *
     * `RunStore` and the journal write through the same `DurableWriter`, so the CAS
     * becomes a savepoint of this transaction: a crash can no longer leave a
     * terminal run row whose `transitioned` decision never reached the
     * journal, nor a decision for a CAS that lost. Temporal commits mutable
     * state and its history events as one persistence request
     * (`reference/temporal/service/history/workflow/transaction_impl.go`);
     * this is the same unit of work for a run transition.
     *
     * The decision is emitted only for a `Transitioned` outcome — a lost CAS
     * changed nothing, and its `claim-lost`/`activation-lost` records are
     * emitted by the caller, outside the transaction, so they survive.
     */
    const transitionAndRecord = (
      runId: string,
      toStatus: RunStore.RunStatus,
      stateJson: string,
      decision: unknown,
      guard?: RunStore.TransitionGuard | undefined
    ): Effect.Effect<RunStore.TransitionOutcome> =>
      journal.transact(
        Effect.gen(function*() {
          const transitioned = yield* store.transitionOwned(
            runId,
            dependencies.owner,
            toStatus,
            stateJson,
            guard
          ).pipe(Effect.orDie)
          if (transitioned._tag !== "Transitioned") return transitioned
          // The decision carries the state it committed, so run state at a
          // frame is DERIVED by replaying decisions rather than read off the
          // run row's current `state_json`
          // (`docs/specs/Concepts/Time Travel.md`; Temporal's
          // `ndc/state_rebuilder.go` is the model). Without it a fork at an
          // early frame silently inherited the parent's *latest* state.
          yield* emitDecision(runId, { ...(decision as object), state: JSON.parse(stateJson) })
          return transitioned
        })
      ).pipe(Effect.orDie)

    const abandon = (runId: string, claimedAtMs: number): Effect.Effect<void> =>
      store.abandonClaim(runId, dependencies.owner, claimedAtMs).pipe(
        Effect.asVoid,
        Effect.orDie
      )

    const claimAndActivate: (row: RunStore.RunRow) => Effect.Effect<boolean> = Effect.fn(
      "RunDriver.claimAndActivate"
    )(function*(row: RunStore.RunRow) {
      return yield* Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({ runId: row.runId, status: row.status })
        if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
          yield* Effect.annotateCurrentSpan({ outcome: "terminal" })
          yield* Metric.update(EngineStoreMetrics.claim.Terminal, 1)
          return false
        }

        const expected = snapshot(row)
        const nowMs = yield* Clock.currentTimeMillis
        let claim: RunStore.ClaimOutcome

        if (row.status === "running") {
          if (
            row.owner === null ||
            row.heartbeatAtMs === null ||
            row.heartbeatAtMs >= nowMs - Duration.toMillis(Ownership.heartbeatStaleAfter)
          ) {
            yield* Effect.annotateCurrentSpan({ outcome: "heartbeat_fresh" })
            yield* Metric.update(EngineStoreMetrics.claim.HeartbeatFresh, 1)
            return false
          }
          if (yield* dependencies.isAlive(row.owner)) {
            yield* emitDecision(row.runId, {
              decision: "steal-refused-owner-alive",
              expectedOwner: row.owner,
              heartbeatAtMs: row.heartbeatAtMs
            })
            yield* Effect.annotateCurrentSpan({ outcome: "steal_refused_owner_alive" })
            yield* Metric.update(EngineStoreMetrics.claim.StealRefusedOwnerAlive, 1)
            yield* Effect.logDebug("run steal refused, recorded owner is alive", {
              runId: row.runId,
              heartbeatAtMs: row.heartbeatAtMs
            })
            return false
          }
          claim = yield* store.steal(
            row.runId,
            expected,
            dependencies.owner,
            nowMs,
            {
              expectedOwner: row.owner,
              checkedAtMs: nowMs,
              kind: row.owner.hostId === dependencies.owner.hostId
                ? "same-host-pid-dead"
                : "cross-host-unreachable-stale"
            }
          ).pipe(Effect.orDie)
        } else {
          claim = yield* store.claim(
            row.runId,
            expected,
            dependencies.owner,
            nowMs
          ).pipe(Effect.orDie)
        }

        if (claim._tag !== "Claimed") {
          yield* emitDecision(row.runId, {
            decision: "claim-lost",
            outcome: claim._tag,
            expected
          })
          yield* Effect.annotateCurrentSpan({ outcome: "claim_lost" })
          yield* Metric.update(EngineStoreMetrics.claim.ClaimLost, 1)
          yield* Effect.logDebug("run claim lost", { runId: row.runId, outcome: claim._tag })
          return false
        }

        // The activation CAS and the decision recording it commit together:
        // a crash between them left a run durably running under this owner
        // with no journal entry saying who took it.
        const activation = yield* journal.transact(
          Effect.gen(function*() {
            const activation = yield* store.activate(
              row.runId,
              dependencies.owner,
              claim.claimedAtMs,
              expected
            ).pipe(Effect.orDie)
            if (activation._tag !== "Activated") return activation
            yield* emitDecision(row.runId, {
              decision: row.status === "running" ? "stolen-and-activated" : "claimed-and-activated",
              previousStatus: row.status,
              owner: dependencies.owner
            })
            return activation
          })
        ).pipe(Effect.orDie)
        if (activation._tag !== "Activated") {
          yield* abandon(row.runId, claim.claimedAtMs)
          yield* emitDecision(row.runId, {
            decision: "activation-lost",
            outcome: activation._tag,
            expected
          })
          yield* Effect.annotateCurrentSpan({ outcome: "activation_lost" })
          yield* Metric.update(EngineStoreMetrics.claim.ActivationLost, 1)
          yield* Effect.logDebug("run activation lost", { runId: row.runId, outcome: activation._tag })
          return false
        }
        yield* Effect.annotateCurrentSpan({ outcome: "activated" })
        yield* Metric.update(EngineStoreMetrics.claim.Activated, 1)
        return true
      })
    })

    /**
     * Collects the transitive descendants of a run over the DURABLE
     * parent-edge table, nearest first.
     *
     * The edge table is the only representation of the subflow DAG that every
     * owner process and every restart can see (issues #40/#41), which is
     * exactly why the cascade reads it instead of an in-process instance map:
     * a cross-process cancellation is observed by a driver that never spawned
     * the children and holds no `FlowInstance` for any of them.
     *
     * Deduplicated by run id, so the diamond the edge set permits is visited
     * once and a (rejected, but defensively handled) cycle terminates. Work and
     * memory are bounded by the finite durable edge set; there is deliberately
     * no arbitrary fan-out cap, because truncating a wide generation would
     * leave linked children uncancelled forever.
     */
    const descendantsOf = (runId: string): Effect.Effect<ReadonlyArray<string>> =>
      Effect.gen(function*() {
        const seen = new Set<string>([runId])
        const ordered: Array<string> = []
        let frontier: ReadonlyArray<string> = [runId]
        while (frontier.length > 0) {
          const next: Array<string> = []
          for (const parentId of frontier) {
            for (const edge of yield* engineState.runChildren(parentId)) {
              if (seen.has(edge.childId)) continue
              seen.add(edge.childId)
              ordered.push(edge.childId)
              next.push(edge.childId)
            }
          }
          frontier = next
        }
        return ordered
      })

    /**
     * Records a durable cancellation request against every linked descendant
     * of a cancelled run.
     *
     * `requestCancel` is unfenced and first-writer-wins, so this is idempotent
     * by construction: re-running the cascade — a re-drive, a second operator
     * cancel, a child that also cascades from its own cancellation — writes
     * nothing the second time and answers `AlreadyRequested`. A row that no
     * longer exists answers `NotFound`, which is equally fine.
     *
     * `cancelOwned` calls it inside the same transaction as the parent's
     * terminal `cancelled` transition, so a crash cannot commit a cancelled
     * parent whose children were never asked to stop.
     *
     * Both callers record the run's OWN cancellation BEFORE this walk —
     * `interrupt` writes the request, `cancelOwned` commits the terminal
     * `cancelled` transition — and that order is load-bearing rather than
     * incidental. A late admission inherits by reading the parent row after it
     * has created the child row (`inheritParentCancellation`), so a walk that
     * ran before the parent was marked could miss an edge whose admission also
     * missed the mark. Under the SQL engine state both sides are one serialized
     * transaction each and the order is redundant; under
     * `DurableEngineState.makeMemory`, whose `transaction` is a pass-through,
     * it is the only thing closing that interleaving. It is pinned by test.
     */
    const requestCancelDescendants = (
      runId: string,
      nowMs: number
    ): Effect.Effect<ReadonlyArray<string>, RunStore.RunStoreError> =>
      Effect.gen(function*() {
        const descendants = yield* descendantsOf(runId)
        yield* Effect.forEach(
          descendants,
          (childId) => store.requestCancel(childId, nowMs),
          { discard: true }
        )
        return descendants
      })

    /**
     * Carries a parent's durable cancellation onto a child that was linked
     * AFTER the parent's cascade had already run.
     *
     * Admission and cancellation are two separate serialized write
     * transactions over the same store, so they interleave in both orders and
     * neither order may leak a live child (issue #83):
     *
     * - Admission first. The edge is committed before the cancellation
     *   transaction opens, so `requestCancelDescendants` sees the child and
     *   requests it. Nothing more is needed here.
     * - Cancellation first. The cascade walked `flows_run_parents` while the
     *   edge did not exist yet, so it could not have seen this child — and
     *   the parent's drive may already be gone, so nothing will walk the
     *   edge table again on its behalf. The child would be created fresh and
     *   uncancelled, and would run to completion under a cancelled parent.
     *
     * The second order is closed by reading the parent row inside the SAME
     * outer storage transaction that recorded the edge and created the child
     * row, after the child row exists. Either the cancellation transaction
     * committed before this read, in which case the request is visible here
     * and is inherited atomically with the child's own creation, or it has
     * not committed yet, in which case it commits after this transaction and
     * its own cascade sees the edge. There is no third interleaving, so no
     * ephemeral hand-off flag and no timing-based retry is involved. The
     * argument rests on two things: the store's serialized writes, and the
     * order inside `requestCancelDescendants` — a cancellation marks its own
     * run before it walks the edge table, which is what keeps the two sides
     * from missing each other even where `DurableEngineState.transaction` is
     * the in-memory pass-through and only the run-row writes serialize.
     *
     * Nesting falls out of this: the inherited request is written to the
     * child's own row, so a grandchild admitted later reads a cancel-requested
     * parent and inherits in turn.
     *
     * `requestCancel` is unfenced and first-writer-wins, so a repeated
     * admission writes nothing the second time; a parent row that is gone
     * answers `NotFound` and inherits nothing. Only a cancelled parent is
     * inherited from — `cancel_requested_at_ms`, or a parent already settled
     * terminally `cancelled` whose request column a compaction could have
     * cleared — so an ordinary `completed` or `failed` parent never cancels
     * a child.
     *
     * The child does not need its own cascade here: it was just created, so
     * it has no descendants of its own, and once it observes the inherited
     * request `cancelOwned` cascades from it like any other cancellation.
     */
    const inheritParentCancellation = (
      parentId: string,
      childId: string
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        const parent = yield* store.get(parentId).pipe(
          Effect.catch((error) =>
            error.code === "not_found_row"
              ? Effect.succeed(undefined)
              : Effect.die(error)
          )
        )
        if (parent === undefined) return
        if (parent.cancelRequestedAtMs === null && parent.status !== "cancelled") return
        // The parent's own request timestamp, so the inherited request reads
        // as the same operator intent rather than as a later, independent one.
        const nowMs = parent.cancelRequestedAtMs ?? (yield* Clock.currentTimeMillis)
        yield* store.requestCancel(childId, nowMs).pipe(Effect.orDie)
      })

    const cancelOwned = (
      runId: string,
      state: RunState
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        const interruptedAtMs = yield* Clock.currentTimeMillis
        const stateJson = yield* encodeState({
          ...withoutResult(state),
          cancellation: { interruptedAtMs }
        })
        let cascaded: ReadonlyArray<string> = []
        yield* journal.transact(
          Effect.gen(function*() {
            const transitioned = yield* store.transitionOwned(
              runId,
              dependencies.owner,
              "cancelled",
              stateJson
            ).pipe(Effect.orDie)
            if (transitioned._tag !== "Transitioned") return
            // Cancellation cascades to linked children (`Flow.interrupt` is
            // documented to preserve "child-flow handling"). It is recorded
            // durably, in this transaction, off the durable edge table, so the
            // cascade is identical whether the cancellation was requested in
            // this process or observed from another one — the pre-existing
            // in-process linkage in `FlowEngine.make` fires off the ephemeral
            // `instance.interrupted` flag, which a durable observation never
            // sets and a second driver instance never has.
            cascaded = yield* requestCancelDescendants(runId, interruptedAtMs)
            // A cancel can race the final poll after the run already parked
            // (park precedes the guarded terminal CAS). Clear the waiting row so
            // the terminally cancelled run never surfaces to a sweeper again
            // (issue #28). It shares the transition's transaction, so a crash
            // can no longer land between them.
            yield* engineState.wake(runId).pipe(Effect.asVoid)
            // Durable channel (issue #10): the interruption record must survive
            // the process exiting right after cancellation. Unfenced because the
            // `cancelled` transition above has already released ownership; the
            // fence is the transition CAS itself, which now commits with this
            // record rather than before it.
            yield* journal.emitDurableUnfenced(
              JournalRecords.interrupted({
                runId,
                lineageId: FlowEngine.Lineage.root(runId),
                sourceId: dependencies.journalSource
              }, {
                outcome: "cancelled",
                interruptedAtMs,
                owner: dependencies.owner,
                ...(cascaded.length === 0 ? {} : { cascadedTo: cascaded })
              })
            ).pipe(Effect.orDie)
          })
        ).pipe(Effect.orDie)
        // Post-commit, and only reachable after a transition that actually
        // happened. Closing the parked flow scope runs the finalizers the
        // suspension retained, with an interrupt exit so `Flow.withRollback`
        // compensations fire — cancellation is exactly the unsuccessful exit
        // they exist for. The run is durably cancelled first, so a crash
        // inside a finalizer cannot resurrect it.
        yield* releaseRetainedScope(runId, Exit.failCause(Cause.interrupt()))
        // Waking a cascaded child is in-process scheduling: a child this
        // process owns or has parked re-enters claim/activate now and the
        // activation cancel guard closes it, instead of waiting out a poll
        // interval. A child owned elsewhere ignores the wake and is reached by
        // its own owner's cancel poll or by that owner's parked-run sweep.
        if (cascaded.length > 0) {
          const activeCoordinator = yield* Deferred.await(coordinatorDeferred)
          yield* Effect.forEach(cascaded, (childId) => activeCoordinator.wake(childId), { discard: true })
        }
      })

    /**
     * Releases an interrupted run reclaimably instead of closing it
     * (issue #26). A drive-fiber interruption is not evidence of operator
     * cancellation — process shutdown closes the coordinator scope, and the
     * heartbeat loop self-interrupts on any heartbeat error — so the run
     * transitions back to `suspended` while the fence is still validly held,
     * leaving it claimable by any worker (Temporal worker-shutdown
     * semantics). On genuine fence loss the owned transition fails
     * harmlessly.
     */
    const releaseOwned = (
      runId: string,
      state: RunState
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        // Park before releasing ownership (`park` is owner-fenced). The
        // durable waiting row is what makes a released run visible to the
        // parked-run sweeper: without it nothing ever re-drives the run and
        // a durable `requestCancel` against it is write-only forever
        // (issue #39). On genuine fence loss the park reports NotFound
        // harmlessly, exactly like the transition below.
        const parked = yield* engineState.park(runId, { reason: "released" }, dependencies.owner)
        const transitioned = yield* transitionAndRecord(
          runId,
          "suspended",
          yield* encodeState(withoutResult(state)),
          { decision: "interrupt-released", owner: dependencies.owner }
        )
        // The successful arm is the generator's terminal fallthrough; V8 emits
        // no executable location for that synthetic branch.
        /* v8 ignore else */
        if (transitioned._tag !== "Transitioned") {
          // Fence lost between park and release: the run is someone else's
          // (or already settled), so our reclaim marker is bogus. Clear it
          // only if it is still ours — a new owner may have parked a real
          // waiting reason in between.
          if (parked._tag === "Parked") {
            const current = yield* engineState.waiting(runId)
            if (Option.isSome(current) && current.value.reason === "released") {
              yield* engineState.wake(runId)
            }
          }
          return
        }
      })

    /**
     * Discriminates an interruption cause by durable state: only an
     * interruption backed by a recorded cancel request closes the run;
     * anything else releases it for reclaim (issue #26).
     */
    const settleInterrupted = (
      runId: string,
      state: RunState
    ): Effect.Effect<void> =>
      store.get(runId).pipe(
        Effect.map((row) => row.cancelRequestedAtMs !== null),
        Effect.catch(() => Effect.succeed(false)),
        Effect.flatMap((requested) => requested ? cancelOwned(runId, state) : releaseOwned(runId, state))
      )

    const encodeResult = (
      flow: Flow.Any,
      result: Flow.Result<unknown, unknown>
    ): Effect.Effect<unknown> =>
      Schema.encodeEffect(
        Schema.toCodecJson(Flow.Result({
          success: flow.successSchema,
          error: flow.errorSchema
        }))
      )(result).pipe(Effect.orDie) as Effect.Effect<unknown>

    /**
     * Re-encodes a handoff payload through the target flow's own codec, so the
     * bytes the next round's row holds are the bytes `ensureRun` would write
     * for the same invocation.
     */
    const normalizePayload = (
      flow: Flow.Any,
      payload: unknown
    ): Effect.Effect<unknown> => {
      const codec = Schema.toCodecJson(flow.payloadSchema)
      return (Schema.decodeUnknownEffect(codec)(payload).pipe(
        Effect.orDie,
        Effect.flatMap((decoded) => Schema.encodeEffect(codec)(decoded)),
        Effect.orDie
      ) as Effect.Effect<unknown>)
    }

    /**
     * Creates one run row, tolerating only an existing row with identical
     * execution identity and encoded invocation data.
     */
    const ensureCreatedRun = (options: {
      readonly flowName: string
      readonly executionId: string
      readonly stateJson: string
      readonly payload: unknown
      readonly lineageId: string
      readonly roundOrdinal: number
      readonly parentRunId?: string | undefined
      readonly onCreated: Effect.Effect<void, never, never>
    }): Effect.Effect<void, never, never> =>
      Effect.gen(function*() {
        const created = yield* store.create(options.executionId, options.stateJson, {
          ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
          lineageId: options.lineageId,
          roundOrdinal: options.roundOrdinal
        }).pipe(Effect.exit)
        if (Exit.isSuccess(created)) {
          return yield* options.onCreated
        }

        // A cause carrying no `Fail` reason — an interrupt-only cause, or a
        // bare defect — used to reach `Option.getOrThrow(Exit.findErrorOption(...))`,
        // which threw a raw `NoSuchElementError` defect and discarded the
        // original cause. A caller that interrupted the fiber while
        // `store.create` was inside its write transaction saw a crash rather
        // than the cancellation it asked for. `Cause.findFail` hands back
        // that residual cause typed `Cause<never>`, so re-raising it verbatim
        // keeps an interrupt an interrupt (issue #151).
        const failure = Cause.findFail(created.cause)
        if (Result.isFailure(failure)) {
          return yield* Effect.failCause(failure.failure)
        }
        const error = failure.success.error
        if (!(error instanceof RunStore.RunStoreError) || error.code !== "constraint") {
          return yield* Effect.die(error)
        }
        const existing = yield* store.get(options.executionId).pipe(Effect.orDie)
        const persisted = yield* decodeState(existing.stateJson)
        // A pre-lineage round-0 row has null metadata. It remains an identical
        // root create after the additive migration; later rounds must carry
        // the exact chain metadata because no earlier build could create them.
        const legacyRoot = options.roundOrdinal === 0 &&
          existing.lineageId == null &&
          existing.roundOrdinal == null
        const sameRound = legacyRoot ||
          (existing.lineageId === options.lineageId && existing.roundOrdinal === options.roundOrdinal)
        const sameParent = options.parentRunId === undefined ||
          existing.parentRunId === options.parentRunId
        if (
          persisted.flowName !== options.flowName ||
          !samePayload(persisted.payload, options.payload) ||
          !sameRound ||
          !sameParent
        ) {
          return yield* Effect.die(
            new Error(
              `execution ${options.executionId} already belongs to a different flow tag or encoded payload, lineage, or round`
            )
          )
        }
      })

    const coordinatorDeferred = yield* Deferred.make<RunCoordinator.RunCoordinator<string, never>>()

    /**
     * Observes a durably recorded cancellation request
     * (`RunStore.requestCancel` / `cancel_requested_at_ms`) from another
     * process. Polls on the heartbeat cadence — the request is unfenced, so
     * only the owner can act on it, and it must act within a poll interval
     * (issue #11). Completes when a request is observed; races against the
     * flow like the heartbeat loop.
     */
    const cancelPollLoop = (executionId: string): Effect.Effect<CancelRequested> =>
      Effect.gen(function*() {
        // Check-first: a request that raced in just before activation is
        // observed without waiting out a full heartbeat (issue #27).
        while (true) {
          const requested = yield* store.get(executionId).pipe(
            Effect.map((row) => row.cancelRequestedAtMs !== null),
            Effect.catch(() => Effect.succeed(false))
          )
          if (requested) return cancelRequested
          yield* Effect.sleep(Ownership.heartbeatInterval)
        }
      })

    /**
     * What one handoff has to settle: the round that produced it, the row it
     * runs under (which carries the lineage columns), the state it was
     * activated with, its declaration, and the invocation it named.
     */
    interface HandoffSeam {
      readonly executionId: string
      readonly row: RunStore.RunRow
      readonly state: RunState
      readonly flow: Flow.Any
      readonly handoff: Flow.Handoff
    }

    /**
     * Opens the next round, and closes this one, in ONE transaction.
     *
     * `ensureRun`'s parent-edge/run-row pairing (issue #80) is the precedent
     * and the reason: a crash between the two writes would leave a terminal
     * round whose successor was never created, and nothing would ever look for
     * it again — the lineage would end silently at a round that says it handed
     * off. The stores' own writes become savepoints of this transaction, so
     * either both commit or neither.
     *
     * The next round is a run row chained through the RESERVED
     * `parent_run_id` column, not a `flows_run_parents` edge: that table is
     * the subflow DAG cycle detection walks, and a round is the same run
     * continuing rather than a child being spawned
     * (`docs/specs/Concepts/Trampoline Loops.md`).
     */
    const continueLineage = (
      seam: HandoffSeam,
      advanced: { readonly round: FlowEngine.Round.Round; readonly executionId: string }
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        // The handoff payload travels encoded, and the next round's row has to
        // hold the same bytes `ensureRun` would write for it: the root caller
        // re-enters `execute` for this round, and its identical-create check
        // compares the ENCODED payload. Round-tripping through the target's own
        // codec is what makes the two agree regardless of the key order the
        // body's object literal happened to have.
        //
        // A target this process does not run has no codec to normalize
        // through, and the round is still created with the payload verbatim —
        // the same posture the wake path takes for an unregistered flow, and
        // the reason a lineage survives a worker that only knows some of its
        // legs.
        const target = registrations.get(seam.handoff.flow)
        const payload = target === undefined
          ? seam.handoff.payload
          : yield* normalizePayload(target.flow, seam.handoff.payload)
        const nextStateJson = yield* encodeState({
          version: 1,
          flowName: seam.handoff.flow,
          payload,
          ...(seam.state.parentExecutionId === undefined
            ? {}
            : { parentExecutionId: seam.state.parentExecutionId }),
          ...(seam.state.maxRounds === undefined ? {} : { maxRounds: seam.state.maxRounds })
        })
        const settledStateJson = yield* encodeState({
          ...seam.state,
          result: yield* encodeResult(seam.flow, seam.handoff)
        })
        const cancelled = { _tag: "HandoffCancelled" } as const
        const fenceLost = { _tag: "HandoffFenceLost" } as const
        const committed = yield* Effect.result(
          engineState.transaction(Effect.gen(function*() {
            // The next round's id is DERIVED from (lineage, ordinal), so a
            // re-drive finds the exact row it already opened. Only an
            // identical create is tolerated; a collision in flow, payload,
            // parent, lineage, or ordinal is a defect.
            yield* ensureCreatedRun({
              flowName: seam.handoff.flow,
              executionId: advanced.executionId,
              stateJson: nextStateJson,
              payload,
              lineageId: advanced.round.lineageId,
              roundOrdinal: advanced.round.ordinal,
              parentRunId: seam.executionId,
              onCreated: emitDecision(advanced.executionId, {
                decision: "created",
                state: JSON.parse(nextStateJson),
                lineageId: advanced.round.lineageId,
                roundOrdinal: advanced.round.ordinal,
                parentExecutionId: seam.executionId
              })
            })
            // DECIDED (2026-08-11, pending review): a handed-off round settles
            // `completed`. The round did finish, and adding a `Continued`
            // status would widen every status reader for a distinction the
            // `handed-off` decision and lineage columns already record.
            //
            // DECIDED (2026-08-11, pending review): cancellation guards the
            // handoff transition. If it raced the last poll, failing the outer
            // transaction rolls successor creation back before the ordinary
            // cancellation path closes the owned round.
            const transitioned = yield* transitionAndRecord(
              seam.executionId,
              "completed",
              settledStateJson,
              {
                decision: "handed-off",
                status: "completed",
                flow: seam.handoff.flow,
                lineageId: advanced.round.lineageId,
                roundOrdinal: advanced.round.ordinal,
                nextExecutionId: advanced.executionId,
                owner: dependencies.owner
              },
              { cancelRequested: "absent" }
            )
            if (transitioned._tag === "Transitioned") return
            return yield* Effect.fail(
              transitioned._tag === "GuardFailed" ? cancelled : fenceLost
            )
          }))
        )
        if (Result.isFailure(committed)) {
          if (committed.failure._tag === "HandoffCancelled") {
            yield* cancelOwned(seam.executionId, seam.state)
          }
          return
        }
        // The root caller follows the lineage itself, but a discarded (or
        // orphaned) one does not exist to follow it, so the successor is woken
        // here rather than left for a sweep that has no reason to look at it.
        const activeCoordinator = yield* Deferred.await(coordinatorDeferred)
        yield* activeCoordinator.wake(advanced.executionId)
      })

    /**
     * Ends a lineage that asked for one round past its declared budget.
     *
     * The round itself ran to completion; what is refused is the handoff, so
     * the round settles `failed` carrying the typed refusal and no successor
     * is created (`docs/specs/Concepts/Trampoline Loops.md` §Budget).
     */
    const endLineage = (
      seam: HandoffSeam,
      error: Flow.MaxRoundsExceeded
    ): Effect.Effect<void> =>
      Effect.gen(function*() {
        const stateJson = yield* encodeState({
          ...seam.state,
          result: yield* encodeResult(seam.flow, new Flow.Complete({ exit: Exit.die(error) }))
        })
        const transitioned = yield* transitionAndRecord(
          seam.executionId,
          "failed",
          stateJson,
          {
            decision: "lineage-exhausted",
            status: "failed",
            lineageId: error.lineageId,
            maxRounds: error.maxRounds,
            owner: dependencies.owner
          },
          { cancelRequested: "absent" }
        )
        if (transitioned._tag === "GuardFailed") {
          yield* cancelOwned(seam.executionId, seam.state)
        }
      })

    /**
     * The handoff seam: the one place a round's terminal settlement and its
     * successor are decided together.
     */
    const handOff = (seam: HandoffSeam): Effect.Effect<void, never, Crypto.Crypto> =>
      FlowEngine.Round.next(
        {
          lineageId: seam.row.lineageId ?? seam.executionId,
          ordinal: seam.row.roundOrdinal ?? 0
        },
        // The origin persisted its budget into every round's state, so a
        // multi-flow handoff cannot reset the lineage by changing targets.
        { flowName: seam.flow._tag, maxRounds: seam.state.maxRounds }
      ).pipe(
        Effect.flatMap((advanced) => continueLineage(seam, advanced)),
        Effect.catch((error) => endLineage(seam, error))
      )

    const drive = (executionId: string): Effect.Effect<void, never, Crypto.Crypto> =>
      Effect.gen(function*() {
        const initial = yield* store.get(executionId).pipe(
          Effect.catch((error) =>
            error.code === "not_found_row"
              ? Effect.succeed(undefined)
              : Effect.die(error)
          )
        )
        if (initial === undefined) return

        const state = yield* decodeState(initial.stateJson)
        const registration = registrations.get(state.flowName)
        if (registration === undefined) {
          // A wake for a flow this process has not registered — after a full
          // restart the sweep re-drives released rows before (or without)
          // the flow ever registering here. Dropping the wake silently made
          // the #39 reclaim guarantee invisibly conditional on registration
          // (issue #62): warn (once per run, the sweep retries every
          // heartbeat) and leave the durable waiting row untouched so any
          // process that does register the flow still reclaims the run.
          if (!warnedUnregistered.has(executionId)) {
            warnedUnregistered.add(executionId)
            yield* Effect.logWarning(
              `engine-store: run ${executionId} woke for flow ${state.flowName}, which is not registered in this process; leaving it parked for a worker that registers the flow`,
              { runId: executionId, flowName: state.flowName }
            )
          }
          return
        }
        if (!(yield* claimAndActivate(initial))) return
        yield* Effect.logDebug("run activated", { flowName: state.flowName })

        const activeState = withoutResult(state)
        // The activation transition carries the cancel guard: a run whose
        // cancellation was durably requested while it was parked must cancel
        // here instead of re-executing flow side effects (issue #27).
        const cleared = yield* store.transitionOwned(
          executionId,
          dependencies.owner,
          "running",
          yield* encodeState(activeState),
          { cancelRequested: "absent" }
        ).pipe(Effect.orDie)
        if (cleared._tag === "GuardFailed") {
          return yield* cancelOwned(executionId, withoutResult(state))
        }
        if (cleared._tag !== "Transitioned") return
        // A run that re-enters execution is no longer waiting: clear any
        // parked waiting-reason payload (idempotent when none exists).
        yield* engineState.wake(executionId)

        const payload = yield* (Schema.decodeUnknownEffect(
          Schema.toCodecJson(registration.flow.payloadSchema)
        )(activeState.payload).pipe(Effect.orDie) as Effect.Effect<unknown>)
        // A previous round of this run may have parked and retained its flow
        // scope. That instance is now superseded — this round runs under the
        // fresh instance below, with a scope of its own — so release the old
        // one instead of orphaning it. `Exit.void`: a re-drive is a successful
        // continuation, so ordinary finalizers release resources while
        // `Flow.withRollback` compensations correctly stay out.
        yield* releaseRetainedScope(executionId, Exit.void)
        const instance = FlowEngine.makeInstance(
          registration.flow,
          executionId
        )
        const flowEngine = yield* dependencies.engine

        /**
         * Whether this round's suspension was durably accepted by the guarded
         * terminal transition — the one outcome that lets the retained flow
         * scope outlive the round.
         */
        let durableParkAccepted = false
        // ONE cleanup region, registered before the race starts and spanning
        // everything that can retain a scope or make its park durable: the
        // suspension surfacing, the retention insertion in the race's exit,
        // `encodeResult`, the pending-clock read, `engineState.park`, the
        // guarded transition and the journal write it commits with, and the
        // durable-park decision itself. Registering it here is what closes the
        // last window: retention is inserted by an uninterruptible finalizer,
        // and the fiber becomes interruptible again the instant that finalizer
        // returns, so any cleanup piped onto the settlement alone would never
        // be registered when an interrupt is already pending at that boundary —
        // the scope would stay retained until the driver's own scope closed,
        // which for a long-lived driver is not a release at all.
        //
        // `Exit.void` is the release exit, for the reason shutdown and a
        // supersede use it (issue #26): a park that never committed leaves the
        // run owned-but-stale or already re-owned, so it is reclaimed and
        // replayed, and the replay re-registers its `Flow.withRollback`
        // compensations under the reclaiming owner. Compensating here would
        // undo work the journal still reports as done — and would then do it
        // twice. Only a cancellation closes with an interrupt exit, and only
        // `cancelOwned` does that.
        yield* Effect.gen(function*() {
          // Published inside the region for the same reason: the entry used to
          // be written before `dependencies.engine` was awaited, one
          // interruptible step ahead of the `ensuring` that removes it, so an
          // interrupt landing there left this round's instance in the map for
          // the driver's lifetime — a slow leak, and a stale instance for
          // `interruptUnsafe` to mark interrupted.
          liveInstances.set(executionId, instance)
          const result = yield* Effect.scoped(
            Effect.raceFirst(
              Effect.raceFirst(
                registration.execute(payload as object, executionId).pipe(
                  Flow.intoResult,
                  Effect.provideService(FlowRuntime.FlowInstance, instance),
                  Effect.provideService(FlowRuntime.FlowRuntime, flowEngine)
                ),
                Ownership.heartbeatLoop(executionId, dependencies.owner).pipe(
                  Effect.provideService(RunStore.RunStore, store)
                )
              ),
              cancelPollLoop(executionId)
            )
          ).pipe(
            Effect.onInterrupt(() => settleInterrupted(executionId, activeState)),
            Effect.ensuring(Effect.sync(() => liveInstances.delete(executionId))),
            // A suspension is the ONE settlement `Flow.intoResult` leaves the
            // flow scope open for, so from the instant it surfaces the scope
            // needs an owner. Retention is taken HERE, inside the race's own
            // exit processing — `Effect.onExit` finalizers run uninterruptibly —
            // because taking it any later crosses an interruptible boundary: an
            // interrupt landing there would end the drive with the scope never
            // retained, unreachable, and its finalizers never run at all. The
            // entry is inserted into a cleanup region that was registered before
            // this race started, so it is owned from this instant on: every
            // ending, including an interrupt observed at the boundary between
            // this finalizer and the settlement below, releases it there.
            Effect.onExit((exit) =>
              Effect.suspend(() => {
                if (!(Exit.isSuccess(exit) && exit.value._tag === "Suspended")) return Effect.void
                retainedScopes.set(executionId, instance.scope)
                return dependencies.unsafeOnScopeRetained?.(executionId) ?? Effect.void
              })
            )
          )
          /**
           * Settles this round durably.
           *
           * A suspension that the guarded terminal transition durably accepts
           * sets `durableParkAccepted`, and that flag is the only thing that lets
           * a retained flow scope outlive this round. Every other ending — an
           * alternative settlement, a cancellation, a lost fence, a defect, an
           * interruption — leaves it unset, so the cleanup region registered
           * around the round releases the scope.
           */
          const settleRound = Effect.gen(function*() {
            if (result._tag === "CancelRequested") {
              yield* cancelOwned(executionId, activeState)
              return
            }

            // Corrupt evidence on a SUCCEEDED attempt row is an operator-visible
            // event, not a terminal run failure (issue #171): the row cannot be
            // evicted and re-executed like a corrupt cache row (#164) without
            // breaking exactly-once. ActionPersistence has already journalled
            // the corruption and quarantined only its boundary evidence off the
            // row. Park this first strict detection so it remains visible; the
            // next explicit resume returns the durable outcome without replaying
            // the poison or re-executing the action.
            const quarantine = result._tag === "Complete" && Exit.isFailure(result.exit)
              ? ActionPersistence.evidenceQuarantined(result.exit.cause)
              : undefined
            if (quarantine !== undefined) {
              yield* engineState.park(
                executionId,
                { reason: "quarantine", token: quarantine.keyDigest },
                dependencies.owner
              )
              const parked = yield* transitionAndRecord(
                executionId,
                "suspended",
                yield* encodeState(withoutResult(activeState)),
                {
                  decision: "quarantined",
                  status: "suspended",
                  keyDigest: quarantine.keyDigest,
                  owner: dependencies.owner
                },
                { cancelRequested: "absent" }
              )
              if (parked._tag === "GuardFailed") {
                yield* cancelOwned(executionId, activeState)
              }
              return
            }

            // A round that handed off settles through the seam instead: its
            // terminal transition and its successor's creation are one write, so
            // it cannot share the ordinary terminal path below.
            if (result._tag === "Handoff") {
              yield* handOff({
                executionId,
                row: initial,
                state: activeState,
                flow: registration.flow,
                handoff: result
              })
              return
            }

            const encodedResult = yield* encodeResult(registration.flow, result)
            const nextState: RunState = { ...activeState, result: encodedResult }
            const status: RunStore.RunStatus = result._tag === "Suspended"
              ? "suspended"
              : Exit.isSuccess(result.exit)
              ? "completed"
              : "failed"
            if (status === "suspended") {
              // Park while this process still owns the row (`park` is
              // owner-fenced; the suspended transition below releases
              // ownership). The reason is derived from durable state: a pending
              // clock row means a timer wake with a known deadline; anything
              // else waits on an external event (deferred completion). This is
              // what makes `waitingRuns` sweepers and the 0004 partial index
              // match real suspensions (issue #12).
              // A flow-declared classification (FlowRuntime.annotateWaiting) wins:
              // it is the only way an approval or quota wait — and its wake
              // token — reaches the parked row (issue #31). The durable-state
              // derivation stays the fallback.
              const declared = instance.waiting
              const pendingClocks = yield* engineState.pendingClocks({ executionId })
              const waiting: DurableEngineState.Waiting = declared !== undefined
                ? declared
                : pendingClocks.length > 0
                ? {
                  reason: "timer",
                  wakeAt: Math.min(...pendingClocks.map((clock) => clock.dueAtMs))
                }
                : { reason: "event" }
              yield* engineState.park(executionId, waiting, dependencies.owner)
            }
            // Finalize is guarded on `cancel_requested_at_ms` inside the same
            // CAS: a cancellation request that raced past the last poll turns
            // the terminal transition into GuardFailed, and the run cancels
            // instead of finalizing (issue #11).
            const transitioned = yield* transitionAndRecord(
              executionId,
              status,
              yield* encodeState(nextState),
              { decision: "transitioned", status, owner: dependencies.owner },
              { cancelRequested: "absent" }
            ).pipe(
              // The park becomes durable the instant this transition commits, so
              // the flag that records it is set in the transition's own exit
              // processing. `Effect.onExit` finalizers run uninterruptibly and
              // before the fiber can observe an interruption again, so no
              // interrupt can land between the durable commit and the flag and
              // make the cleanup region discard a scope the park still needs.
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (status === "suspended" && Exit.isSuccess(exit) && exit.value._tag === "Transitioned") {
                    durableParkAccepted = true
                  }
                })
              )
            )
            if (transitioned._tag === "GuardFailed") {
              // `cancelOwned` closes the retained scope itself, with the
              // interrupt exit cancellation compensations exist for. Leaving
              // `durableParkAccepted` unset therefore releases nothing a second
              // time: the entry is already gone from the map.
              yield* cancelOwned(executionId, activeState)
              return
            }
            // A lost fence (`NotFound`, a mismatched CAS) settles nothing: the
            // run is someone else's now, so a suspension holds no durable park
            // and the cleanup region releases the scope rather than holding it
            // until shutdown.
            if (transitioned._tag !== "Transitioned") return
            if (status !== "suspended") {
              // The settle is durable; tell any in-process caller parked on this
              // run's poll loop, so a run driven to completion by a sweep or a
              // coordinator wake is observed now rather than on the next tick.
              yield* wakeBus.wake(executionId)
              if (activeState.parentExecutionId !== undefined) {
                const activeCoordinator = yield* Deferred.await(coordinatorDeferred)
                yield* activeCoordinator.wake(activeState.parentExecutionId)
                yield* wakeBus.wake(activeState.parentExecutionId)
              }
              return
            }
          })

          yield* settleRound
        }).pipe(
          Effect.onExit(() =>
            // `releaseRetainedScope` deletes before it closes, so a path that
            // already released (`cancelOwned`, a supersede) finds no entry and
            // nothing is finalized twice. Deleting the instance is likewise
            // idempotent — the race's own `ensuring` normally does it first,
            // and this covers the endings that never reached the race. Neither
            // swallows the round's failure nor rewrites its cause.
            Effect.suspend(() => {
              liveInstances.delete(executionId)
              return durableParkAccepted ? Effect.void : releaseRetainedScope(executionId, Exit.void)
            })
          )
        )
      }).pipe(Effect.annotateLogs({ runId: executionId }))

    const coordinator = yield* RunCoordinator.make<string, never, Crypto.Crypto>({
      drain: drive
    })
    yield* Deferred.succeed(coordinatorDeferred, coordinator)

    /**
     * Delivers cancellation to parked runs (issue #27). A suspended run has
     * no owner and therefore no cancel poll, so `requestCancel` against it
     * is write-only until something re-drives the run — a run parked on a
     * deferred that never completes could otherwise never be cancelled. The
     * sweep lists parked rows, and wakes any whose cancel was durably
     * requested; the re-activation cancel guard then closes the run without
     * re-executing the flow.
     *
     * The same sweep reclaims interrupt-released runs (issue #39): a run
     * parked with reason `released` was interrupted mid-action by shutdown
     * or a heartbeat self-interrupt, has no pending clock and no completed
     * deferred, and would otherwise never be re-driven. Waking it re-enters
     * the ordinary claim/activate path, which also delivers any pending
     * cancel via the activation guard.
     */
    const sweepCancelRequested: Effect.Effect<void> = Effect.gen(function*() {
      // Fetch only actionable rows (issue #68): the sweep acts solely on
      // released rows and rows whose cancellation was durably requested, so
      // a large quota/event-parked fleet must cost it nothing per tick. The
      // per-row `store.get` below is a status guard over the (small)
      // actionable set, not a probe over every parked run — the in-memory
      // implementation without a `runs` view stays permissive on the cancel
      // predicate and relies on exactly this guard.
      const released = yield* engineState.waitingRuns({ reason: "released" })
      const cancelRequestedRows = yield* engineState.waitingRuns({ cancelRequested: true })
      const candidates = new Map<string, DurableEngineState.WaitingRow>()
      for (const waiting of released) candidates.set(waiting.runId, waiting)
      for (const waiting of cancelRequestedRows) candidates.set(waiting.runId, waiting)
      for (const waiting of candidates.values()) {
        const row = yield* store.get(waiting.runId).pipe(
          Effect.catch(() => Effect.succeed(undefined))
        )
        if (
          row !== undefined &&
          row.status === "suspended" &&
          (row.cancelRequestedAtMs !== null || waiting.reason === "released")
        ) {
          yield* coordinator.wake(row.runId)
        }
      }
    })
    /**
     * Reclaims hard-killed runs (issue #53). An owner that dies without
     * releasing (SIGKILL, OOM, power loss) leaves a `running` row with a
     * frozen heartbeat and no waiting row, so the parked-run sweep above
     * never sees it, and the steal path — reachable only through `drive()` —
     * is never entered. Enumerate stale-running rows and re-drive them: the
     * ordinary claim/steal path (liveness check, exact-snapshot steal CAS)
     * then decides whether the owner is genuinely dead — the analog of
     * Temporal's task-timeout re-dispatch. A pending durable cancel is
     * delivered by the re-activation guard, same as for parked runs.
     */
    const sweepStaleRunning: Effect.Effect<void> = Effect.gen(function*() {
      const nowMs = yield* Clock.currentTimeMillis
      // Capped per tick (issue #79): oldest heartbeats come back first, so a
      // mass owner death drains across successive ticks — batch after batch
      // as each stolen run's heartbeat leaves the stale window — instead of
      // every surviving driver waking every stale run every second and
      // contending N-drivers × M-runs on the claim/steal CAS.
      const stale = yield* engineState.staleRunningRuns(
        nowMs - Duration.toMillis(Ownership.heartbeatStaleAfter),
        staleRunningSweepBatch
      )
      for (const runId of stale) {
        yield* coordinator.wake(runId)
      }
    })
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(Ownership.heartbeatInterval).pipe(
          Effect.andThen(
            // One transient defect (a `SQLITE_BUSY` escaping `waitingRuns()`'s
            // `orDie`, a wake failure) must not kill the sweeper for the rest
            // of the process lifetime (issue #44) — that would silently revert
            // to pre-#27 behavior where cancel of parked runs is never
            // delivered. Mirror `armClock`'s hardening: expose the full cause,
            // log it, and keep ticking.
            sweepCancelRequested.pipe(
              Effect.andThen(sweepStaleRunning),
              Effect.sandbox,
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "engine-store: parked-run cancel sweep failed; retrying next tick",
                  cause
                )
              )
            )
          )
        )
      )
    )

    const ensureRun = (
      flow: Flow.Any,
      options: {
        readonly executionId: string
        readonly payload: object
        readonly parent?: FlowRuntime.FlowInstance["Service"] | undefined
        readonly round?:
          | (FlowEngine.Round.Round & {
            readonly previousExecutionId?: string | undefined
          })
          | undefined
      }
    ): Effect.Effect<void, FlowCycleDetected> =>
      Effect.gen(function*() {
        const payload = yield* (Schema.encodeEffect(
          Schema.toCodecJson(flow.payloadSchema)
        )(
          options.payload
        ).pipe(Effect.orDie) as Effect.Effect<unknown>)
        // Every requested parent — first (creating) parent and a diamond's
        // second parent alike — is recorded as a durable edge BEFORE the run
        // row is created. `recordRunParent` inserts the edge and checks for
        // a cycle inside one storage transaction (issues #29/#40/#54/#56),
        // so a rejected request fails here and never creates a run row — no
        // `state_json` parent can outlive a rejected edge (issue #55). The
        // edge table is the single source of truth for cycle detection in
        // every owner process and across restarts (issues #40/#41).
        //
        // The edge record and the run-row creation share one outer storage
        // transaction (issue #80): a crash between them used to commit a
        // durable orphan edge for a child run that never existed — never
        // GC'd, permanently walked by cycle detection, and able to force a
        // false FlowCycleDetected if the execution id was later reused
        // under an inverted topology. The stores' own writes become
        // savepoints of this transaction, so either both commit or neither.
        yield* engineState.transaction(Effect.gen(function*() {
          if (options.parent !== undefined) {
            yield* engineState.recordRunParent(
              options.executionId,
              options.parent.executionId
            ).pipe(
              Effect.catch((error) =>
                Effect.fail(
                  new FlowCycleDetected({ code: "flow_cycle_detected", path: error.path })
                )
              )
            )
          }
          const round = options.round ?? FlowEngine.Round.initial(options.executionId)
          const previousExecutionId = options.round?.previousExecutionId
          const state: RunState = {
            version: 1,
            flowName: flow._tag,
            payload,
            ...(options.parent === undefined
              ? {}
              : { parentExecutionId: options.parent.executionId }),
            ...(flow.maxRounds === undefined ? {} : { maxRounds: flow.maxRounds })
          }
          const createdStateJson = yield* encodeState(state)
          yield* ensureCreatedRun({
            flowName: flow._tag,
            executionId: options.executionId,
            stateJson: createdStateJson,
            payload,
            lineageId: round.lineageId,
            roundOrdinal: round.ordinal,
            ...(previousExecutionId === undefined
              ? {}
              : { parentRunId: previousExecutionId }),
            onCreated: Effect.gen(function*() {
              // The run's opening frame. `store.create` used to be the one
              // durable write with no journal record at all, which left the
              // replay-derived state projection with no base to fold onto —
              // `flowName` and `payload` exist nowhere else in the journal.
              // The state travels ENCODED, exactly as every later decision
              // carries it: `stateAt` folds these payloads and hands the winner
              // back as the run row's own `state_json`, so a base recorded in the
              // decoded shape would be a schema the caller cannot decode.
              yield* emitDecision(options.executionId, {
                decision: "created",
                state: JSON.parse(createdStateJson),
                ...(options.parent === undefined ? {} : { parentExecutionId: options.parent.executionId })
              })
              if (options.parent !== undefined) {
                // A spawn is a lineage edge, and a DETACHED spawn is a tier-3
                // effect: nothing the parent's rewind can undo, because the child
                // is its own claim and its own journal
                // (`docs/specs/Concepts/Subflows.md` §detached spawn). The record
                // is boundary-shaped so the same assessment that classifies a
                // sent webhook classifies an orphaned child, and it is emitted at
                // `succeeded` because by this point the child run durably exists.
                // Unfenced: the creator of a detached child is not necessarily
                // the parent's current owner (an external spawn admission
                // creates child rows without holding the parent's fence), so
                // this lineage-edge record is first-writer-wins evidence keyed
                // by its spawn identity.
                yield* journal.emitDurableUnfenced(
                  EffectRecords.boundary(
                    {
                      id: `${options.parent.executionId}:spawn:${options.executionId}`,
                      kind: spawnEffectKind,
                      tier: "irreversible",
                      runId: options.parent.executionId,
                      lineageId: FlowEngine.Lineage.root(options.parent.executionId),
                      sourceId: dependencies.journalSource,
                      attempt: 1,
                      residue:
                        `Child run ${options.executionId} exists and keeps its own journal; rewinding past its spawn orphans it.`
                    },
                    "succeeded",
                    // `attached` is written even though it is always false: the
                    // lineage-tree bridge in `@smthrs/time-travel` reads it off
                    // this payload, and an absent field there would make "this
                    // spawn is detached" indistinguishable from "this producer
                    // predates the field". A run created with a parent is a
                    // separate run row with its own claim, which is what detached
                    // means (`docs/specs/Concepts/Subflows.md`); attached nesting
                    // never reaches `create` because it is one journal.
                    { childRunId: options.executionId, flowName: flow._tag, attached: false }
                  )
                ).pipe(Effect.orDie)
              }
            })
          })
          // The row already exists; the durable edge recorded above is the
          // only place a diamond's second parent lives (issues #41/#48): a
          // driver-local side table would be invisible to other owners over
          // the same store, lost across restart, and would grow without
          // bound for the driver's lifetime.
          //
          // Which is also why the parent's cancellation is inherited HERE,
          // last and inside this same transaction: the child row must already
          // exist for `requestCancel` to have anything to write to, and the
          // inheritance must commit or roll back with the edge that made this
          // run a child in the first place. The inherited request is what the
          // activation guard reads, so the child cancels instead of executing
          // the flow body.
          if (options.parent !== undefined) {
            yield* inheritParentCancellation(
              options.parent.executionId,
              options.executionId
            )
          }
        }))
      })

    const poll: Service["poll"] = Effect.fn("FlowEngine.poll")((flow, executionId) =>
      Effect.annotateCurrentSpan({ executionId, flow: flow._tag }).pipe(
        Effect.andThen(store.get(executionId)),
        Effect.catch((error) =>
          error.code === "not_found_row"
            ? Effect.succeed(undefined)
            : Effect.die(error)
        ),
        Effect.flatMap((row) => {
          if (row === undefined) {
            // No run row at all is a typed not-found; `Option.none` is
            // reserved for a known run that has not settled yet.
            return Effect.fail(
              new FlowRuntime.FlowExecutionNotFound({
                code: "execution_not_found",
                executionId
              })
            )
          }
          return decodeState(row.stateJson).pipe(
            Effect.flatMap((state) => {
              if (
                state.flowName !== flow._tag ||
                state.result === undefined
              ) {
                return Effect.succeedNone
              }
              return (Schema.decodeUnknownEffect(
                Schema.toCodecJson(Flow.Result({
                  success: flow.successSchema,
                  error: flow.errorSchema
                }))
              )(state.result).pipe(
                Effect.orDie,
                Effect.map(Option.some)
              ) as Effect.Effect<Option.Option<Flow.Result<unknown, unknown>>>)
            })
          )
        })
      )
    )

    const execute: Service["execute"] = Effect.fn("FlowEngine.execute")(
      function*<const Discard extends boolean>(
        flow: Flow.Any,
        options: {
          readonly executionId: string
          readonly payload: object
          readonly discard: Discard
          readonly parent?: FlowRuntime.FlowInstance["Service"] | undefined
          readonly round?:
            | (FlowEngine.Round.Round & {
              readonly previousExecutionId?: string | undefined
            })
            | undefined
        }
      ) {
        yield* Effect.annotateCurrentSpan({ executionId: options.executionId, flow: flow._tag })
        if (!registrations.has(flow._tag)) {
          return yield* Effect.die(
            new Error(`Flow ${flow._tag} is not registered`)
          )
        }
        // Cycle rejection happens atomically inside `ensureRun`'s call to
        // `DurableEngineState.recordRunParent`: the storage transaction that
        // inserts the edge also walks the parent chain and rolls back on a
        // hit, so no in-process gate, cross-owner arbitration, or withdrawal
        // protocol is needed here (issues #29/#40/#54/#55/#56) and the
        // mutual `coordinator.run` deadlock cannot form.
        yield* ensureRun(flow, options)
        yield* coordinator.run(options.executionId)
        if (options.discard) return undefined as Discard extends true ? void : never
        // `ensureRun` created the row above, so a not-found here is a broken
        // store invariant, not a caller-recoverable state.
        const result = yield* Effect.orDie(poll(flow, options.executionId))
        return Option.getOrElse(result, () => new Flow.Suspended({})) as Discard extends true ? void
          : Flow.Result<unknown, unknown>
      }
    )

    const interrupt = Effect.fn("FlowEngine.interrupt")((
      _flow: Flow.Any,
      executionId: string
    ): Effect.Effect<void, FlowRuntime.CancelRequestFailed> =>
      Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({ executionId })
        // Operator intent is recorded durably before the fiber interrupt so
        // the interruption handler can tell cancellation apart from shutdown
        // (issue #26), and so the request survives if this process dies
        // before the interrupt lands.
        //
        // The write used to be `Effect.ignore`d, which answered success for a
        // cancellation that was never recorded: the fiber interrupt that
        // follows is then read as a shutdown by `settleInterrupted`, the run
        // is RELEASED for reclaim rather than cancelled, another worker picks
        // it up, and the caller was told the run was cancelled. The failure is
        // typed instead, so the caller can retry against a state that is still
        // truthful — the run is still running and still cancellable.
        const nowMs = yield* Clock.currentTimeMillis
        const requested = yield* Effect.result(journal.transact(
          Effect.gen(function*() {
            yield* store.requestCancel(executionId, nowMs)
            yield* requestCancelDescendants(executionId, nowMs)
          })
        ))
        if (Result.isFailure(requested)) {
          return yield* Effect.fail(
            new FlowRuntime.CancelRequestFailed({
              code: "cancel_request_failed",
              executionId,
              reason: requested.failure.message
            })
          )
        }
        // Only after the durable write succeeds may the ephemeral surface say
        // this instance was interrupted or stop its drive fiber. If the write
        // failed, changing either would make a typed failure observably mutate
        // the run (and could spuriously trigger the in-process child path).
        const instance = liveInstances.get(executionId)
        if (instance !== undefined) instance.interrupted = true
        // The transaction above records the parent and every durable
        // descendant together. A run this process does not drive — parked
        // here, owned elsewhere, or already settled — therefore receives the
        // same child-flow handling without a partial-cascade state if any
        // request write fails. `requestCancel` is first-writer-wins, so the
        // owning driver's own cascade later writes nothing.
        yield* coordinator.interrupt(executionId)
      })
    )

    const scheduleResume: Service["scheduleResume"] = Effect.fn("FlowEngine.scheduleResume")((
      flowName,
      executionId,
      reason,
      sourceId
    ) =>
      Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({ executionId, flow: flowName, reason })
        const row = yield* store.get(executionId).pipe(
          Effect.catch((error) =>
            error.code === "not_found_row"
              ? Effect.succeed(undefined)
              : Effect.die(error)
          )
        )
        if (row === undefined) return
        const state = yield* decodeState(row.stateJson)
        if (state.flowName !== flowName) return
        yield* emitDecision(executionId, {
          decision: "wake-scheduled",
          reason
        }, sourceId)
        yield* coordinator.wake(executionId)
        // The runnability change (deferred completed, clock fired, operator
        // resume) is already durable — the caller commits before scheduling —
        // so announcing after the coordinator enqueues the re-drive lets an
        // in-process waiter skip the rest of its poll sleep.
        yield* wakeBus.wake(executionId)
      })
    )

    return {
      register: Effect.fn("FlowEngine.register")((flow, handler) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const registration = { flow, execute: handler }
            registrations.set(flow._tag, registration)
            warnedUnregistered.clear()
            return registration
          }),
          (registration) =>
            Effect.sync(() => {
              if (registrations.get(flow._tag) === registration) {
                registrations.delete(flow._tag)
              }
            })
        ).pipe(Effect.asVoid)
      ),
      execute,
      poll,
      interrupt,
      interruptUnsafe: Effect.fn("FlowEngine.interruptUnsafe")(interrupt),
      resume: Effect.fn("FlowEngine.resume")((flow, executionId) =>
        Effect.annotateCurrentSpan({ executionId, flow: flow._tag }).pipe(
          Effect.andThen(scheduleResume(flow._tag, executionId, "operator")),
          Effect.andThen(coordinator.run(executionId))
        )
      ),
      scheduleResume,
      active: Effect.fn("FlowEngine.active")(() => coordinator.active)(),
      retainedRuns
    }
  })
