/**
 * Drives a persisted plan: the node scheduler.
 *
 * `@smthrs/plan` makes the plan a value; this makes it run. The scheduler
 * walks the persisted graph, dispatches ready nodes through the same
 * `internal/ActionPersistence` seam every action uses — so the shared step
 * cache, the workspace sandbox's execute→materialize transaction, attempt
 * rows, and the fenced journal all apply unchanged — and records an
 * evaluation outcome per node.
 *
 * ## What it is, and what it is not
 *
 * Skyframe's `AbstractParallelEvaluator` is the prior art for the state
 * machine (`CHECK_DEPENDENCIES → VERIFIED_CLEAN | NEEDS_REBUILDING →
 * REBUILDING → DONE`) and `EvaluationProgressReceiver` for the outcome
 * vocabulary. Two deliberate deviations:
 *
 * 1. **No reverse-dependency index, no invalidating node visitor.**
 *    `docs/specs/Concepts/Engine Hardening Round 1.md` rejects both outright:
 *    content addressing subsumes them. A node is "dirty" iff the key it would
 *    dispatch under differs from the one it dispatched under, and the
 *    dispatch-time recheck already computes that. There is no dirty bit to
 *    propagate, so there is nothing for a visitor to walk.
 * 2. **Completion-driven, without Skyframe restarts.** Skyframe atomically
 *    signals reverse dependencies when one node settles. Our dependencies are
 *    declared in the plan before anything runs, so one coordinator can make
 *    the equivalent decision from the plan, settled state, and scheduling
 *    permits: every completion is reconciled and immediately opens another
 *    admission pass. Giving up the wavefront barrier also gives up its
 *    trivially serialized reconciliation; draining and applying the durable
 *    deviation journal after each settlement, before reevaluating downstream
 *    readiness, restores that ordering without holding unrelated ready cones.
 *    The coordinator is the sole writer of scheduling state, which keeps every
 *    admission decision deterministic without the `DeterministicHelper` the
 *    vault rejected.
 *
 * ## The three limits
 *
 * `docs/specs/Concepts/Concurrency.md` insists the same number must never
 * stand in for graph width, scheduler admission, and provider capacity. This
 * module owns the middle one only: `concurrency.steps` is the leaf-execution
 * cap, and `concurrency.agents` is the subset cap an agent node consumes in
 * addition. Structural width is whatever the plan says; seats belong to
 * `Agent Adapters` and are not modelled here.
 *
 * Under contention, ready work is ordered by effective priority — declared
 * `priority` plus one point per capacity-constrained admission pass. A ready
 * node gains a point exactly when a pass considers it but cannot give it the
 * required permits. Aging is what lets priority change latency without
 * permitting starvation; equal effective priorities preserve deterministic
 * plan order.
 *
 * ## Observing the world exactly once
 *
 * `docs/specs/Concepts/Staleness.md`'s torn-run rule: never re-observe the
 * world mid-run. Paths the plan reads but no node writes are **source** paths;
 * they are measured once, before the first dispatch, and pinned for the rest
 * of the run. Paths a node in the plan produces are measured after their
 * producer settles — observing our own output, not the world.
 *
 * @since 0.1.0
 */
import { Sha256 } from "@smthrs/crypto"
import { FlowEngine } from "@smthrs/engine"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import { Journal, type JournalEvent } from "@smthrs/journal"
import type { Jj } from "@smthrs/kernel"
import { Plan, PlanStore, StepKey } from "@smthrs/plan"
import * as FileSet from "@smthrs/plan/FileSet"
import type { AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
import type { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as EngineStoreMetrics from "./EngineStoreMetrics.ts"
import * as ActionPersistence from "./internal/ActionPersistence.ts"
import * as FileEnumeration from "./internal/FileEnumeration.ts"
import * as JournalRecords from "./internal/JournalRecords.ts"
import { compareText } from "./internal/Ordering.ts"
import * as Reconciliation from "./Reconciliation.ts"
import * as Selection from "./Selection.ts"
import * as StepBoundary from "./StepBoundary.ts"
import * as WorkspaceSandbox from "./WorkspaceSandbox.ts"

/**
 * The evaluation outcomes: Skyframe's `EvaluationState` adapted to a
 * content-addressed store, plus the selection debt.
 *
 * - `built` — the node executed (`SUCCESS_VERSION_CHANGED`).
 * - `clean` — the shared cache served it and nothing ran
 *   (`SUCCESS_VERSION_UNCHANGED`). This is the outcome the whole design is
 *   for: an unchanged branch costs nothing.
 * - `failed` — the node executed and failed, or reconciliation failed it.
 * - `skipped` — the node never dispatched, because its cone failed or because
 *   a `stop-merge` strategy stopped it in favour of a merge node. Skyframe
 *   splits failure by version instead; a content-addressed store never serves
 *   a failure from cache, so that split has no meaning here and this one does.
 * - `deferred` — a selection guess postponed this sink
 *   (`docs/specs/Concepts/Probabilistic Selection.md`). It never dispatched,
 *   wrote no cache row, and is journaled as a debt for a later guess-free
 *   pass. Distinct from `skipped` — the work was runnable, a guess postponed
 *   it — and never reported as passed.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Outcome = "built" | "clean" | "failed" | "skipped" | "deferred"

/**
 * One material `Ref` input, resolved: the settled output of `from` projected
 * along `path` — exactly the value whose digest the dispatch key folds.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface ResolvedInput {
  readonly from: string
  readonly path: ReadonlyArray<string>
  readonly value: unknown
}

/**
 * What the scheduler hands a node's executor.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface NodeInput {
  readonly node: Plan.PlanNode
  readonly attempt: number
  /** The measured boundary this dispatch was keyed under. */
  readonly boundary: FileBoundary
  /**
   * The node's material `Ref` inputs, resolved through the same projection the
   * dispatch key digests. Ordering (`Pending`) dependencies and unprojected
   * sibling fields are deliberately absent: an executor may only see data the
   * key folds, or a cached settlement could be served for an execution that
   * consumed something else.
   */
  readonly inputs: ReadonlyArray<ResolvedInput>
}

/**
 * The DI seam that turns a plan node into work.
 *
 * The scheduler owns identity, admission, caching, and journaling; it
 * deliberately owns nothing about what a node *means*. A flow runtime, a test,
 * or a remote host each supply their own executor.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Executor {
  readonly execute: (input: NodeInput) => Effect.Effect<unknown, unknown>
}

/**
 * Service tag for the node executor.
 *
 * @since 0.1.0
 * @category services
 * @slop
 */
export class NodeExecutor extends Context.Service<NodeExecutor, Executor>()("@smthrs/engine-store/NodeExecutor") {}

/**
 * Provides a plain {@link Executor} value as the {@link NodeExecutor} service.
 *
 * This is the whole wiring story for the scheduler's one open seam: a flow
 * runtime, a test double, or a remote dispatcher each become a layer by
 * passing themselves here.
 *
 * @since 0.1.0
 * @category layers
 * @slop
 */
export const layerExecutor = (executor: Executor): Layer.Layer<NodeExecutor> => Layer.succeed(NodeExecutor, executor)

/**
 * How one node ended.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Settlement {
  readonly nodeId: string
  /** The plan-time key: a pure function of declarations. */
  readonly planKey: string
  /** The key dispatched under: the node's own material, the content of its consumed inputs, and the measured boundary — never the transitive plan key. */
  readonly dispatchKey: string
  readonly outcome: Outcome
  readonly attempts: number
  readonly rebases: number
}

/**
 * What a run of a plan produced.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Report {
  readonly planId: string
  readonly digest: string
  readonly settlements: ReadonlyArray<Settlement>
  readonly results: Readonly<Record<string, unknown>>
  readonly verdicts: ReadonlyArray<{ readonly nodeId: string; readonly verdict: Reconciliation.Verdict }>
  /** Merge nodes a `stop-merge` conflict appended to the plan. */
  readonly appended: ReadonlyArray<string>
}

/**
 * Scheduler construction options.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Options {
  readonly runId: string
  readonly owner: Ownership.OwnerId
  readonly sourceId: string
  /**
   * The engine-resolved execution environment each dispatch is keyed under.
   * Omitting it preserves the existing dispatch identity.
   */
  readonly environment?: StepKey.EnvironmentIdentity | undefined
  /**
   * The admission caps. Both default to unbounded, because a cap the caller
   * did not declare is not the scheduler's to invent — `aspects.ts` owns the
   * policy and narrows it. Both floor at one: a cap of zero admits nothing,
   * and a scheduler with no permits can never make progress.
   */
  readonly concurrency?: {
    readonly steps?: number | undefined
    readonly agents?: number | undefined
  } | undefined
  /**
   * How many times a `delay-rebase` node may re-measure and re-key against a
   * newly recorded base before reconciliation is asked. Bounded on purpose: an
   * unbounded rebase loop is a livelock with good manners.
   */
  readonly rebaseLimit?: number | undefined
  /**
   * Probabilistic selection input for this run (`Selection`). Every field is
   * optional because every default is inert: no changed paths and no beliefs
   * admit everything, so a caller that never opted in runs exactly as today.
   * `full: true` is the run-level override — every verdict is treated as
   * `Admit` and the override is journaled, the way `--fresh` ignores the
   * cache.
   */
  readonly selection?: {
    /** Changed paths the belief edges are matched against. */
    readonly changed?: ReadonlyArray<string> | undefined
    /** The belief snapshot pinned before planning. */
    readonly beliefs?: Selection.BeliefSnapshot | undefined
    /** Deferral policy; `deferBelow` defaults to zero, which defers nothing. */
    readonly policy?: Selection.Policy | undefined
    /** Force full selection: treat every verdict as `Admit`, journaled. */
    readonly full?: boolean | undefined
  } | undefined
}

/**
 * Everything driving a plan needs from the composition.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Requirements =
  | AttemptStore.AttemptStore
  | CacheStore.CacheStore
  | Crypto.Crypto
  | Jj.Jj
  | Journal.Journal
  | NodeExecutor
  | PlanStore.PlanStore
  | RunStore.RunStore
  | StepBoundary.Service

/**
 * A refusal the scheduler itself raises. A node's own failure is an outcome,
 * not one of these — the run continues and the report says `failed`.
 *
 * @since 0.1.0
 * @category errors
 * @slop
 */
export class SchedulerError extends Schema.TaggedError<SchedulerError>()("@smthrs/engine-store/SchedulerError", {
  code: Schema.Literals(["boundary_unavailable", "key_uncomputable", "elaboration_failed", "store_failed"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

/**
 * Plan-driving operations.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Service {
  /** Persists generation 0 and journals `plan-recorded`. */
  readonly record: (
    plan: Plan.Plan
  ) => Effect.Effect<PlanStore.RecordResult, SchedulerError, PlanStore.PlanStore | Journal.Journal>
  /** Persists the newest generation and journals `subgraph-appended`. */
  readonly append: (plan: Plan.Plan) => Effect.Effect<void, SchedulerError, PlanStore.PlanStore | Journal.Journal>
  /** Drives the plan to completion and reports every node's outcome. */
  readonly run: (plan: Plan.Plan) => Effect.Effect<Report, SchedulerError, Requirements>
}

/**
 * Service tag for the plan scheduler.
 *
 * @since 0.1.0
 * @category services
 * @slop
 */
export class PlanScheduler extends Context.Service<PlanScheduler, Service>()("@smthrs/engine-store/PlanScheduler") {}

/**
 * The declared digest handed to `StepBoundary.prepare` when the scheduler is
 * *asking* what a path holds rather than asserting it. Prepare measures every
 * declared read regardless of what the declaration claims, so any placeholder
 * works; a self-describing one can never be mistaken for a real digest.
 *
 * @private
 */
const unmeasured = "unmeasured"

/** @private */
const isConflict = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) => Cause.isFailReason(reason) && WorkspaceSandbox.isMaterializationConflict(reason.error))

/** @private */
const DeviationPayload = Schema.Struct({
  stepKeyDigest: Schema.NonEmptyString,
  attempt: Schema.Int,
  paths: Schema.Array(Schema.String),
  diffIdentity: Schema.String
})

const decodeDeviation = Schema.decodeUnknownOption(DeviationPayload)

const digestOf = Schema.decodeUnknownEffect(Sha256)

/** @private */
interface NodeState {
  status: "pending" | "running" | "settled"
  outcome: Outcome
  attempts: number
  rebases: number
  waited: number
  dispatchKey: string
}

/** @private */
interface DispatchStart {
  readonly dispatchKey: string
  readonly attempts: number
  readonly rebases: number
  readonly waited: number
  readonly results: ReadonlyMap<string, unknown>
  readonly inputs: ReadonlyArray<ResolvedInput>
}

/** @private */
interface ObservedRead {
  readonly entry: FileSet.ReadEntry
  /** Source members observed when this declaration entered the run. */
  readonly sourcePaths: ReadonlyArray<string>
}

/** @private */
interface DispatchProgress {
  readonly dispatchKey: string
  readonly attempts: number
  readonly rebases: number
}

/** @private */
interface CompletedDispatch extends DispatchProgress {
  readonly outcome: "built" | "clean"
  readonly result: unknown
}

/** @private */
interface FailedDispatch extends DispatchProgress {
  readonly outcome: "failed"
}

/** @private */
interface ConflictedDispatch extends DispatchProgress {
  readonly outcome: "conflicted"
  readonly strategy: Plan.RuntimeStrategy
}

/** @private */
type Dispatched = CompletedDispatch | FailedDispatch | ConflictedDispatch

/** @private */
interface DispatchSettlementEvent {
  readonly _tag: "DispatchSettled"
  readonly node: Plan.PlanNode
  readonly exit: Exit.Exit<Dispatched, SchedulerError>
}

/** @private */
type CoordinatorEvent =
  | { readonly _tag: "AttemptKeyed"; readonly nodeId: string; readonly digest: string }
  | DispatchSettlementEvent

const storeFailure = (message: string) => (cause: unknown) =>
  new SchedulerError({ code: "store_failed", message, cause })

const positiveSafeInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return value
}

const nonNegativeSafeInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

/**
 * Constructs a scheduler bound to one run.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make = (options: Options): Service => {
  const rebaseLimit = nonNegativeSafeInteger("rebaseLimit", options.rebaseLimit ?? 3)
  const stepCap = positiveSafeInteger("concurrency.steps", options.concurrency?.steps ?? Number.MAX_SAFE_INTEGER)
  const agentCap = positiveSafeInteger("concurrency.agents", options.concurrency?.agents ?? Number.MAX_SAFE_INTEGER)

  // Every scheduler record addresses the run's root lineage, so a frame can
  // reach it (`docs/specs/Concepts/Time Travel.md`).
  const lineageId = FlowEngine.Lineage.root(options.runId)
  const source = (suffix: string) => ({ runId: options.runId, sourceId: `${options.sourceId}/${suffix}`, lineageId })

  /**
   * Scheduler records take the journal's durable, owner-fenced channel: a plan
   * digest binds an approval, so it may never ride the lossy queue. A zombie
   * that lost the run self-interrupts on `fence_lost`, exactly as
   * `internal/ActionPersistence` does — a scheduler that kept dispatching
   * after losing ownership is the failure mode fencing exists to prevent.
   */
  const emit = (record: JournalEvent.Input) =>
    Effect.flatMap(Journal.Journal, (journal) => journal.emitDurable(record, options.owner)).pipe(
      Effect.catch((error) =>
        error.code === "fence_lost"
          ? Effect.interrupt
          : Effect.fail(storeFailure("the scheduler could not journal a record")(error))
      )
    )

  const atomically = <A, E, R>(message: string, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(Journal.Journal, (journal) => journal.transact(effect)).pipe(
      Effect.mapError((error) => error instanceof SchedulerError ? error : storeFailure(message)(error))
    )

  const record: Service["record"] = Effect.fn("PlanScheduler.record")((plan) =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({
        runId: options.runId,
        planId: plan.planId,
        digest: plan.digest,
        generation: plan.generation
      })
      const store = yield* PlanStore.PlanStore
      const now = yield* Clock.currentTimeMillis
      const outcome = yield* atomically(
        "could not atomically record the plan",
        Effect.gen(function*() {
          const recorded = yield* store.record(plan, now).pipe(
            Effect.mapError(storeFailure("could not record the plan"))
          )
          yield* emit(JournalRecords.planRecorded(source(`plan/${plan.planId}`), {
            planId: plan.planId,
            flow: plan.flow,
            digest: plan.digest,
            baseDigest: plan.baseDigest,
            generation: plan.generation,
            nodes: plan.nodes.length,
            outcome: recorded._tag
          }))
          return recorded
        })
      )
      yield* Effect.annotateCurrentSpan({ outcome: outcome._tag })
      return outcome
    })
  )

  const append: Service["append"] = Effect.fn("PlanScheduler.append")((plan) =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({
        runId: options.runId,
        planId: plan.planId,
        digest: plan.digest,
        generation: plan.generation
      })
      const store = yield* PlanStore.PlanStore
      yield* atomically(
        "could not atomically append the subgraph",
        Effect.gen(function*() {
          yield* store.append(plan).pipe(Effect.mapError(storeFailure("could not append the subgraph")))
          yield* emit(JournalRecords.subgraphAppended(source(`plan/${plan.planId}/${plan.generation}`), {
            planId: plan.planId,
            digest: plan.digest,
            baseDigest: plan.baseDigest,
            generation: plan.generation,
            nodeIds: Plan.generationNodes(plan).map((node) => node.id)
          }))
        })
      )
      yield* Effect.annotateCurrentSpan({ outcome: "appended" })
    })
  )

  const run: Service["run"] = Effect.fn("PlanScheduler.run")((initial) =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({
        runId: options.runId,
        planId: initial.planId,
        digest: initial.digest,
        nodes: initial.nodes.length
      })
      const boundaries = yield* StepBoundary.StepBoundary
      const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem)
      const executor = yield* NodeExecutor
      const journal = yield* Journal.Journal
      const reconciler = Option.getOrElse(
        yield* Effect.serviceOption(Reconciliation.Reconciliation),
        Reconciliation.makeDefault
      )
      const selector = Option.getOrElse(
        yield* Effect.serviceOption(Selection.Selection),
        Selection.makeNoop
      )
      yield* Effect.logDebug("scheduler run started", {
        digest: initial.digest,
        nodes: initial.nodes.length
      })

      let plan = initial
      const states = new Map<string, NodeState>()
      const results = new Map<string, unknown>()
      const digestMemo = StepKey.makeDigestMemo()
      const verdicts: Array<{ nodeId: string; verdict: Reconciliation.Verdict }> = []
      const appended: Array<string> = []
      /** Ordering edges reconciliation discovered; live for this run only. */
      const discovered = new Map<string, Array<string>>()
      const digestToNode = new Map<string, Array<string>>()
      const deviationSignatures = new Map<string, string>()
      const writers = new Map<string, string>()
      const writerEntries: Array<{ readonly entry: FileSet.Entry; readonly nodeId: string }> = []
      let cursor: number | undefined = undefined
      const events = yield* Queue.unbounded<CoordinatorEvent>()

      const stateOf = (node: Plan.PlanNode): NodeState => {
        const existing = states.get(node.id)
        if (existing !== undefined) return existing
        const fresh: NodeState = {
          status: "pending",
          outcome: "skipped",
          attempts: 0,
          rebases: 0,
          waited: 0,
          dispatchKey: ""
        }
        states.set(node.id, fresh)
        return fresh
      }

      /**
       * Which node produces each path. First declaration wins, matching the
       * plan compiler's declaration-order conflict resolution. A declared
       * removal counts: the plan produces that path's post-state, so pinning
       * it as an unproduced source input would measure the world at a moment
       * the plan is about to move.
       */
      const indexWriters = () => {
        writerEntries.length = 0
        writers.clear()
        for (const node of plan.nodes) {
          for (const entry of [...FileSet.expand(node.effects.writes), ...node.effects.removes ?? []]) {
            writerEntries.push({ entry, nodeId: node.id })
            if (typeof entry === "string" && !writers.has(entry)) writers.set(entry, node.id)
          }
        }
      }
      indexWriters()

      const writerFor = (path: string): string | undefined =>
        writers.get(path) ?? writerEntries.find(({ entry }) => FileSet.overlaps(entry, path))?.nodeId

      const expandReads = (entries: ReadonlyArray<FileSet.ReadEntry>, what: string) =>
        Effect.gen(function*() {
          const expanded: Array<{ readonly entry: FileSet.ReadEntry; readonly paths: ReadonlyArray<string> }> = []
          for (const entry of entries) {
            if (typeof entry === "string") {
              expanded.push({ entry, paths: [entry] })
              continue
            }
            if (Option.isNone(fileSystem)) {
              return yield* Effect.fail(
                new SchedulerError({
                  code: "boundary_unavailable",
                  message: `the host cannot expand ${what} without a FileSystem`
                })
              )
            }
            // Through `FileEnumeration`, never the host `glob`: host results
            // are absolute under the kernel FileSystem and skip dotfiles, so
            // a workspace-relative pattern silently expanded to nothing.
            const matches = yield* FileEnumeration.expandGlob(fileSystem.value, entry).pipe(
              /* v8 ignore next 6 -- host refusal translation is the same typed boundary-unavailable path exercised by prepare failures */
              Effect.mapError((cause) =>
                new SchedulerError({
                  code: "boundary_unavailable",
                  message: `the host could not expand ${what}`,
                  cause
                })
              )
            )
            expanded.push({ entry, paths: matches })
          }
          return expanded
        })

      const prepare = (paths: ReadonlyArray<string>, what: string) =>
        boundaries.prepare({
          readSet: [...new Set(paths)].sort().map((path) => ({ path, digest: unmeasured })),
          writeSet: [],
          boundaryMode: "hard"
        }).pipe(
          Effect.mapError((cause) =>
            new SchedulerError({
              code: "boundary_unavailable",
              message: `the host could not measure ${what}`,
              cause
            })
          )
        )

      const expandProducedMatches = (glob: FileSet.Glob, what: string) =>
        Effect.gen(function*() {
          /* v8 ignore next 8 -- a producer-covered glob reaches here only after `observeReads` expanded the same glob, and that expansion already failed the run when no FileSystem was composed */
          if (Option.isNone(fileSystem)) {
            return yield* Effect.fail(
              new SchedulerError({
                code: "boundary_unavailable",
                message: `the host cannot expand ${what} without a FileSystem`
              })
            )
          }
          const paths = new Set<string>()
          for (const { entry } of writerEntries) {
            if (!FileSet.overlaps(glob, entry)) continue
            if (typeof entry === "string") {
              const present = yield* fileSystem.value.exists(entry).pipe(
                /* v8 ignore next 7 -- host refusal translation is the same typed boundary-unavailable path exercised by prepare failures */
                Effect.mapError((cause) =>
                  new SchedulerError({
                    code: "boundary_unavailable",
                    message: `the host could not expand ${what}`,
                    cause
                  })
                )
              )
              if (!present) continue
              const info = yield* fileSystem.value.stat(entry).pipe(
                /* v8 ignore next 7 -- host refusal translation is the same typed boundary-unavailable path exercised by prepare failures */
                Effect.mapError((cause) =>
                  new SchedulerError({
                    code: "boundary_unavailable",
                    message: `the host could not expand ${what}`,
                    cause
                  })
                )
              )
              // Exact writer declarations name files; directory outputs use
              // `TreeArtifact`, and only files are members of a read glob.
              if (info.type === "File") paths.add(entry)
              continue
            }
            const matches = FileSet.isGlob(entry)
              ? yield* FileEnumeration.expandGlob(fileSystem.value, entry).pipe(
                /* v8 ignore next 7 -- host refusal translation is the same typed boundary-unavailable path exercised by prepare failures */
                Effect.mapError((cause) =>
                  new SchedulerError({
                    code: "boundary_unavailable",
                    message: `the host could not expand ${what}`,
                    cause
                  })
                )
              )
              : yield* FileEnumeration.filesUnder(fileSystem.value, entry.path).pipe(
                /* v8 ignore next 7 -- host refusal translation is the same typed boundary-unavailable path exercised by prepare failures */
                Effect.mapError((cause) =>
                  new SchedulerError({
                    code: "boundary_unavailable",
                    message: `the host could not expand ${what}`,
                    cause
                  })
                )
              )
            for (const path of matches) {
              if (FileSet.matchesGlob(glob, path)) paths.add(path)
            }
          }
          return [...paths].filter((path) => writerFor(path) !== undefined).sort()
        })

      // A read declaration is observed only when its node enters this run:
      // generation zero here, or one newly appended generation below. Paths
      // already pinned by an earlier declaration reuse that digest; measuring
      // them again would tear the run. A new source path is measured now,
      // which is its first observation in this run.
      const pinned = new Map<string, string>()
      const observedReads = new Map<string, ReadonlyArray<ObservedRead>>()
      const observeReads = (nodes: ReadonlyArray<Plan.PlanNode>, what: string) =>
        Effect.gen(function*() {
          const unpinned = new Set<string>()
          for (const node of nodes) {
            const observed: Array<ObservedRead> = []
            for (const { entry, paths } of yield* expandReads(FileSet.expandReads(node.effects.reads), what)) {
              // Coverage is tested against each concrete path, never against
              // the declaration that happened to discover it. This is what
              // keeps a mixed source/producer glob from becoming all producer.
              const sourcePaths = paths.filter((path) => writerFor(path) === undefined)
              for (const path of sourcePaths) {
                if (!pinned.has(path)) unpinned.add(path)
              }
              observed.push({ entry, sourcePaths })
            }
            observedReads.set(node.id, observed)
          }
          if (unpinned.size === 0) return
          const prepared = yield* prepare([...unpinned], what)
          for (const entry of prepared.readSnapshot) pinned.set(entry.path, entry.digest)
        })

      // The world, observed once: expand every generation-zero read exactly
      // once, then pin every concrete path that no declared writer covers.
      // Source and producer membership are disjoint by construction.
      yield* observeReads(plan.nodes, "the plan's source inputs")

      const measure = (node: Plan.PlanNode) =>
        Effect.gen(function*() {
          const measured = new Map<string, string>()
          const produced = new Set<string>()
          const observed = observedReads.get(node.id)!
          for (const read of observed) {
            if (typeof read.entry === "string") {
              if (read.sourcePaths.length === 0) produced.add(read.entry)
              else measured.set(read.entry, pinned.get(read.entry)!)
              continue
            }
            for (const path of read.sourcePaths) measured.set(path, pinned.get(path)!)
            // A glob's source membership is frozen above. Dispatch may only
            // add paths derived from declared writer scopes: a mid-run file
            // that no writer covers is outside this run's observed world.
            for (const path of yield* expandProducedMatches(read.entry, `the inputs of ${node.id}`)) {
              produced.add(path)
            }
          }
          if (produced.size > 0) {
            // Produced paths are our own outputs, so measuring them once their
            // producer has settled is not re-observing the world.
            const prepared = yield* prepare([...produced], `the inputs of ${node.id}`)
            for (const entry of prepared.readSnapshot) measured.set(entry.path, entry.digest)
          }
          return {
            readSet: [...measured].sort(([left], [right]) => compareText(left, right)).map(([path, digest]) => ({
              path,
              digest
            })),
            writeSet: FileSet.expand(node.effects.writes),
            // Declared removals travel with the boundary: they are what makes
            // an absent declared output legitimate rather than a defect.
            ...(node.effects.removes === undefined ? {} : { removes: node.effects.removes }),
            boundaryMode: node.effects.boundaryMode
          } satisfies FileBoundary
        })

      /**
       * The key a dispatch is recorded under: the node's own declaration
       * folded with the CONTENT of everything it consumes — the digests the
       * host just measured for its files, and the digest of each upstream
       * node's settled output value.
       *
       * Not the plan key. That key folds every upstream key transitively, so
       * an edit anywhere upstream re-ran everything below it even when the
       * edited node's output value was byte-identical. Bazel's
       * `ActionCacheChecker` stops invalidation at unchanged content, and
       * `StepKey.dispatchIdentity` is how this does.
       *
       * The plan key alone could never have been it either: two runs whose
       * input files differ declare the same graph, and serving one the other's
       * result is exactly the staleness the boundary exists to prevent.
       */
      const dispatchKeyFor = (
        node: Plan.PlanNode,
        boundary: FileBoundary,
        settledResults: ReadonlyMap<string, unknown>
      ) =>
        StepKey.dispatchIdentity({
          material: node.material,
          results: Object.fromEntries(
            node.material.inputs.flatMap((input) =>
              input._tag === "Ref" ? [[input.from, settledResults.get(input.from)] as const] : []
            )
          ),
          digestMemo,
          environment: options.environment,
          hermetic: {
            ...boundary,
            readSet: StepBoundary.exactReads(boundary)
          }
        }).pipe(
          /* v8 ignore next 3 -- every plan node is sealed (`Plan.annotate` refuses otherwise), a dependent of unsettled work never dispatches, and settled outputs are already durably serialized, so none of the three failures is reachable from here; the branch exists because the derivation is honest about its error channel */
          Effect.mapError((cause) =>
            new SchedulerError({ code: "key_uncomputable", message: `could not key ${node.id}`, cause })
          )
        )

      const dependenciesOf = (node: Plan.PlanNode): ReadonlyArray<string> => [
        ...node.dependsOn,
        ...discovered.get(node.id) ?? []
      ]

      const runtimeStrategyOf = (node: Plan.PlanNode): Plan.RuntimeStrategy =>
        node.conflicts.some((conflict) => conflict.runtime === "stop-merge") ? "stop-merge" : node.runtime

      const markSettled = (node: Plan.PlanNode, outcome: Outcome): void => {
        const state = stateOf(node)
        state.status = "settled"
        state.outcome = outcome
      }

      const emitSettlement = (node: Plan.PlanNode) =>
        Effect.gen(function*() {
          const state = stateOf(node)
          yield* emit(JournalRecords.nodeSettled(source(`node/${node.id}/settled`), {
            planId: plan.planId,
            nodeId: node.id,
            planKey: node.key,
            dispatchKey: state.dispatchKey,
            outcome: state.outcome,
            attempts: state.attempts,
            rebases: state.rebases
          }))
          yield* Metric.update(EngineStoreMetrics.node[state.outcome], 1)
        })

      const settle = (node: Plan.PlanNode, outcome: Outcome) => {
        markSettled(node, outcome)
        return emitSettlement(node)
      }

      const applyVerdict = (nodeId: string, verdict: Reconciliation.Verdict, trigger: string) =>
        Effect.gen(function*() {
          verdicts.push({ nodeId, verdict })
          yield* emit(JournalRecords.nodeReconciled(source(`node/${nodeId}/reconciled/${verdicts.length}`), {
            planId: plan.planId,
            nodeId,
            trigger,
            verdict
          }))
          if (verdict._tag === "Fail") {
            // The scheduler chooses the node it asks about, so a verdict always
            // names one it is tracking.
            const state = states.get(nodeId)!
            state.status = "settled"
            state.outcome = "failed"
            results.delete(nodeId)
            return
          }
          if (verdict._tag === "Reorder") {
            // Re-plan with the discovered dependency made explicit. It binds
            // work that has not dispatched yet — the deviating node already
            // ran, and rewriting history is what append-only forbids.
            // Persisting the edge is the caller's next elaboration; the
            // verdict is journaled so it can be.
            for (const owner of verdict.dependsOn) {
              if (states.get(owner)?.status !== "pending") continue
              discovered.set(owner, [...new Set([...discovered.get(owner) ?? [], nodeId])])
            }
          }
          // `FactorOut` needs no graph surgery: two identical extracted steps
          // collapse to one key by themselves, so the second is a `clean`.
        })

      const dispatch: (
        node: Plan.PlanNode,
        start: DispatchStart
      ) => Effect.Effect<Dispatched, SchedulerError, Requirements> = Effect.fn(
        "PlanScheduler.dispatch"
      )(function*(node: Plan.PlanNode, start: DispatchStart) {
        return yield* Effect.gen(function*() {
          yield* Effect.annotateCurrentSpan({
            runId: options.runId,
            planId: plan.planId,
            nodeId: node.id,
            kind: node.kind,
            planKey: node.key
          })
          // Attempt bookkeeping is local to this fiber. The coordinator owns
          // the durable scheduler state and applies this progress only when it
          // processes the terminal event.
          let dispatchKey = start.dispatchKey
          let attempts = start.attempts
          let rebases = start.rebases
          while (true) {
            const boundary = yield* measure(node)
            const measuredKey = yield* dispatchKeyFor(node, boundary, start.results)
            if (dispatchKey !== "" && dispatchKey !== measuredKey) {
              yield* emit(JournalRecords.nodeInvalidated(source(`node/${node.id}/${attempts}/invalidated`), {
                planId: plan.planId,
                nodeId: node.id,
                planKey: node.key,
                from: dispatchKey,
                to: measuredKey,
                reason: "measured-inputs-changed"
              }))
            }
            dispatchKey = measuredKey
            attempts = attempts + 1
            yield* Effect.annotateCurrentSpan({ dispatchKey, attempt: attempts })
            yield* emit(JournalRecords.nodeScheduled(source(`node/${node.id}/${attempts}`), {
              planId: plan.planId,
              nodeId: node.id,
              kind: node.kind,
              planKey: node.key,
              dispatchKey,
              attempt: attempts,
              priority: node.priority,
              waited: start.waited
            }))
            const dispatchDigest = yield* Effect.orDie(digestOf(dispatchKey))
            yield* Queue.offer(events, { _tag: "AttemptKeyed", nodeId: node.id, digest: dispatchDigest })
            const ran = yield* Ref.make(false)
            const exit = yield* ActionPersistence.make({
              runId: options.runId,
              owner: options.owner,
              sourceId: `${options.sourceId}/node/${node.id}`,
              execute: () =>
                Ref.set(ran, true).pipe(
                  Effect.andThen(executor.execute({ node, attempt: attempts, boundary, inputs: start.inputs }))
                )
            })({
              action: {},
              attempt: attempts,
              key: dispatchKey,
              tier: "sealed",
              nondeterministic: node.material.nondeterministic,
              metadata: boundary
            }).pipe(
              Effect.exit
            )
            if (Exit.isSuccess(exit)) {
              return {
                outcome: (yield* Ref.get(ran)) ? "built" : "clean",
                result: exit.value,
                dispatchKey,
                attempts,
                rebases
              } as const
            }
            // Losing a fence self-interrupts `ActionPersistence`. An
            // interrupted dispatch is the run losing ownership, never a node
            // failure that the scheduler may report and continue past.
            if (Cause.hasInterrupts(exit.cause)) return yield* Effect.interrupt
            if (!isConflict(exit.cause)) return { outcome: "failed", dispatchKey, attempts, rebases } as const
            const strategy = runtimeStrategyOf(node)
            if (strategy === "delay-rebase" && rebases < rebaseLimit) {
              // Hold the dependents — they are not ready while this node is in
              // flight — and re-execute against the newly recorded base. The
              // next turn of the loop re-measures, which re-keys, which is a
              // new attempt rather than a retry of the old identity.
              rebases = rebases + 1
              continue
            }
            return { outcome: "conflicted", strategy, dispatchKey, attempts, rebases } as const
          }
        }).pipe(
          Effect.tap((result) => Effect.annotateCurrentSpan({ outcome: result.outcome }))
        )
      })

      /**
       * `stop-merge`: the losing action is stopped and both lanes are routed
       * through an explicit merge node appended to the SAME plan, as an
       * ordinary elaboration. `docs/specs/Concepts/Worktree Lanes.md`'s
       * restart-or-fail landing contract governs the merge critical section,
       * so the merge node carries no rebase budget of its own: it lands, or
       * the run has a failed node.
       */
      const appendMerge = (node: Plan.PlanNode) =>
        Effect.gen(function*() {
          const winners = node.conflicts.map((conflict) => conflict.with).filter((id) => results.has(id))
          const mergeId = `${node.id}+merge`
          const grown = yield* Plan.append(plan, [{
            id: mergeId,
            kind: "merge",
            material: {
              version: "flows/key-material/v2",
              kind: "sealed",
              body: { merge: { stopped: node.id, winners } },
              inputs: winners.map((id) => ({ _tag: "Pending" as const, from: id })),
              layers: [],
              capabilities: []
            },
            effects: node.effects
          }]).pipe(
            /* v8 ignore next 7 -- the merge id derives from a node id that appears once, its only dependencies are nodes that already produced results, and its write set is ordered behind them, so none of `Plan.append`'s four refusals is reachable */
            Effect.mapError((cause) =>
              new SchedulerError({
                code: "elaboration_failed",
                message: `could not append the merge node for ${node.id}`,
                cause
              })
            )
          )
          plan = grown
          // `appendMerge` copies the stopped node's effects byte-for-byte, so
          // re-indexing adds no new writer coverage and cannot turn an
          // already-pinned source path into a producer. The new generation's
          // read declarations have not themselves been observed, however:
          // expand them once now and pin only source paths this run has never
          // measured. Existing pins are always reused.
          indexWriters()
          yield* observeReads(Plan.generationNodes(grown), `generation ${grown.generation}'s source inputs`)
          appended.push(mergeId)
          yield* append(grown)
        })

      const pendingSettlements: Array<DispatchSettlementEvent> = []
      const registerAttempt = (event: Extract<CoordinatorEvent, { readonly _tag: "AttemptKeyed" }>) => {
        const dispatchedUnder = digestToNode.get(event.digest)
        if (dispatchedUnder === undefined) {
          digestToNode.set(event.digest, [event.nodeId])
        } else if (!dispatchedUnder.includes(event.nodeId)) {
          digestToNode.set(event.digest, [...dispatchedUnder, event.nodeId])
        }
      }
      /**
       * Absorbs every report already offered without processing another node's
       * settlement. Attempt-key reports update attribution state immediately;
       * terminal reports stay ordered in `pendingSettlements` for the one-at-a-
       * time coordinator. A deviation can appear in a journal page only after
       * its attempt-key report was offered, so calling this after each page
       * closes the journal/queue observation race without a shared mutable map.
       */
      const drainReportedEvents = Effect.gen(function*() {
        while (true) {
          const next = yield* Queue.poll(events)
          if (Option.isNone(next)) return
          if (next.value._tag === "AttemptKeyed") registerAttempt(next.value)
          else pendingSettlements.push(next.value)
        }
      })

      const nextSettlement = Effect.gen(function*() {
        const pending = pendingSettlements.shift()
        if (pending !== undefined) return pending
        while (true) {
          const event = yield* Queue.take(events)
          if (event._tag === "DispatchSettled") return event
          registerAttempt(event)
        }
      })

      /**
       * The first consumer `flows.engine.expected-set-deviation` has ever had.
       * The events are read from the journal rather than from the attempt row
       * on purpose: a deviation is a durable, replayable fact, and consuming
       * the fact keeps this seam usable by anything else that reads the
       * journal.
       *
       * Two properties the drain owes the reconciler, both of them about not
       * letting arrival order decide a verdict:
       *
       * 1. **Attribute the whole page before judging any of it.** Deviating on
       *    the same paths is a *symmetric* fact — two steps that both ran
       *    `npm install` — so registering each signature as the entry was
       *    judged answered the same situation two different ways: the first
       *    node saw no peer and was failed, and only the second was factored
       *    out. Every deviation on the page is attributed first, so both sides
       *    of a pair see each other.
       * 2. **Drain the journal, not one page of it.** Concurrent dispatches can
       *    journal more records than one page holds, and the final completion
       *    is the one that matters: nothing follows it to pick up what a single
       *    page left behind, so a deviation past the cursor would never reach
       *    the seam.
       */
      const pendingDeviations: Array<{
        readonly nodeId: string
        readonly signature: string
        readonly payload: typeof DeviationPayload.Type
      }> = []
      const drainDeviations = Effect.gen(function*() {
        let hasMore = true
        while (hasMore) {
          const page = yield* journal.entries({
            runId: options.runId as JournalEvent.RunId,
            ...(cursor === undefined ? {} : { after: cursor as JournalEvent.Seq }),
            limit: 512
          }).pipe(Effect.mapError(storeFailure("could not read the run's journal")))
          // Every deviation in this page causally follows its attempt-key
          // report. Absorb those reports now, after the journal read, so even
          // an in-flight sibling can be attributed without dispatch fibers
          // mutating coordinator state.
          yield* drainReportedEvents
          const attributed: Array<{ nodeId: string; signature: string; payload: typeof DeviationPayload.Type }> = []
          for (const entry of page.entries) {
            cursor = entry.seq
            if (entry.eventType !== "flows.engine.expected-set-deviation") continue
            const payload = decodeDeviation(entry.payload)
            if (Option.isNone(payload)) continue
            const nodeIds = digestToNode.get(payload.value.stepKeyDigest)
            if (nodeIds === undefined) continue
            // The attempt belongs to an executing node by construction. If
            // its built settlement is absent from current bookkeeping — the
            // record arrived first, or is being durably replayed into an
            // all-clean invocation — preserve first dispatch order.
            const nodeId = nodeIds.find((candidate) => states.get(candidate)!.outcome === "built") ?? nodeIds[0]!
            const signature = JSON.stringify([
              "expected-set-deviation/v1",
              [...new Set(payload.value.paths)].sort(compareText)
            ])
            deviationSignatures.set(nodeId, signature)
            attributed.push({ nodeId, signature, payload: payload.value })
          }
          pendingDeviations.push(...attributed)
          for (let index = 0; index < pendingDeviations.length;) {
            const { nodeId, payload, signature } = pendingDeviations[index]!
            // A concurrent dispatch can durably journal its deviation before
            // its terminal event reaches the head of the coordinator queue.
            // Its signature participates in symmetric attribution now, but
            // its verdict waits until that node's settlement is processed.
            if (states.get(nodeId)?.status !== "settled") {
              index = index + 1
              continue
            }
            const alsoDeviatedBy = [...deviationSignatures.entries()]
              .filter(([other, otherSignature]) => other !== nodeId && otherSignature === signature)
              .map(([other]) => other)
            const declaredBy = Object.fromEntries(
              payload.paths.flatMap((path) => {
                const owner = writerFor(path)
                return owner === undefined ? [] : [[path, owner] as const]
              })
            )
            const verdict = yield* reconciler.onDeviation({
              nodeId,
              keyDigest: payload.stepKeyDigest,
              attempt: payload.attempt,
              paths: payload.paths,
              diffIdentity: payload.diffIdentity,
              declaredBy,
              alsoDeviatedBy
            })
            yield* applyVerdict(nodeId, verdict, "deviation")
            pendingDeviations.splice(index, 1)
          }
          hasMore = page.hasMore
        }
      })

      /**
       * The selection consult, once per run, against the initial plan and the
       * pinned belief snapshot (`docs/specs/Concepts/Probabilistic
       * Selection.md`). Only sinks — nodes nothing in the plan depends on —
       * are offered, because deferring a node something consumes would block
       * or corrupt its consumers. A verdict may postpone or propose, never
       * remove: `Admit` is a no-op, a `Defer` marks the sink for the loop
       * below, a `Propose` is journaled and nothing more (v1 never
       * auto-appends), and a Defer naming a non-sink — or a Propose naming
       * anything the plan already accounts for, its flow included — is
       * ignored and journaled as an inconsistency observation, against the
       * same `present` set the layer was shown. The `full` override skips
       * the consult entirely: nothing is deferred and nothing is proposed
       * under it, and the override record is what makes that visible.
       * Elaboration cannot
       * invalidate the marks: an appended merge node depends only on nodes
       * that produced results, and a deferred node never executes, so a
       * deferred sink can never gain a dependent mid-run.
       */
      const deferrals = new Map<string, { edge: Selection.SuspectedEdge; likelihood: number }>()
      if (options.selection?.full === true) {
        yield* emit(JournalRecords.selectionOverridden(source("selection/override"), {
          planId: plan.planId,
          mode: "full"
        }))
      } else {
        const dependedOn = new Set(plan.nodes.flatMap((node) => node.dependsOn))
        const sinks = plan.nodes.filter((node) => !dependedOn.has(node.id))
        const present = new Set([plan.flow, ...plan.nodes.map((node) => node.id)])
        const sinkIds = new Set(sinks.map((node) => node.id))
        const selected = yield* selector.select({
          changed: options.selection?.changed ?? [],
          sinks: sinks.map((node) => ({ nodeId: node.id, planKey: node.key })),
          present: [...present],
          beliefs: options.selection?.beliefs ?? { pinnedAtMs: 0, edges: [] },
          policy: options.selection?.policy ?? { deferBelow: 0 }
        })
        for (let index = 0; index < selected.length; index++) {
          const { nodeId, verdict } = selected[index]!
          if (verdict._tag === "Admit") continue
          if (verdict._tag === "Defer" && sinkIds.has(nodeId)) {
            deferrals.set(nodeId, { edge: verdict.edge, likelihood: verdict.likelihood })
            continue
          }
          if (verdict._tag === "Propose" && !present.has(nodeId)) {
            yield* emit(JournalRecords.selectionProposed(source(`selection/proposed/${index}`), {
              planId: plan.planId,
              flow: verdict.flow,
              edge: verdict.edge,
              confidence: verdict.confidence
            }))
            continue
          }
          yield* emit(JournalRecords.selectionInconsistent(source(`selection/inconsistent/${index}`), {
            planId: plan.planId,
            nodeId,
            verdict: verdict._tag,
            reason: verdict._tag === "Defer" ? "not-a-deferrable-sink" : "proposes-a-present-node"
          }))
        }
      }

      // Fail closed: a dependent never dispatches against an upstream with
      // any of these outcomes. `deferred` is listed defensively — only sinks
      // are deferrable today, so no dependent can observe it — to keep a
      // future non-sink deferral from reaching dispatch with a missing
      // upstream result.
      const blockingOutcomes = new Set(["failed", "skipped", "deferred"])
      const passiveSettlements = Effect.gen(function*() {
        while (true) {
          const pending = plan.nodes.filter((node) => stateOf(node).status === "pending")
          const blocked: Array<Plan.PlanNode> = []
          const ready: Array<Plan.PlanNode> = []
          for (const node of pending) {
            const dependencies = dependenciesOf(node).map((id) => states.get(id))
            if (dependencies.some((state) => state === undefined || state.status !== "settled")) continue
            if (dependencies.some((state) => blockingOutcomes.has(state!.outcome))) {
              blocked.push(node)
              continue
            }
            ready.push(node)
          }
          // Halt, not continue-on-failure: a dependent of failed work never
          // dispatches. Repeating this pass makes the skip cascade settle in
          // dependency order before any newly exposed work is admitted.
          for (const node of blocked) yield* settle(node, "skipped")
          if (blocked.length > 0) continue
          // A deferral is a postponement, never a removal, and it only takes
          // effect on work that was genuinely runnable: a marked sink whose
          // cone failed settled `skipped` above instead, because work that
          // could not have run is not a debt. The debt record precedes the
          // settlement so `Selection.debt` reads them in cause-then-effect
          // order.
          const postponed = ready.filter((node) => deferrals.has(node.id))
          for (const node of postponed) {
            const debt = deferrals.get(node.id)!
            yield* emit(JournalRecords.selectionDeferred(source(`node/${node.id}/selection-deferred`), {
              planId: plan.planId,
              nodeId: node.id,
              planKey: node.key,
              edge: debt.edge,
              likelihood: debt.likelihood
            }))
            yield* settle(node, "deferred")
          }
          if (postponed.length > 0) continue
          return ready
        }
      })

      const dispatchStart = (node: Plan.PlanNode): DispatchStart => {
        const state = stateOf(node)
        const settledResults = new Map<string, unknown>()
        const inputs: Array<ResolvedInput> = []
        for (const input of node.material.inputs) {
          if (input._tag !== "Ref") continue
          const value = results.get(input.from)
          settledResults.set(input.from, value)
          // Admission proved every dependency settled successfully; `settle`
          // records even an `undefined` result in the map, so every material
          // Ref has a value to project here.
          inputs.push({ from: input.from, path: input.path, value: StepKey.project(value, input.path) })
        }
        return {
          dispatchKey: state.dispatchKey,
          attempts: state.attempts,
          rebases: state.rebases,
          waited: state.waited,
          results: settledResults,
          inputs
        }
      }

      let admissions = 0
      yield* Effect.scoped(Effect.gen(function*() {
        let inFlightSteps = 0
        let inFlightAgents = 0
        const pendingMerges: Array<{
          readonly node: Plan.PlanNode
          readonly peers: ReadonlyArray<string>
        }> = []

        const appendReadyMerges = Effect.gen(function*() {
          for (let index = 0; index < pendingMerges.length;) {
            const pending = pendingMerges[index]!
            if (pending.peers.some((peer) => states.get(peer)?.status === "running")) {
              index = index + 1
              continue
            }
            yield* appendMerge(pending.node)
            pendingMerges.splice(index, 1)
          }
        })

        const admit = (ready: ReadonlyArray<Plan.PlanNode>) =>
          Effect.gen(function*() {
            const order = new Map(plan.nodes.map((node, index) => [node.id, index]))
            const admitted: Array<Plan.PlanNode> = []
            let admittedAgents = 0
            const contenders = [...ready].sort((left, right) => {
              const delta = (right.priority + stateOf(right).waited) - (left.priority + stateOf(left).waited)
              return delta === 0 ? order.get(left.id)! - order.get(right.id)! : delta
            })
            for (const node of contenders) {
              const isAgent = node.kind === "agent"
              if (
                inFlightSteps + admitted.length >= stepCap ||
                (isAgent && inFlightAgents + admittedAgents >= agentCap)
              ) continue
              if (isAgent) admittedAgents = admittedAgents + 1
              admitted.push(node)
            }
            // Event-driven aging: this admission pass considered every ready
            // node, and only capacity can leave one behind.
            for (const node of ready) {
              if (!admitted.includes(node)) stateOf(node).waited = stateOf(node).waited + 1
            }
            if (admitted.length > 0) {
              admissions = admissions + 1
              yield* Effect.annotateCurrentSpan({ admissions })
              yield* Metric.update(EngineStoreMetrics.schedulerAdmissions, 1)
              yield* Effect.logDebug("scheduler admission launched", {
                admission: admissions,
                ready: ready.length,
                admitted: admitted.length,
                agents: admittedAgents,
                inFlightSteps,
                inFlightAgents
              })
            }
            const launches = admitted.map((node) => {
              const state = stateOf(node)
              const start = dispatchStart(node)
              state.status = "running"
              inFlightSteps = inFlightSteps + 1
              if (node.kind === "agent") inFlightAgents = inFlightAgents + 1
              return { node, start }
            })
            for (const { node, start } of launches) {
              yield* dispatch(node, start).pipe(
                Effect.trackDuration(EngineStoreMetrics.schedulerDispatchDuration),
                Effect.exit,
                Effect.flatMap((exit) => Queue.offer(events, { _tag: "DispatchSettled", node, exit })),
                Effect.asVoid,
                Effect.forkScoped({ startImmediately: true })
              )
            }
          })

        yield* Effect.flatMap(passiveSettlements, admit)
        while (plan.nodes.some((node) => stateOf(node).status !== "settled")) {
          /* v8 ignore next -- compiled plans are acyclic, inferred edges refuse cycle closure, and discovered edges point only from undispatched nodes to the already-settled node whose verdict added them; pending work with no in-flight producer therefore cannot have an empty ready set */
          if (inFlightSteps === 0) break
          const event = yield* nextSettlement
          if (Exit.isFailure(event.exit)) return yield* Effect.failCause(event.exit.cause)

          const node = event.node
          const result = event.exit.value
          const state = stateOf(node)
          inFlightSteps = inFlightSteps - 1
          if (node.kind === "agent") inFlightAgents = inFlightAgents - 1
          state.dispatchKey = result.dispatchKey
          state.attempts = result.attempts
          state.rebases = result.rebases

          switch (result.outcome) {
            case "built":
            case "clean":
              results.set(node.id, result.result)
              markSettled(node, result.outcome)
              break
            case "failed":
              markSettled(node, "failed")
              break
            case "conflicted": {
              if (result.strategy === "stop-merge") {
                markSettled(node, "skipped")
                // The former dispatch barrier guaranteed that every
                // conflicting sibling admitted beside this node had reported
                // its result before `appendMerge` selected winners. Preserve
                // that semantic boundary only for those already-running
                // peers; unrelated work never holds the merge cone.
                pendingMerges.push({
                  node,
                  peers: node.conflicts
                    .map((conflict) => conflict.with)
                    .filter((peer) => states.get(peer)?.status === "running")
                })
                break
              }
              const verdict = yield* reconciler.onConflict({
                nodeId: node.id,
                keyDigest: state.dispatchKey,
                attempt: state.attempts,
                rebases: state.rebases,
                strategy: result.strategy,
                conflictsWith: node.conflicts.map((conflict) => conflict.with)
              })
              markSettled(node, "failed")
              yield* applyVerdict(node.id, verdict, "materialization-conflict")
              break
            }
          }

          yield* appendReadyMerges

          // The dispatch durably journalled every deviation before its event.
          // Apply those verdicts before consulting downstream readiness.
          yield* drainDeviations
          // A dispatch outcome is provisional until its deviations have been
          // reconciled. Persist exactly one terminal fact, after a Fail
          // verdict has had the chance to replace built with failed.
          yield* emitSettlement(node)
          // Process terminal events already observed by the journal drain
          // before opening more permits. This preserves fail-fast behavior for
          // an already-failed sibling while still admitting immediately when
          // unrelated work is genuinely still in flight.
          const ready = yield* passiveSettlements
          if (pendingSettlements.length === 0) yield* admit(ready)
        }
      }))

      const settlements = plan.nodes.map((node) => {
        const state = stateOf(node)
        return {
          nodeId: node.id,
          planKey: node.key,
          dispatchKey: state.dispatchKey,
          outcome: state.outcome,
          attempts: state.attempts,
          rebases: state.rebases
        }
      })
      yield* Effect.logDebug("scheduler run completed", {
        admissions,
        built: settlements.filter((settlement) => settlement.outcome === "built").length,
        clean: settlements.filter((settlement) => settlement.outcome === "clean").length,
        failed: settlements.filter((settlement) => settlement.outcome === "failed").length,
        skipped: settlements.filter((settlement) => settlement.outcome === "skipped").length,
        deferred: settlements.filter((settlement) => settlement.outcome === "deferred").length
      })
      return {
        planId: plan.planId,
        digest: plan.digest,
        settlements,
        results: Object.fromEntries(results),
        verdicts,
        appended
      }
    }).pipe(
      Effect.annotateSpans({ runId: options.runId, planId: initial.planId }),
      Effect.annotateLogs({ runId: options.runId, planId: initial.planId }),
      Effect.onExit((exit) => Effect.annotateCurrentSpan({ outcome: EngineStoreMetrics.exitTag(exit).toLowerCase() }))
    )
  )

  return { record, append, run }
}

/**
 * Provides a scheduler bound to one run.
 *
 * @since 0.1.0
 * @category layers
 * @slop
 */
export const layer = (options: Options): Layer.Layer<PlanScheduler> => Layer.succeed(PlanScheduler, make(options))

/**
 * What {@link recertify} returns: the repaying run's id, its report, and the
 * deferring run's remaining debt after the repayment is counted.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface RecertifyResult {
  readonly runId: string
  readonly report: Report
  readonly remaining: ReadonlyArray<Selection.DebtEntry>
}

/**
 * The recertification driver: re-drives a compiled plan under a fresh,
 * caller-supplied run with the `full` selection override — guess-free by
 * construction — then reports the deferring run's remaining debt via
 * `Selection.debt(deferringRunId, { repaidBy: [options.runId] })`.
 *
 * The design draft placed this beside the other Selection helpers; it lives
 * here because it constructs a scheduler, and `Selection` must stay
 * type-only toward this module to keep the dependency graph acyclic. The
 * deferring run's journal is never written — repayment is a read-side join.
 * Scheduling the cadence (nightly, per-merge) stays a product concern; this
 * is only the primitive one pass runs.
 *
 * @since 0.1.0
 * @category combinators
 * @slop
 */
export const recertify = Effect.fn("PlanScheduler.recertify")(
  (input: {
    readonly plan: Plan.Plan
    readonly deferringRunId: string
    readonly options: Options
  }) =>
    Effect.gen(function*() {
      const scheduler = make({
        ...input.options,
        selection: { ...input.options.selection, full: true }
      })
      const report = yield* scheduler.run(input.plan)
      const remaining = yield* Selection.debt(input.deferringRunId, { repaidBy: [input.options.runId] })
      return { runId: input.options.runId, report, remaining } satisfies RecertifyResult
    })
)
