/**
 * Durable deferred-completion and clock-deadline state used by the flow
 * engine adapter.
 *
 * The waiting-reason taxonomy (one `waiting` status plus
 * `reason`/`wakeAt`/`token` columns) is specified by
 * [[Run Ownership]] (`docs/specs/Concepts/Run Ownership.md`) and recorded in
 * [[Engine Hardening Round 1]]
 * (`docs/specs/Concepts/Engine Hardening Round 1.md`), section 5.
 *
 * @since 0.1.0
 */
import { DatabaseError, DurableWriter } from "@smthrs/database/DurableWriter"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as EngineStateSchema from "./internal/EngineStateSchema.ts"

/** JSON text carrying an arbitrary decoded value. */
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown)

/** @private */
const NonNegativeSafeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * The durable address of a deferred result.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const DeferredAddress = Schema.Struct({
  flowName: Schema.NonEmptyString,
  executionId: Schema.NonEmptyString,
  deferredName: Schema.NonEmptyString
})

/**
 * The durable address of a deferred result.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type DeferredAddress = typeof DeferredAddress.Type

/**
 * The first durable completion recorded for a deferred.
 *
 * Correlation data remains opaque at this boundary. A future external-event
 * layer owns its schema and authorization policy.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const DeferredRow = Schema.Struct({
  ...DeferredAddress.fields,
  exit: Schema.Unknown,
  metadata: Schema.optionalKey(Schema.Unknown),
  completedAtMs: NonNegativeSafeInt
})

/**
 * The first durable completion recorded for a deferred.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type DeferredRow = typeof DeferredRow.Type

/**
 * Result of a first-writer-wins deferred completion.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type CompleteDeferredOutcome =
  | { readonly _tag: "Completed"; readonly row: DeferredRow }
  | { readonly _tag: "Existing"; readonly row: DeferredRow }

/**
 * The durable address of a clock.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const ClockAddress = Schema.Struct({
  flowName: Schema.NonEmptyString,
  executionId: Schema.NonEmptyString,
  clockName: Schema.NonEmptyString
})

/**
 * The durable address of a clock.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ClockAddress = typeof ClockAddress.Type

/**
 * A durable absolute clock deadline.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const ClockRow = Schema.Struct({
  ...ClockAddress.fields,
  deferredName: Schema.NonEmptyString,
  dueAtMs: NonNegativeSafeInt,
  completedAtMs: Schema.NullOr(NonNegativeSafeInt)
})

/**
 * A durable absolute clock deadline.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ClockRow = typeof ClockRow.Type

/**
 * Result of scheduling a durable clock.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type ScheduleClockOutcome =
  | { readonly _tag: "Scheduled"; readonly row: ClockRow }
  | { readonly _tag: "Existing"; readonly row: ClockRow }

/**
 * Result of completing a durable clock.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type CompleteClockOutcome =
  | { readonly _tag: "Completed"; readonly row: ClockRow }
  | { readonly _tag: "AlreadyCompleted"; readonly row: ClockRow }
  | { readonly _tag: "NotFound" }

/**
 * The core wait-reason vocabulary a supervisor understands for wake policy.
 *
 * - `approval` — parked until a human (or policy) approves; woken by token.
 * - `event` — parked on an external event / deferred completion.
 * - `timer` — parked until `wakeAt`; woken by the durable clock sweep.
 * - `quota` — parked on provider quota; woken at `wakeAt` when known.
 * - `released` — the owning process released the run without settling it
 *   (shutdown, heartbeat self-interrupt; issue #39). A released row has no
 *   held lease and no `wakeAt`: any supervisor/sweeper MUST scan for this
 *   reason explicitly and re-drive the run through the claim path, or
 *   released runs are stranded forever (issue #67).
 * - `quarantine` — parked because a SUCCEEDED attempt row's recorded
 *   evidence measured corrupt under the strict verdict (issue #171). The
 *   row cannot be evicted/re-executed like a cache row (its side effects
 *   already ran), so the corrupt boundary evidence is quarantined off the
 *   row while its durable outcome stays intact. No sweeper auto-wakes this
 *   reason: the strict integrity verdict remains visible until an explicit
 *   resume, which completes from the recorded outcome without re-execution.
 *
 * Left open (`string & {}`) so a plugin can park on a reason the core
 * taxonomy has not named yet — the store persists whatever it is given
 * rather than rejecting unknown reasons.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const WaitingReason = Schema.NonEmptyString

/**
 * The open wait-reason vocabulary.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type WaitingReason = typeof WaitingReason.Type

/**
 * The payload recorded when a run parks.
 *
 * `reason` and `wakeAt` earn columns because a supervisor sweeper queries
 * them (`WHERE waiting_reason = 'quota' AND waiting_wake_at_ms <= ?`);
 * `token` is compare-and-swap/lookup material a wake handler matches
 * against.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const Waiting = Schema.Struct({
  reason: WaitingReason,
  wakeAt: Schema.optional(NonNegativeSafeInt),
  token: Schema.optional(Schema.NonEmptyString)
})

/**
 * The payload recorded when a run parks.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Waiting = typeof Waiting.Type

/**
 * A decoded waiting row for a parked run.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const WaitingRow = Schema.Struct({
  runId: Schema.NonEmptyString,
  reason: WaitingReason,
  wakeAt: Schema.NullOr(NonNegativeSafeInt),
  token: Schema.NullOr(Schema.NonEmptyString)
})

/**
 * A decoded waiting row for a parked run.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type WaitingRow = typeof WaitingRow.Type

/**
 * A predicate over `waitingRuns` — omitted fields are unconstrained.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface WaitingRunsFilter {
  readonly reason?: string
  readonly dueBeforeMs?: number
  /**
   * When `true`, only parked runs whose cancellation was durably requested
   * (`flows_runs.cancel_requested_at_ms IS NOT NULL`). Lets the parked-run
   * sweep fetch actionable rows instead of scanning every parked run and
   * probing each with a `store.get` (issue #68). The in-memory
   * implementation reads the flag from the `runs` view
   * (`MemoryRunView.cancelRequestedAtMs`); without a view it stays
   * permissive and the sweeper's own per-row guard decides.
   */
  readonly cancelRequested?: boolean
}

/**
 * Result of recording that a run parked on a waiting reason.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type ParkOutcome =
  | { readonly _tag: "Parked"; readonly row: WaitingRow }
  | { readonly _tag: "NotFound" }

/**
 * Result of clearing a run's waiting payload on wake.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type WakeOutcome =
  | { readonly _tag: "Woken"; readonly row: WaitingRow }
  | { readonly _tag: "NotWaiting" }
  | { readonly _tag: "NotFound" }

/**
 * A durable parent edge in the run DAG.
 *
 * The run row's `state_json` carries only the first (creating) parent; a
 * diamond gives a run a second parent the row cannot express. Cycle
 * detection must see every edge from every owner process and across
 * restarts (issues #40/#41), so edges are persisted here. `seq` is a
 * store-global insertion order used only to list a run's parents oldest
 * first (and to make the cycle walk deterministic); it no longer arbitrates
 * anything, so duplicate values would be harmless (issues #54/#66).
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const RunParentEdge = Schema.Struct({
  childId: Schema.NonEmptyString,
  parentId: Schema.NonEmptyString,
  seq: NonNegativeSafeInt
})

/**
 * A durable parent edge in the run DAG.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type RunParentEdge = typeof RunParentEdge.Type

/**
 * The surviving attempt rows of one action key: the earliest surviving
 * row's start time and the highest attempt number contiguous from it.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export const AttemptSurvivors = Schema.Struct({
  /**
   * The lowest surviving attempt number. Anything above 1 means the prune
   * job removed a leading run of attempts; the engine store applies the
   * pruned-prefix tolerance to it so both survivor paths agree (issue #96).
   */
  earliestAttempt: NonNegativeSafeInt,
  earliestStartedAtMs: NonNegativeSafeInt,
  latest: NonNegativeSafeInt
})

/**
 * The surviving attempt range of one action key.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type AttemptSurvivors = typeof AttemptSurvivors.Type

/**
 * Recording a parent edge would close a cycle in the run DAG.
 *
 * Raised from inside the same transaction that inserted the edge, which is
 * rolled back: a rejected edge leaves no durable trace anywhere (issues
 * #54/#55/#56). `path` lists execution ids from the child back to itself
 * through its would-be ancestors, matching the engine's
 * `FlowCycleDetected.path` shape.
 *
 * @since 0.1.0
 * @category errors
 * @slop
 */
export class RunParentCycleError extends Schema.TaggedError<RunParentCycleError>()(
  "@smthrs/engine-store/RunParentCycleError",
  {
    path: Schema.Array(Schema.String)
  }
) {}

/**
 * Result of recording a durable parent edge (idempotent).
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type RecordRunParentOutcome =
  | { readonly _tag: "Recorded"; readonly edge: RunParentEdge }
  | { readonly _tag: "Existing"; readonly edge: RunParentEdge }

/**
 * Minimal durable state missing from the current `@smthrs/journal` contract.
 *
 * A successful mutation means the row is durable. Callers may therefore
 * journal and schedule a wake only after the mutation returns.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Service {
  // TODO(piece-6): fold into @smthrs/journal — needs DeferredStore.get(flowName, executionId, deferredName).
  readonly deferred: (address: DeferredAddress) => Effect.Effect<Option.Option<DeferredRow>>
  // TODO(piece-6): fold into @smthrs/journal — needs DeferredStore.completeFirstWriterWins(row).
  readonly completeDeferred: (row: DeferredRow) => Effect.Effect<CompleteDeferredOutcome>
  // TODO(piece-6): fold into @smthrs/journal — needs ClockStore.get(flowName, executionId, clockName).
  readonly clock: (address: ClockAddress) => Effect.Effect<Option.Option<ClockRow>>
  // TODO(piece-6): fold into @smthrs/journal — needs ClockStore.scheduleFirstWriterWins(rowWithAbsoluteDueAtMs).
  readonly scheduleClock: (row: ClockRow, owner?: OwnerId) => Effect.Effect<ScheduleClockOutcome>
  // TODO(piece-6): fold into @smthrs/journal — needs ClockStore.completeOnce(address, completedAtMs).
  readonly completeClock: (
    address: ClockAddress,
    completedAtMs: number
  ) => Effect.Effect<CompleteClockOutcome>
  // TODO(piece-6): fold into @smthrs/journal — needs ClockStore.due(nowMs).
  readonly dueClocks: (nowMs: number) => Effect.Effect<ReadonlyArray<ClockRow>>
  /**
   * Lists uncompleted clock rows scoped to an execution or flow, with no
   * due-time bound. Suspension-reason derivation and registration-time
   * recovery use this instead of abusing `dueClocks` as an all-clocks
   * listing (issue #35): `dueClocks` is a due-timer sweeper query and may
   * grow a result cap without affecting park correctness.
   */
  readonly pendingClocks: (scope: {
    readonly executionId?: string
    readonly flowName?: string
  }) => Effect.Effect<ReadonlyArray<ClockRow>>
  /**
   * Lists completed deferred addresses for registration-time wake recovery.
   */
  readonly completedDeferreds: (
    flowName: string
  ) => Effect.Effect<ReadonlyArray<DeferredAddress>>
  /**
   * Records the waiting-reason payload for a parked run, fenced to the
   * current owner so a stale process cannot park a run it no longer runs.
   */
  readonly park: (
    runId: string,
    waiting: Waiting,
    owner: OwnerId
  ) => Effect.Effect<ParkOutcome>
  /**
   * Clears a run's waiting payload on wake or resume. Idempotent: waking a
   * run that is not waiting reports `NotWaiting` rather than failing.
   */
  readonly wake: (runId: string) => Effect.Effect<WakeOutcome>
  /**
   * Reads the current waiting payload for a run, if any.
   */
  readonly waiting: (runId: string) => Effect.Effect<Option.Option<WaitingRow>>
  /**
   * Lists parked runs matching an optional reason/due-before filter, ordered
   * for sweeper consumption (earliest wake first).
   */
  readonly waitingRuns: (
    filter?: WaitingRunsFilter
  ) => Effect.Effect<ReadonlyArray<WaitingRow>>
  /**
   * Lists run ids whose row is `running` with a heartbeat strictly older
   * than `staleBeforeMs` — an owner that stopped heartbeating without
   * releasing the run (SIGKILL, OOM, power loss). Nothing else ever
   * revisits such a run: it has no waiting row for the parked-run sweep,
   * no pending clock, and no future deferred completion. A periodic
   * sweeper re-drives these through the ordinary claim/steal path — the
   * analog of Temporal's task-timeout re-dispatch (issue #53).
   *
   * `limit` caps one enumeration (issue #79): the rows come back oldest
   * heartbeat first, so a capped sweep drains a mass owner death across
   * ticks instead of waking every stale run in every driver every tick.
   */
  readonly staleRunningRuns: (
    staleBeforeMs: number,
    limit?: number | undefined
  ) => Effect.Effect<ReadonlyArray<string>>
  /**
   * The surviving attempt rows for an action key, in one range read: the
   * earliest surviving row's start time (the durable retry origin when
   * attempt 1 itself was pruned, issue #69) and the highest attempt number
   * contiguous from it (the resumed attempt counter, issue #59).
   * `Option.none()` means no attempt row survives.
   *
   * Optional because only storage that can range-scan `flows_attempts`
   * implements it; when absent the engine store falls back to per-attempt
   * point reads against `AttemptStore` (issue #77).
   */
  readonly attemptSurvivors?:
    | ((
      runId: string,
      stepKeyDigest: string
    ) => Effect.Effect<Option.Option<AttemptSurvivors>>)
    | undefined
  /**
   * Durably records a parent edge in the run DAG, first-writer-wins per
   * `(child, parent)` pair.
   *
   * The cycle check happens inside the same transaction as the insert: the
   * edge is inserted, the child's ancestor chain is walked over the durable
   * edges, and on a hit the transaction rolls back and the call fails with
   * `RunParentCycleError`. There is no window between insert and check, no
   * arbitration, and no withdrawal protocol — concurrent writers that
   * jointly close a cycle serialize on the write transaction and exactly
   * one of them fails (issues #29/#40/#54/#55/#56).
   */
  readonly recordRunParent: (
    childId: string,
    parentId: string
  ) => Effect.Effect<RecordRunParentOutcome, RunParentCycleError>
  /**
   * Removes every parent edge touching a run — both the edges naming it as
   * child and the edges naming it as parent. The cleanup half of run
   * deletion (issue #66): a lane that deletes run rows (time-travel,
   * retention) must call this so `runParents` and the cycle walk stop
   * seeing edges of runs that no longer exist.
   */
  readonly removeRunParentsForRun: (runId: string) => Effect.Effect<void>
  /**
   * Lists the durably recorded parent edges of a run, oldest first.
   */
  readonly runParents: (childId: string) => Effect.Effect<ReadonlyArray<RunParentEdge>>
  /**
   * Lists the durably recorded child edges of a run, oldest first.
   *
   * The reverse direction of `runParents`, and the only instance-independent
   * way to find the runs a cancelled parent linked to itself. Cancellation
   * cascade reads it rather than an in-process instance map, so a
   * cross-process cancel observed by a driver that never spawned the children
   * still reaches them (`docs/specs/Concepts/Subflows.md`). Served by the
   * `flows_run_parents_parent_idx` index.
   */
  readonly runChildren: (parentId: string) => Effect.Effect<ReadonlyArray<RunParentEdge>>
  /**
   * Runs `effect` inside one storage write transaction, so a caller can make
   * several store operations atomic — the run driver wraps the parent-edge
   * record and the run-row creation it guards, closing the crash window that
   * left a durable orphan edge for a run that was never created (issue #80).
   * Nested store writes become savepoints of this transaction. Storage
   * failures are defects, matching the store methods' own posture.
   *
   * The in-memory twin runs the effect directly: it has no crash windows to
   * close and therefore nothing to roll back.
   */
  readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/**
 * Service tag for durable deferred completions and absolute clock deadlines.
 *
 * @since 0.1.0
 * @category services
 * @slop
 */
export class DurableEngineState extends Context.Service<DurableEngineState, Service>()(
  "@smthrs/engine-store/DurableEngineState"
) {}

/** @private */
const deferredKey = (address: DeferredAddress): string =>
  JSON.stringify([address.flowName, address.executionId, address.deferredName])

/** @private */
const clockKey = (address: ClockAddress): string =>
  JSON.stringify([address.flowName, address.executionId, address.clockName])

/** @private */
const DeferredDatabaseRow = Schema.Struct({
  ...DeferredAddress.fields,
  exitJson: Schema.String,
  metadataJson: Schema.NullOr(Schema.String),
  completedAtMs: NonNegativeSafeInt
})

type DeferredDatabaseRow = typeof DeferredDatabaseRow.Type

/** @private */
const ClockDatabaseRow = Schema.Struct({
  ...ClockAddress.fields,
  deferredName: Schema.NonEmptyString,
  dueAtMs: NonNegativeSafeInt,
  completedAtMs: Schema.NullOr(NonNegativeSafeInt)
})

type ClockDatabaseRow = typeof ClockDatabaseRow.Type

/** @private */
const WaitingDatabaseRow = Schema.Struct({
  runId: Schema.NonEmptyString,
  waitingReason: WaitingReason,
  waitingWakeAtMs: Schema.NullOr(NonNegativeSafeInt),
  waitingToken: Schema.NullOr(Schema.NonEmptyString)
})

type WaitingDatabaseRow = typeof WaitingDatabaseRow.Type

const decodeWaitingRow = (input: unknown): Effect.Effect<WaitingRow> =>
  Schema.decodeUnknownEffect(WaitingDatabaseRow)(input).pipe(
    Effect.orDie,
    Effect.map((row) => ({
      runId: row.runId,
      reason: row.waitingReason,
      wakeAt: row.waitingWakeAtMs,
      token: row.waitingToken
    }))
  )

/** @private */
const RunParentDatabaseRow = Schema.Struct({
  childId: Schema.NonEmptyString,
  parentId: Schema.NonEmptyString,
  seq: NonNegativeSafeInt
})

type RunParentDatabaseRow = typeof RunParentDatabaseRow.Type

const decodeRunParentEdge = (input: unknown): Effect.Effect<RunParentEdge> =>
  Schema.decodeUnknownEffect(RunParentDatabaseRow)(input).pipe(Effect.orDie)

/**
 * Walks the parent chain upward from `parentId` over the durable edges,
 * looking for `childId`. Returns the cycle path the new `(childId,
 * parentId)` edge would close — ids from the child back to itself, matching
 * the engine's `FlowCycleDetected.path` shape — or `undefined` when the
 * edge is safe. A repeated id (pre-existing corrupt cycle written outside
 * this API) terminates that branch instead of looping forever.
 */
const findCyclePath = (
  childId: string,
  parentId: string,
  parentsOf: (id: string) => Effect.Effect<ReadonlyArray<string>>
): Effect.Effect<ReadonlyArray<string> | undefined> =>
  Effect.suspend(() => {
    if (parentId === childId) {
      return Effect.succeed<ReadonlyArray<string> | undefined>([childId])
    }
    const seen = new Set<string>([parentId])
    const walk = (
      current: string,
      chain: ReadonlyArray<string>
    ): Effect.Effect<ReadonlyArray<string> | undefined> =>
      Effect.gen(function*() {
        const parents = yield* parentsOf(current)
        for (const parent of parents) {
          if (parent === childId) return [...chain, parent].reverse()
          if (seen.has(parent)) continue
          seen.add(parent)
          const found = yield* walk(parent, [...chain, parent])
          if (found !== undefined) return found
        }
        return undefined
      })
    return walk(parentId, [parentId])
  })

/** @private */
const DeferredAddressDatabaseRow = DeferredAddress

const encodeJson = (value: unknown, field: string): Effect.Effect<string> =>
  Schema.encodeEffect(UnknownFromJsonString)(value).pipe(
    Effect.mapError((cause) => new Error(`${field} must be JSON-serializable`, { cause })),
    Effect.orDie
  )

const decodeJson = (value: string, field: string): Effect.Effect<unknown> =>
  Schema.decodeUnknownEffect(UnknownFromJsonString)(value).pipe(
    Effect.mapError((cause) => new Error(`could not decode ${field}`, { cause })),
    Effect.orDie
  )

const decodeDeferredRow = (input: unknown): Effect.Effect<DeferredRow> =>
  Schema.decodeUnknownEffect(DeferredDatabaseRow)(input).pipe(
    Effect.orDie,
    Effect.flatMap((row) =>
      Effect.all({
        exit: decodeJson(row.exitJson, "exit_json"),
        metadata: row.metadataJson === null
          ? Effect.succeed(undefined)
          : decodeJson(row.metadataJson, "metadata_json")
      }).pipe(
        Effect.map(({ exit, metadata }) => ({
          flowName: row.flowName,
          executionId: row.executionId,
          deferredName: row.deferredName,
          exit,
          ...(metadata === undefined ? {} : { metadata }),
          completedAtMs: row.completedAtMs
        }))
      )
    )
  )

const decodeClockRow = (input: unknown): Effect.Effect<ClockRow> =>
  Schema.decodeUnknownEffect(ClockDatabaseRow)(input).pipe(
    Effect.orDie,
    Effect.map((row) => ({
      flowName: row.flowName,
      executionId: row.executionId,
      clockName: row.clockName,
      deferredName: row.deferredName,
      dueAtMs: row.dueAtMs,
      completedAtMs: row.completedAtMs
    }))
  )

/**
 * Constructs the database-backed durable-state implementation.
 *
 * Clock creation is fenced against the current run owner. Deferred completion
 * and clock firing are external trigger admissions protected by first-writer
 * and compare-and-set semantics; execution remains claim-gated by `RunStore`.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make: Effect.Effect<Service, never, DurableWriter | SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter

  // Engine-store-owned storage created outside the journal migration
  // (issues #40/#41/#79/#81). The statements, their rationale, and
  // the dialects each is known to accept live in one machine-readable
  // inventory so the pg-porting plan cannot omit them (issue #92).
  yield* EngineStateSchema.apply(sql, writer)

  const selectDeferred = (address: DeferredAddress) =>
    sql<DeferredDatabaseRow>`
      SELECT
        flow_name AS "flowName",
        execution_id AS "executionId",
        deferred_name AS "deferredName",
        exit_json AS "exitJson",
        metadata_json AS "metadataJson",
        completed_at_ms AS "completedAtMs"
      FROM flows_deferred_completions
      WHERE flow_name = ${address.flowName}
        AND execution_id = ${address.executionId}
        AND deferred_name = ${address.deferredName}
    `

  const selectClock = (address: ClockAddress) =>
    sql<ClockDatabaseRow>`
      SELECT
        flow_name AS "flowName",
        execution_id AS "executionId",
        clock_name AS "clockName",
        deferred_name AS "deferredName",
        due_at_ms AS "dueAtMs",
        completed_at_ms AS "completedAtMs"
      FROM flows_clock_deadlines
      WHERE flow_name = ${address.flowName}
        AND execution_id = ${address.executionId}
        AND clock_name = ${address.clockName}
    `

  const deferred: Service["deferred"] = Effect.fn("DurableEngineState.deferred")((address) =>
    selectDeferred(address).pipe(
      Effect.orDie,
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeedNone
          : Effect.map(decodeDeferredRow(rows[0]), Option.some)
      )
    )
  )

  const completeDeferred: Service["completeDeferred"] = Effect.fn(
    "DurableEngineState.completeDeferred"
  )((row) =>
    Effect.gen(function*() {
      const exitJson = yield* encodeJson(row.exit, "exit")
      const metadataJson = row.metadata === undefined
        ? null
        : yield* encodeJson(row.metadata, "metadata")
      return yield* writer.write(
        Effect.gen(function*() {
          const inserted = yield* sql<DeferredDatabaseRow>`
            INSERT INTO flows_deferred_completions (
              flow_name,
              execution_id,
              deferred_name,
              exit_json,
              metadata_json,
              completed_at_ms
            ) VALUES (
              ${row.flowName},
              ${row.executionId},
              ${row.deferredName},
              ${exitJson},
              ${metadataJson},
              ${row.completedAtMs}
            )
            ON CONFLICT (flow_name, execution_id, deferred_name) DO NOTHING
            RETURNING
              flow_name AS "flowName",
              execution_id AS "executionId",
              deferred_name AS "deferredName",
              exit_json AS "exitJson",
              metadata_json AS "metadataJson",
              completed_at_ms AS "completedAtMs"
          `
          if (inserted[0] !== undefined) {
            return {
              _tag: "Completed" as const,
              row: yield* decodeDeferredRow(inserted[0])
            }
          }
          const existing = yield* selectDeferred(row)
          if (existing[0] === undefined) {
            return yield* Effect.die(
              new Error("deferred completion disappeared during first-writer transaction")
            )
          }
          return {
            _tag: "Existing" as const,
            row: yield* decodeDeferredRow(existing[0])
          }
        })
      ).pipe(Effect.orDie)
    })
  )

  const clock: Service["clock"] = Effect.fn("DurableEngineState.clock")((address) =>
    selectClock(address).pipe(
      Effect.orDie,
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeedNone
          : Effect.map(decodeClockRow(rows[0]), Option.some)
      )
    )
  )

  const scheduleClock: Service["scheduleClock"] = Effect.fn("DurableEngineState.scheduleClock")((row, owner) =>
    owner === undefined
      ? Effect.interrupt
      : writer.write(
        Effect.gen(function*() {
          const inserted = yield* sql<ClockDatabaseRow>`
            INSERT INTO flows_clock_deadlines (
              flow_name,
              execution_id,
              clock_name,
              deferred_name,
              due_at_ms,
              completed_at_ms
            )
            SELECT
              ${row.flowName},
              ${row.executionId},
              ${row.clockName},
              ${row.deferredName},
              ${row.dueAtMs},
              ${row.completedAtMs}
            WHERE EXISTS (
              SELECT 1
              FROM flows_runs
              WHERE run_id = ${row.executionId}
                AND status = 'running'
                AND owner_host_id = ${owner.hostId}
                AND owner_pid = ${owner.pid}
                AND owner_nonce = ${owner.nonce}
            )
            ON CONFLICT (flow_name, execution_id, clock_name) DO NOTHING
            RETURNING
              flow_name AS "flowName",
              execution_id AS "executionId",
              clock_name AS "clockName",
              deferred_name AS "deferredName",
              due_at_ms AS "dueAtMs",
              completed_at_ms AS "completedAtMs"
          `
          if (inserted[0] !== undefined) {
            return {
              _tag: "Scheduled" as const,
              row: yield* decodeClockRow(inserted[0])
            }
          }
          const existing = yield* selectClock(row)
          if (existing[0] !== undefined) {
            return {
              _tag: "Existing" as const,
              row: yield* decodeClockRow(existing[0])
            }
          }
          return yield* Effect.interrupt
        })
      ).pipe(Effect.orDie)
  )

  const completeClock: Service["completeClock"] = Effect.fn("DurableEngineState.completeClock")((
    address,
    completedAtMs
  ) =>
    writer.write(
      Effect.gen(function*() {
        const updated = yield* sql<ClockDatabaseRow>`
          UPDATE flows_clock_deadlines
          SET completed_at_ms = ${completedAtMs}
          WHERE flow_name = ${address.flowName}
            AND execution_id = ${address.executionId}
            AND clock_name = ${address.clockName}
            AND completed_at_ms IS NULL
          RETURNING
            flow_name AS "flowName",
            execution_id AS "executionId",
            clock_name AS "clockName",
            deferred_name AS "deferredName",
            due_at_ms AS "dueAtMs",
            completed_at_ms AS "completedAtMs"
        `
        if (updated[0] !== undefined) {
          return {
            _tag: "Completed" as const,
            row: yield* decodeClockRow(updated[0])
          }
        }
        const existing = yield* selectClock(address)
        return existing[0] === undefined
          ? { _tag: "NotFound" as const }
          : {
            _tag: "AlreadyCompleted" as const,
            row: yield* decodeClockRow(existing[0])
          }
      })
    ).pipe(Effect.orDie)
  )

  const dueClocks: Service["dueClocks"] = Effect.fn("DurableEngineState.dueClocks")((nowMs) =>
    sql<ClockDatabaseRow>`
      SELECT
        flow_name AS "flowName",
        execution_id AS "executionId",
        clock_name AS "clockName",
        deferred_name AS "deferredName",
        due_at_ms AS "dueAtMs",
        completed_at_ms AS "completedAtMs"
      FROM flows_clock_deadlines
      WHERE completed_at_ms IS NULL
        AND due_at_ms <= ${nowMs}
      ORDER BY due_at_ms, execution_id, clock_name
    `.pipe(
      Effect.orDie,
      Effect.flatMap((rows) => Effect.forEach(rows, decodeClockRow))
    )
  )

  const pendingClocks: Service["pendingClocks"] = Effect.fn("DurableEngineState.pendingClocks")((scope) =>
    (scope.executionId !== undefined
      ? sql<ClockDatabaseRow>`
      SELECT
        flow_name AS "flowName",
        execution_id AS "executionId",
        clock_name AS "clockName",
        deferred_name AS "deferredName",
        due_at_ms AS "dueAtMs",
        completed_at_ms AS "completedAtMs"
      FROM flows_clock_deadlines
      WHERE completed_at_ms IS NULL
        AND execution_id = ${scope.executionId}
      ORDER BY due_at_ms, execution_id, clock_name
    `
      : scope.flowName !== undefined
      ? sql<ClockDatabaseRow>`
      SELECT
        flow_name AS "flowName",
        execution_id AS "executionId",
        clock_name AS "clockName",
        deferred_name AS "deferredName",
        due_at_ms AS "dueAtMs",
        completed_at_ms AS "completedAtMs"
      FROM flows_clock_deadlines
      WHERE completed_at_ms IS NULL
        AND flow_name = ${scope.flowName}
      ORDER BY due_at_ms, execution_id, clock_name
    `
      : sql<ClockDatabaseRow>`
      SELECT
        flow_name AS "flowName",
        execution_id AS "executionId",
        clock_name AS "clockName",
        deferred_name AS "deferredName",
        due_at_ms AS "dueAtMs",
        completed_at_ms AS "completedAtMs"
      FROM flows_clock_deadlines
      WHERE completed_at_ms IS NULL
      ORDER BY due_at_ms, execution_id, clock_name
    `).pipe(
        Effect.orDie,
        Effect.flatMap((rows) => Effect.forEach(rows, decodeClockRow))
      )
  )

  const completedDeferreds: Service["completedDeferreds"] = Effect.fn(
    "DurableEngineState.completedDeferreds"
  )((flowName) =>
    sql<Record<string, unknown>>`
      SELECT
        flow_name AS "flowName",
        execution_id AS "executionId",
        deferred_name AS "deferredName"
      FROM flows_deferred_completions
      WHERE flow_name = ${flowName}
      ORDER BY execution_id, deferred_name
    `.pipe(
      Effect.orDie,
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) => Schema.decodeUnknownEffect(DeferredAddressDatabaseRow)(row).pipe(Effect.orDie)
        )
      )
    )
  )

  const selectWaiting = (runId: string) =>
    sql<WaitingDatabaseRow>`
      SELECT
        run_id AS "runId",
        waiting_reason AS "waitingReason",
        waiting_wake_at_ms AS "waitingWakeAtMs",
        waiting_token AS "waitingToken"
      FROM flows_runs
      WHERE run_id = ${runId}
        AND waiting_reason IS NOT NULL
    `

  const park: Service["park"] = Effect.fn("DurableEngineState.park")((runId, waiting, owner) =>
    writer.write(
      Effect.gen(function*() {
        const updated = yield* sql<WaitingDatabaseRow>`
          UPDATE flows_runs
          SET
            waiting_reason = ${waiting.reason},
            waiting_wake_at_ms = ${waiting.wakeAt ?? null},
            waiting_token = ${waiting.token ?? null}
          WHERE run_id = ${runId}
            AND owner_host_id = ${owner.hostId}
            AND owner_pid = ${owner.pid}
            AND owner_nonce = ${owner.nonce}
          RETURNING
            run_id AS "runId",
            waiting_reason AS "waitingReason",
            waiting_wake_at_ms AS "waitingWakeAtMs",
            waiting_token AS "waitingToken"
        `
        if (updated[0] === undefined) {
          return { _tag: "NotFound" as const }
        }
        return { _tag: "Parked" as const, row: yield* decodeWaitingRow(updated[0]) }
      })
    ).pipe(Effect.orDie)
  )

  const wake: Service["wake"] = Effect.fn("DurableEngineState.wake")((runId) =>
    writer.write(
      Effect.gen(function*() {
        const before = yield* selectWaiting(runId)
        if (before[0] === undefined) {
          const existing = yield* sql<{ runId: string }>`
            SELECT run_id AS "runId" FROM flows_runs WHERE run_id = ${runId}
          `
          return existing[0] === undefined ? { _tag: "NotFound" as const } : { _tag: "NotWaiting" as const }
        }
        const row = yield* decodeWaitingRow(before[0])
        yield* sql`
          UPDATE flows_runs
          SET
            waiting_reason = NULL,
            waiting_wake_at_ms = NULL,
            waiting_token = NULL
          WHERE run_id = ${runId}
            AND waiting_reason IS NOT NULL
        `
        return { _tag: "Woken" as const, row }
      })
    ).pipe(Effect.orDie)
  )

  const waiting: Service["waiting"] = Effect.fn("DurableEngineState.waiting")((runId) =>
    selectWaiting(runId).pipe(
      Effect.orDie,
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeedNone
          : Effect.map(decodeWaitingRow(rows[0]), Option.some)
      )
    )
  )

  const waitingRuns: Service["waitingRuns"] = Effect.fn("DurableEngineState.waitingRuns")((filter) => {
    // `1 = 0` short-circuits the cancel predicate away when the caller did
    // not ask for it, so the reason/wake filters (and the 0004 index) stay
    // the leading predicates (issue #68).
    const cancelRequestedOnly = filter?.cancelRequested === true ? 1 : 0
    return (filter?.reason !== undefined && filter.dueBeforeMs !== undefined
      ? sql<WaitingDatabaseRow>`
        SELECT
          run_id AS "runId",
          waiting_reason AS "waitingReason",
          waiting_wake_at_ms AS "waitingWakeAtMs",
          waiting_token AS "waitingToken"
        FROM flows_runs
        WHERE waiting_reason = ${filter.reason}
          AND waiting_wake_at_ms IS NOT NULL
          AND waiting_wake_at_ms <= ${filter.dueBeforeMs}
          AND (${cancelRequestedOnly} = 0 OR cancel_requested_at_ms IS NOT NULL)
          AND status NOT IN ('completed', 'failed', 'cancelled')
        ORDER BY waiting_wake_at_ms, run_id
      `
      : filter?.reason !== undefined
      ? sql<WaitingDatabaseRow>`
        SELECT
          run_id AS "runId",
          waiting_reason AS "waitingReason",
          waiting_wake_at_ms AS "waitingWakeAtMs",
          waiting_token AS "waitingToken"
        FROM flows_runs
        WHERE waiting_reason = ${filter.reason}
          AND (${cancelRequestedOnly} = 0 OR cancel_requested_at_ms IS NOT NULL)
          AND status NOT IN ('completed', 'failed', 'cancelled')
        ORDER BY waiting_wake_at_ms, run_id
      `
      : filter?.dueBeforeMs !== undefined
      ? sql<WaitingDatabaseRow>`
        SELECT
          run_id AS "runId",
          waiting_reason AS "waitingReason",
          waiting_wake_at_ms AS "waitingWakeAtMs",
          waiting_token AS "waitingToken"
        FROM flows_runs
        WHERE waiting_reason IS NOT NULL
          AND waiting_wake_at_ms IS NOT NULL
          AND waiting_wake_at_ms <= ${filter.dueBeforeMs}
          AND (${cancelRequestedOnly} = 0 OR cancel_requested_at_ms IS NOT NULL)
          AND status NOT IN ('completed', 'failed', 'cancelled')
        ORDER BY waiting_wake_at_ms, run_id
      `
      : sql<WaitingDatabaseRow>`
        SELECT
          run_id AS "runId",
          waiting_reason AS "waitingReason",
          waiting_wake_at_ms AS "waitingWakeAtMs",
          waiting_token AS "waitingToken"
        FROM flows_runs
        WHERE waiting_reason IS NOT NULL
          AND (${cancelRequestedOnly} = 0 OR cancel_requested_at_ms IS NOT NULL)
          AND status NOT IN ('completed', 'failed', 'cancelled')
        ORDER BY waiting_wake_at_ms, run_id
      `).pipe(
        Effect.orDie,
        Effect.flatMap((rows) => Effect.forEach(rows, decodeWaitingRow))
      )
  })

  const staleRunningRuns: Service["staleRunningRuns"] = Effect.fn(
    "DurableEngineState.staleRunningRuns"
  )((staleBeforeMs, limit) =>
    // `LIMIT -1` is SQLite's explicit "no limit"; the partial index created
    // in `make` serves the predicate, so the per-tick sweep is an index
    // range read instead of a full table scan (issue #79).
    sql<{ runId: string }>`
      SELECT run_id AS "runId"
      FROM flows_runs
      WHERE status = 'running'
        AND heartbeat_at_ms IS NOT NULL
        AND heartbeat_at_ms < ${staleBeforeMs}
      ORDER BY heartbeat_at_ms, run_id
      LIMIT ${limit ?? -1}
    `.pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => String(row.runId)))
    )
  )

  /**
   * One ordered range read replaces the engine store's per-attempt point
   * probes (issue #77): a fresh key costs one empty SELECT instead of 32
   * sequential gets, and a resumed key one SELECT instead of one per
   * surviving attempt. The earliest surviving row is the durable retry
   * origin (issue #69) and the highest attempt contiguous from it the
   * resumed counter (issue #59). This read is deliberately unbounded; the
   * pruned-prefix tolerance that makes it agree with the point-probe
   * fallback is applied once, by the caller, in
   * `internal/AttemptProbe.probeAttempts` (issue #96).
   */
  const attemptSurvivors: NonNullable<Service["attemptSurvivors"]> = Effect.fn(
    "DurableEngineState.attemptSurvivors"
  )((runId, stepKeyDigest) =>
    sql<{ readonly attempt: number; readonly startedAtMs: number }>`
      SELECT attempt AS "attempt", started_at_ms AS "startedAtMs"
      FROM flows_attempts
      WHERE run_id = ${runId}
        AND step_key_digest = ${stepKeyDigest}
      ORDER BY attempt
    `.pipe(
      Effect.orDie,
      Effect.map((rows) => {
        const first = rows[0]
        if (first === undefined) return Option.none()
        let latest = Number(first.attempt)
        for (let index = 1; index < rows.length; index++) {
          const next = Number(rows[index]!.attempt)
          if (next !== latest + 1) break
          latest = next
        }
        return Option.some({
          earliestAttempt: Number(first.attempt),
          earliestStartedAtMs: Number(first.startedAtMs),
          latest
        })
      })
    )
  )

  const selectRunParent = (childId: string, parentId: string) =>
    sql<RunParentDatabaseRow>`
      SELECT
        child_id AS "childId",
        parent_id AS "parentId",
        seq AS "seq"
      FROM flows_run_parents
      WHERE child_id = ${childId}
        AND parent_id = ${parentId}
    `

  const parentIdsOf = (id: string): Effect.Effect<ReadonlyArray<string>> =>
    sql<RunParentDatabaseRow>`
      SELECT
        child_id AS "childId",
        parent_id AS "parentId",
        seq AS "seq"
      FROM flows_run_parents
      WHERE child_id = ${id}
      ORDER BY seq
    `.pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => String(row.parentId)))
    )

  const recordRunParent: Service["recordRunParent"] = Effect.fn(
    "DurableEngineState.recordRunParent"
  )((childId, parentId) =>
    writer.write(
      Effect.gen(function*() {
        // MAX(seq)+1 and the insert share one write transaction, so the
        // assigned seq is a total insertion order over the store.
        const inserted = yield* sql<RunParentDatabaseRow>`
          INSERT INTO flows_run_parents (child_id, parent_id, seq)
          SELECT ${childId}, ${parentId}, COALESCE(MAX(seq), 0) + 1
          FROM flows_run_parents
          WHERE TRUE
          ON CONFLICT (child_id, parent_id) DO NOTHING
          RETURNING
            child_id AS "childId",
            parent_id AS "parentId",
            seq AS "seq"
        `
        if (inserted[0] !== undefined) {
          // The cycle check shares the insert's transaction: a hit fails the
          // effect, rolling the insert back, so a rejected edge is never
          // durable and there is no check-then-record window for another
          // writer to slip through (issues #54/#55/#56). The insert
          // precedes the walk, so the transaction holds the write lock
          // while walking: under `DurableWriter.write`'s documented contract —
          // write transactions are mutually serialized (issue #74) — of two
          // edges that jointly close a cycle, exactly the later one fails.
          // This is a contract requirement, not a SQLite artifact; a
          // backend that ran writes at READ COMMITTED would break it and is
          // excluded by the DurableWriter contract.
          const cycle = yield* findCyclePath(childId, parentId, parentIdsOf)
          if (cycle !== undefined) {
            return yield* Effect.fail(new RunParentCycleError({ path: cycle }))
          }
          return {
            _tag: "Recorded" as const,
            edge: yield* decodeRunParentEdge(inserted[0])
          }
        }
        const existing = yield* selectRunParent(childId, parentId)
        if (existing[0] === undefined) {
          return yield* Effect.die(
            new Error("run parent edge disappeared during first-writer transaction")
          )
        }
        return {
          _tag: "Existing" as const,
          edge: yield* decodeRunParentEdge(existing[0])
        }
      })
    ).pipe(
      Effect.catch((error) => error instanceof RunParentCycleError ? Effect.fail(error) : Effect.die(error))
    )
  )

  const removeRunParentsForRun: Service["removeRunParentsForRun"] = Effect.fn(
    "DurableEngineState.removeRunParentsForRun"
  )((runId) =>
    writer.write(sql`
      DELETE FROM flows_run_parents
      WHERE child_id = ${runId}
        OR parent_id = ${runId}
    `).pipe(Effect.orDie, Effect.asVoid)
  )

  const transaction: Service["transaction"] = <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> =>
    writer.write(effect).pipe(
      Effect.catchIf(
        (error): error is DatabaseError => error instanceof DatabaseError,
        (error) => Effect.die(error)
      )
    )

  const runParents: Service["runParents"] = Effect.fn("DurableEngineState.runParents")((childId) =>
    sql<RunParentDatabaseRow>`
      SELECT
        child_id AS "childId",
        parent_id AS "parentId",
        seq AS "seq"
      FROM flows_run_parents
      WHERE child_id = ${childId}
      ORDER BY seq
    `.pipe(
      Effect.orDie,
      Effect.flatMap((rows) => Effect.forEach(rows, decodeRunParentEdge))
    )
  )

  const runChildren: Service["runChildren"] = Effect.fn("DurableEngineState.runChildren")((parentId) =>
    sql<RunParentDatabaseRow>`
      SELECT
        child_id AS "childId",
        parent_id AS "parentId",
        seq AS "seq"
      FROM flows_run_parents
      WHERE parent_id = ${parentId}
      ORDER BY seq
    `.pipe(
      Effect.orDie,
      Effect.flatMap((rows) => Effect.forEach(rows, decodeRunParentEdge))
    )
  )

  return DurableEngineState.of({
    deferred,
    completeDeferred,
    clock,
    scheduleClock,
    completeClock,
    dueClocks,
    pendingClocks,
    completedDeferreds,
    park,
    wake,
    waiting,
    waitingRuns,
    staleRunningRuns,
    attemptSurvivors,
    recordRunParent,
    removeRunParentsForRun,
    runParents,
    runChildren,
    transaction
  })
})

/**
 * Provides database-backed durable engine state.
 *
 * @since 0.1.0
 * @category layers
 * @slop
 */
export const layer: Layer.Layer<DurableEngineState, never, DurableWriter | SqlClient.SqlClient> = Layer.effect(
  DurableEngineState,
  make
)

/**
 * A run's ownership view as the in-memory implementation needs it for the
 * same fences the SQL implementation reads from `flows_runs`.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface MemoryRunView {
  readonly status: "pending" | "running" | "suspended" | "completed" | "failed" | "cancelled"
  readonly owner: OwnerId | null
  /**
   * The run's last heartbeat instant, mirroring `flows_runs.heartbeat_at_ms`.
   * `undefined` means unknown — such a run never surfaces from
   * `staleRunningRuns` (issue #53).
   */
  readonly heartbeatAtMs?: number | null | undefined
  /**
   * The run's durable cancel request, mirroring
   * `flows_runs.cancel_requested_at_ms`. `undefined`/`null` means not
   * requested — such a run never surfaces from a
   * `waitingRuns({ cancelRequested: true })` query (issue #68).
   */
  readonly cancelRequestedAtMs?: number | null | undefined
}

/**
 * Options for the in-memory durable-state implementation.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface MemoryOptions {
  /**
   * Resolves a run's existence, status, and owner — the in-memory analogue
   * of the `flows_runs` lookups the SQL implementation performs for its
   * `park`/`wake`/`scheduleClock` fences. `Option.none()` means the run does
   * not exist. When omitted, every run is treated as running and owned by
   * whichever owner is presented (a deliberately permissive default for tests
   * that exercise only deferred/clock state without a run table).
   */
  readonly runs?: (runId: string) => Option.Option<MemoryRunView>
  /**
   * Enumerates every known run — the in-memory analogue of scanning
   * `flows_runs`, which `staleRunningRuns` needs (the `runs` lookup alone
   * cannot enumerate). When omitted, `staleRunningRuns` reports no stale
   * rows.
   */
  readonly listRuns?: () => Iterable<readonly [string, MemoryRunView]>
}

/**
 * Constructs a deterministic in-memory durable-state implementation.
 *
 * The returned service can be shared by multiple fresh engine instances in a
 * test to model process restart over the same storage. With `runs` supplied
 * it enforces the same ownership fences as the SQL implementation and is
 * held to the same contract suite
 * (`test/contract/DurableEngineStateContract.ts`).
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const makeMemory = (options: MemoryOptions = {}): Service => {
  const deferreds = new Map<string, DeferredRow>()
  const clocks = new Map<string, ClockRow>()
  const waitingRows = new Map<string, WaitingRow>()
  // childId -> (parentId -> seq); `parentSeq` mirrors the SQL MAX(seq)+1.
  const parentEdges = new Map<string, Map<string, number>>()
  let parentSeq = 0

  /** The synchronous twin of `findCyclePath` over the in-memory edge map. */
  const findCyclePathSync = (
    childId: string,
    parentId: string
  ): ReadonlyArray<string> | undefined => {
    if (parentId === childId) return [childId]
    const seen = new Set<string>([parentId])
    const walk = (
      current: string,
      chain: ReadonlyArray<string>
    ): ReadonlyArray<string> | undefined => {
      for (const parent of parentEdges.get(current)?.keys() ?? []) {
        if (parent === childId) return [...chain, parent].reverse()
        if (seen.has(parent)) continue
        seen.add(parent)
        const found = walk(parent, [...chain, parent])
        if (found !== undefined) return found
      }
      return undefined
    }
    return walk(parentId, [parentId])
  }

  const sameOwner = (left: OwnerId, right: OwnerId): boolean =>
    left.hostId === right.hostId && left.pid === right.pid && left.nonce === right.nonce

  /** Mirrors the SQL `flows_runs` owner-match predicate for a run. */
  const runView = (runId: string, presented: OwnerId | undefined): {
    readonly exists: boolean
    readonly running: boolean
    readonly owned: boolean
  } => {
    if (options.runs === undefined) {
      return { exists: true, running: true, owned: true }
    }
    const view = options.runs(runId)
    if (Option.isNone(view)) {
      return { exists: false, running: false, owned: false }
    }
    const owned = presented !== undefined &&
      view.value.owner !== null &&
      sameOwner(view.value.owner, presented)
    return { exists: true, running: view.value.status === "running", owned }
  }

  return DurableEngineState.of({
    deferred: Effect.fn("DurableEngineState.deferred")((address) =>
      Effect.sync(() => Option.fromNullishOr(deferreds.get(deferredKey(address))))
    ),
    completeDeferred: Effect.fn("DurableEngineState.completeDeferred")((row) =>
      Effect.sync(() => {
        const key = deferredKey(row)
        const existing = deferreds.get(key)
        if (existing !== undefined) {
          return { _tag: "Existing" as const, row: existing }
        }
        deferreds.set(key, row)
        return { _tag: "Completed" as const, row }
      })
    ),
    clock: Effect.fn("DurableEngineState.clock")((address) =>
      Effect.sync(() => Option.fromNullishOr(clocks.get(clockKey(address))))
    ),
    scheduleClock: Effect.fn("DurableEngineState.scheduleClock")((row, owner) =>
      Effect.suspend((): Effect.Effect<ScheduleClockOutcome> => {
        // Mirrors the SQL fence: creation requires the presented owner to
        // currently run the execution; a lost fence surfaces as
        // self-interruption, an existing row wins regardless.
        if (owner === undefined) return Effect.interrupt
        const key = clockKey(row)
        const existing = clocks.get(key)
        if (existing !== undefined) {
          return Effect.succeed({ _tag: "Existing" as const, row: existing })
        }
        const view = runView(row.executionId, owner)
        if (!view.exists || !view.running || !view.owned) {
          return Effect.interrupt
        }
        clocks.set(key, row)
        return Effect.succeed({ _tag: "Scheduled" as const, row })
      })
    ),
    completeClock: Effect.fn("DurableEngineState.completeClock")((address, completedAtMs) =>
      Effect.sync(() => {
        const key = clockKey(address)
        const existing = clocks.get(key)
        if (existing === undefined) {
          return { _tag: "NotFound" as const }
        }
        if (existing.completedAtMs !== null) {
          return { _tag: "AlreadyCompleted" as const, row: existing }
        }
        const row = { ...existing, completedAtMs }
        clocks.set(key, row)
        return { _tag: "Completed" as const, row }
      })
    ),
    dueClocks: Effect.fn("DurableEngineState.dueClocks")((nowMs) =>
      Effect.sync(() =>
        Array.from(clocks.values())
          .filter((row) => row.completedAtMs === null && row.dueAtMs <= nowMs)
          .sort((left, right) =>
            left.dueAtMs - right.dueAtMs ||
            left.executionId.localeCompare(right.executionId) ||
            left.clockName.localeCompare(right.clockName)
          )
      )
    ),
    pendingClocks: Effect.fn("DurableEngineState.pendingClocks")((scope) =>
      Effect.sync(() =>
        Array.from(clocks.values())
          .filter((row) =>
            row.completedAtMs === null &&
            (scope.executionId === undefined || row.executionId === scope.executionId) &&
            (scope.flowName === undefined || row.flowName === scope.flowName)
          )
          .sort((left, right) =>
            left.dueAtMs - right.dueAtMs ||
            left.executionId.localeCompare(right.executionId) ||
            left.clockName.localeCompare(right.clockName)
          )
      )
    ),
    completedDeferreds: Effect.fn("DurableEngineState.completedDeferreds")((flowName) =>
      Effect.sync(() =>
        Array.from(deferreds.values())
          .filter((row) => row.flowName === flowName)
          .map(({ flowName, executionId, deferredName }) => ({
            flowName,
            executionId,
            deferredName
          }))
          .sort((left, right) =>
            left.executionId.localeCompare(right.executionId) ||
            left.deferredName.localeCompare(right.deferredName)
          )
      )
    ),
    park: Effect.fn("DurableEngineState.park")((runId, waitingPayload, owner) =>
      Effect.sync(() => {
        // Mirrors the SQL fence: only the current owner of an existing run
        // may park it; anything else reports NotFound, exactly like the
        // owner-guarded UPDATE matching no row.
        const view = runView(runId, owner)
        if (!view.exists || !view.owned) {
          return { _tag: "NotFound" as const }
        }
        const row: WaitingRow = {
          runId,
          reason: waitingPayload.reason,
          wakeAt: waitingPayload.wakeAt ?? null,
          token: waitingPayload.token ?? null
        }
        waitingRows.set(runId, row)
        return { _tag: "Parked" as const, row }
      })
    ),
    wake: Effect.fn("DurableEngineState.wake")((runId) =>
      Effect.sync(() => {
        const row = waitingRows.get(runId)
        if (row === undefined) {
          // Mirrors SQL: an unknown run is NotFound, an existing unparked
          // run is NotWaiting.
          return runView(runId, undefined).exists
            ? { _tag: "NotWaiting" as const }
            : { _tag: "NotFound" as const }
        }
        waitingRows.delete(runId)
        return { _tag: "Woken" as const, row }
      })
    ),
    waiting: Effect.fn("DurableEngineState.waiting")((runId) =>
      Effect.sync(() => Option.fromNullishOr(waitingRows.get(runId)))
    ),
    waitingRuns: Effect.fn("DurableEngineState.waitingRuns")((filter) =>
      Effect.sync(() =>
        Array.from(waitingRows.values())
          // Mirrors the SQL status predicate: a terminally closed run's
          // stale waiting row never surfaces to a sweeper (issue #28). The
          // permissive default (no `runs` view) treats every run as live.
          .filter((row) => {
            if (options.runs === undefined) return true
            const view = options.runs(row.runId)
            return Option.isNone(view) ||
              view.value.status === "pending" ||
              view.value.status === "running" ||
              view.value.status === "suspended"
          })
          .filter((row) => filter?.reason === undefined || row.reason === filter.reason)
          .filter((row) =>
            filter?.dueBeforeMs === undefined ||
            (row.wakeAt !== null && row.wakeAt <= filter.dueBeforeMs)
          )
          // Mirrors the SQL cancel predicate over
          // `flows_runs.cancel_requested_at_ms` (issue #68). Without a
          // `runs` view the flag is unknowable, so the query stays
          // permissive and the sweeper's own per-row guard decides.
          .filter((row) => {
            if (filter?.cancelRequested !== true) return true
            if (options.runs === undefined) return true
            const view = options.runs(row.runId)
            return Option.isSome(view) && view.value.cancelRequestedAtMs != null
          })
          .sort((left, right) =>
            (left.wakeAt ?? Number.MAX_SAFE_INTEGER) - (right.wakeAt ?? Number.MAX_SAFE_INTEGER) ||
            left.runId.localeCompare(right.runId)
          )
      )
    ),
    staleRunningRuns: Effect.fn("DurableEngineState.staleRunningRuns")((staleBeforeMs, limit) =>
      Effect.sync(() => {
        // Mirrors the SQL scan of `flows_runs`: without an enumerator there
        // is nothing to scan, so no stale rows exist.
        if (options.listRuns === undefined) return []
        const stale: Array<{ runId: string; heartbeatAtMs: number }> = []
        for (const [runId, view] of options.listRuns()) {
          const heartbeatAtMs = view.heartbeatAtMs
          if (
            view.status === "running" &&
            typeof heartbeatAtMs === "number" &&
            heartbeatAtMs < staleBeforeMs
          ) {
            stale.push({ runId, heartbeatAtMs })
          }
        }
        const ordered = stale
          .sort((left, right) =>
            left.heartbeatAtMs - right.heartbeatAtMs ||
            left.runId.localeCompare(right.runId)
          )
          .map((row) => row.runId)
        // Mirrors the SQL LIMIT: oldest heartbeats first, capped per sweep
        // (issue #79).
        return limit === undefined ? ordered : ordered.slice(0, limit)
      })
    ),
    recordRunParent: Effect.fn("DurableEngineState.recordRunParent")((childId, parentId) =>
      // A single synchronous step mirrors the SQL transaction: the cycle
      // check and the insert are atomic — no fiber can interleave between
      // them, and a rejected edge is never observable (issues #54/#55/#56).
      Effect.suspend((): Effect.Effect<RecordRunParentOutcome, RunParentCycleError> => {
        const parents = parentEdges.get(childId) ?? new Map<string, number>()
        const existing = parents.get(parentId)
        if (existing !== undefined) {
          return Effect.succeed({
            _tag: "Existing" as const,
            edge: { childId, parentId, seq: existing }
          })
        }
        const cycle = findCyclePathSync(childId, parentId)
        if (cycle !== undefined) {
          return Effect.fail(new RunParentCycleError({ path: cycle }))
        }
        parentSeq += 1
        parents.set(parentId, parentSeq)
        parentEdges.set(childId, parents)
        return Effect.succeed({
          _tag: "Recorded" as const,
          edge: { childId, parentId, seq: parentSeq }
        })
      })
    ),
    removeRunParentsForRun: Effect.fn("DurableEngineState.removeRunParentsForRun")((runId) =>
      Effect.sync(() => {
        parentEdges.delete(runId)
        for (const [childId, parents] of parentEdges) {
          parents.delete(runId)
          if (parents.size === 0) parentEdges.delete(childId)
        }
      })
    ),
    runParents: Effect.fn("DurableEngineState.runParents")((childId) =>
      Effect.sync(() =>
        Array.from(parentEdges.get(childId) ?? [])
          .map(([parentId, seq]) => ({ childId, parentId, seq }))
          .sort((left, right) => left.seq - right.seq)
      )
    ),
    runChildren: Effect.fn("DurableEngineState.runChildren")((parentId) =>
      Effect.sync(() => {
        const edges: Array<RunParentEdge> = []
        for (const [childId, parents] of parentEdges) {
          const seq = parents.get(parentId)
          if (seq !== undefined) edges.push({ childId, parentId, seq })
        }
        return edges.sort((left, right) => left.seq - right.seq)
      })
    ),
    // The in-memory twin has no crash windows between writes, so the
    // atomicity `transaction` exists to provide (issue #80) holds trivially;
    // the effect runs directly and nothing is rolled back.
    transaction: (effect) => effect
  })
}

/**
 * Provides deterministic in-memory durable engine state.
 *
 * @since 0.1.0
 * @category layers
 * @slop
 */
export const layerMemory: Layer.Layer<DurableEngineState> = Layer.sync(
  DurableEngineState,
  makeMemory
)
