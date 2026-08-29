/**
 * Ownership-fenced, crash-recoverable rewind protocol.
 *
 * @since 0.1.0
 */
import type { Jj } from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import type { LivenessEvidence, OwnerId } from "@smthrs/run-store/Ownership"
import * as RunStore from "@smthrs/run-store/RunStore"
import type * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as EffectBoundary from "../EffectBoundary.ts"
import { Frame, type LineageEdge } from "../Frame.ts"
import { error, TimeTravelError, type TimeTravelError as TimeTravelFailure } from "../TimeTravelError.ts"
import { ArchiveResult, type Audit, TimeTravelStore } from "../TimeTravelStore.ts"
import * as Compensation from "./Compensation.ts"
import type { EffectHandlerRegistry } from "./EffectHandlerRegistry.ts"

/**
 * The eight fault-injection points pinned by the rewind parity suite.
 *
 * Every hook runs after the durable audit exists and before the atomic archive
 * commit. A failure therefore exercises rollback while preserving the audit.
 *
 * @since 0.1.0
 * @category models
 */
export const RewindStep = Schema.Literals([
  "claim-run",
  "rate-limit",
  "write-audit",
  "load-suffix",
  "assess-boundary",
  "compensate-effects",
  "restore-workspace",
  "archive-and-truncate"
])
/**
 * The value form of {@link RewindStep}.
 *
 * @since 0.1.0
 * @category models
 */
export type RewindStep = typeof RewindStep.Type

/**
 * A deterministic rate-limit decision recorded on the audit row.
 *
 * @since 0.1.0
 * @category models
 */
export const RateLimitDecision = Schema.Struct({
  allowed: Schema.Boolean,
  detail: Schema.optionalKey(Schema.Unknown)
})
/**
 * The value form of {@link RateLimitDecision}.
 *
 * @since 0.1.0
 * @category models
 */
export type RateLimitDecision = typeof RateLimitDecision.Type

/**
 * Child handling policy for detached runs crossed by the rewind.
 *
 * @since 0.1.0
 * @category models
 */
export const DetachedChildPolicy = Schema.Literals(["block", "cancel"])
/**
 * The value form of {@link DetachedChildPolicy}.
 *
 * @since 0.1.0
 * @category models
 */
export type DetachedChildPolicy = typeof DetachedChildPolicy.Type

/**
 * A warning disclosed for a terminal detached child that survives truncation.
 *
 * @since 0.1.0
 * @category models
 */
export const DetachedChildWarning = Schema.Struct({
  childRunId: Schema.NonEmptyString,
  parentSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reason: Schema.String
})
/**
 * The value form of {@link DetachedChildWarning}.
 *
 * @since 0.1.0
 * @category models
 */
export type DetachedChildWarning = typeof DetachedChildWarning.Type

/**
 * Crash-recovery detail persisted on the audit row.
 *
 * @since 0.1.0
 * @category models
 */
export const AuditDetail = Schema.Struct({
  version: Schema.Literal(1),
  phase: Schema.Literals([
    "audit_written",
    "preflight_complete",
    "compensated",
    "archive_committed",
    "completed",
    "rolled_back",
    "terminal_failure"
  ]),
  originalStatus: Schema.Literals(["pending", "suspended"]),
  suffixCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  suffixTailSeq: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  targetChangeId: Schema.optionalKey(Schema.NonEmptyString),
  compensation: Schema.optionalKey(Compensation.Result),
  warnings: Schema.Array(DetachedChildWarning),
  cancelledChildren: Schema.Array(Schema.NonEmptyString),
  failure: Schema.optionalKey(Schema.String)
})
/**
 * The value form of {@link AuditDetail}.
 *
 * @since 0.1.0
 * @category models
 */
export type AuditDetail = typeof AuditDetail.Type

/**
 * Rewind construction options.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly runId: string
  readonly frame: Frame
  readonly owner: OwnerId
  readonly auditId?: string | undefined
  readonly pageSize?: number | undefined
  readonly detachedChildPolicy?: DetachedChildPolicy | undefined
  readonly rateLimit?: (options: {
    readonly runId: string
    readonly frame: Frame
    readonly nowMs: number
  }) => Effect.Effect<RateLimitDecision, TimeTravelFailure> | undefined
  readonly childLivenessEvidence?: (
    childRunId: string,
    row: RunStore.RunRow,
    owner: OwnerId,
    nowMs: number
  ) => Effect.Effect<LivenessEvidence | undefined, TimeTravelFailure>
  readonly hooks?: {
    readonly beforeStep?: (
      step: RewindStep
    ) => Effect.Effect<void, unknown>
  } | undefined
}

/**
 * Successful rewind outcome.
 *
 * @since 0.1.0
 * @category models
 */
export const Result = Schema.Struct({
  auditId: Schema.NonEmptyString,
  frame: Frame,
  archive: ArchiveResult,
  assessments: Schema.Array(Compensation.Assessment),
  warnings: Schema.Array(DetachedChildWarning),
  cancelledChildren: Schema.Array(Schema.NonEmptyString)
})
/**
 * The value form of {@link Result}.
 *
 * @since 0.1.0
 * @category models
 */
export type Result = typeof Result.Type

interface ClaimedRun {
  readonly row: RunStore.RunRow & { readonly status: "pending" | "suspended" }
  readonly claimedAtMs: number
}

interface ChildPlan {
  readonly edge: LineageEdge
  readonly row: RunStore.RunRow
}

const runStoreFailure = (
  operation: string,
  cause: RunStore.RunStoreError
): TimeTravelFailure =>
  error(
    cause.code === "not_found_row" ? "not_found" : "unknown",
    `${operation} failed`,
    cause
  )

/** The lineage a validation scan reads off a journal entry's open metadata. */
const LineageMetadata = Schema.Struct({ lineageId: Schema.NonEmptyString })

const lineageOf = (entry: JournalEvent.Entry): string | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(LineageMetadata)(entry.meta))?.lineageId

/**
 * The validation phase of the rewind protocol: every caller-supplied input and
 * every frame-lineage claim is checked BEFORE the first durable or workspace
 * mutation — before the ownership claim, before the audit row, before any
 * store write.
 *
 * The public `TimeTravel.rewind` runs this ahead of {@link rewind}'s claim
 * phase, so a refused position leaves no trace: no claim was taken, no audit
 * was opened, no journal page was read for a malformed page size.
 *
 * A frame is refused `not_found` unless it addresses the run's history:
 * the coordinate must not lie past the journal tail, the run's tail must be on
 * the requested lineage (a sibling lineage's coordinate is not a point this
 * run can be truncated back to), and — frame zero excepted, the one frame that
 * is always addressable — a record of the requested lineage must exist at the
 * exact coordinate. Records that carry no lineage are compatible with every
 * frame: they predate lineage minting yet are still evidence of the run.
 *
 * @since 0.1.0
 * @category validators
 */
export const validate = (options: {
  readonly runId: string
  readonly frame: Frame
  readonly pageSize?: number | undefined
}): Effect.Effect<void, TimeTravelFailure, Journal.Journal> =>
  Effect.gen(function*() {
    if (options.pageSize !== undefined && (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1)) {
      return yield* Effect.fail(
        error("invalid", `rewind pageSize must be a positive integer, not ${String(options.pageSize)}`)
      )
    }
    const journal = yield* Journal.Journal
    const coordinate = `${options.frame.lineageId}@${options.frame.seq}`
    let after: JournalEvent.Seq | undefined
    let tail: JournalEvent.Entry | undefined
    let atFrame = false
    while (true) {
      const page = yield* journal.entries({
        runId: options.runId as JournalEvent.RunId,
        ...(after === undefined ? {} : { after }),
        limit: options.pageSize ?? 100
      }).pipe(
        Effect.mapError((cause) =>
          error("unknown", `could not validate frame ${coordinate} for ${options.runId}`, cause)
        )
      )
      let pageTail: JournalEvent.Seq | undefined
      for (const entry of page.entries) {
        if (pageTail === undefined || entry.seq > pageTail) pageTail = entry.seq
        if (tail === undefined || entry.seq > tail.seq) tail = entry
        if (entry.seq === options.frame.seq) {
          const lineage = lineageOf(entry)
          if (lineage === undefined || lineage === options.frame.lineageId) atFrame = true
        }
      }
      if (!page.hasMore || page.entries.length === 0) break
      const previous = after ?? -1
      if (pageTail === undefined || pageTail <= previous) {
        return yield* Effect.fail(
          error("invalid", `journal validation pagination did not advance for ${options.runId}`)
        )
      }
      after = pageTail
    }
    if (tail === undefined) {
      // Frame zero is the state before the run wrote anything, so it is the
      // one frame an empty journal can still address.
      if (options.frame.seq === 0) return
      return yield* Effect.fail(
        error("not_found", `frame ${coordinate} is beyond the journal tail of ${options.runId}`)
      )
    }
    if (options.frame.seq > tail.seq) {
      return yield* Effect.fail(
        error("not_found", `frame ${coordinate} is beyond the journal tail of ${options.runId}`)
      )
    }
    const tailLineage = lineageOf(tail)
    if (tailLineage !== undefined && tailLineage !== options.frame.lineageId) {
      return yield* Effect.fail(
        error("not_found", `run ${options.runId} is on lineage ${tailLineage}, not ${options.frame.lineageId}`)
      )
    }
    if (options.frame.seq > 0 && !atFrame) {
      return yield* Effect.fail(
        error(
          "not_found",
          `no record of lineage ${options.frame.lineageId} exists at seq ${options.frame.seq} in ${options.runId}`
        )
      )
    }
  })

const readSuffix = (
  journal: Journal.Service,
  runId: string,
  frame: Frame,
  pageSize: number
): Effect.Effect<ReadonlyArray<JournalEvent.Entry>, TimeTravelFailure> =>
  Effect.gen(function*() {
    const entries: Array<JournalEvent.Entry> = []
    let after = frame.seq as JournalEvent.Seq
    while (true) {
      const page = yield* journal.entries({
        runId: runId as JournalEvent.RunId,
        after,
        limit: pageSize
      }).pipe(
        Effect.mapError((cause) => error("unknown", `could not read suffix for ${runId}`, cause))
      )
      entries.push(...page.entries)
      if (!page.hasMore || page.entries.length === 0) return entries
      const next = page.entries.reduce((tail, entry) => entry.seq > tail ? entry.seq : tail, after)
      if (next <= after) {
        return yield* Effect.fail(error("invalid", `journal suffix pagination did not advance for ${runId}`))
      }
      after = next
    }
  })

const snapshotOf = (row: RunStore.RunRow): RunStore.RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

const claimRun = (
  runs: RunStore.Service,
  options: Options,
  nowMs: number
): Effect.Effect<ClaimedRun, TimeTravelFailure> =>
  Effect.gen(function*() {
    const row = yield* runs.get(options.runId).pipe(
      Effect.mapError((cause) => runStoreFailure("read run", cause))
    )
    if (row.status !== "pending" && row.status !== "suspended") {
      return yield* Effect.fail(error("busy", `run ${options.runId} is not available for rewind`))
    }
    const rewindableRow: ClaimedRun["row"] = { ...row, status: row.status }
    if (row.owner !== null || row.claim !== null) {
      return yield* Effect.fail(error("busy", `run ${options.runId} is not available for rewind`))
    }
    const expected = snapshotOf(row)
    const outcome = yield* runs.claim(options.runId, expected, options.owner, nowMs).pipe(
      Effect.mapError((cause) => runStoreFailure("claim run", cause))
    )
    if (outcome._tag === "NotFound") {
      return yield* Effect.fail(error("not_found", `run ${options.runId} was not found`))
    }
    if (outcome._tag !== "Claimed") {
      return yield* Effect.fail(error("busy", `run ${options.runId} lost the rewind claim`))
    }
    const activated = yield* runs.activate(
      options.runId,
      options.owner,
      outcome.claimedAtMs,
      expected
    ).pipe(
      Effect.mapError((cause) => runStoreFailure("activate rewind claim", cause))
    )
    if (activated._tag !== "Activated") {
      yield* Effect.ignore(runs.abandonClaim(options.runId, options.owner, outcome.claimedAtMs))
      return yield* Effect.fail(error("busy", `run ${options.runId} lost the rewind activation`))
    }
    return { row: rewindableRow, claimedAtMs: outcome.claimedAtMs }
  })

const runHook = (
  options: Options,
  step: RewindStep
): Effect.Effect<void, TimeTravelFailure> => {
  const hook = options.hooks?.beforeStep
  return hook === undefined
    ? Effect.void
    : hook(step).pipe(
      Effect.mapError((cause) => error("unknown", `rewind failed at ${step}`, cause))
    )
}

const terminal = (status: RunStore.RunStatus): boolean =>
  status === "completed" || status === "failed" || status === "cancelled"

const assessChildren = (
  runs: RunStore.Service,
  edges: ReadonlyArray<LineageEdge>,
  policy: DetachedChildPolicy
): Effect.Effect<{
  readonly warnings: ReadonlyArray<DetachedChildWarning>
  readonly cancellable: ReadonlyArray<ChildPlan>
}, TimeTravelFailure> =>
  Effect.gen(function*() {
    const warnings: Array<DetachedChildWarning> = []
    const cancellable: Array<ChildPlan> = []
    for (const edge of edges) {
      const child = yield* Effect.option(
        runs.get(edge.childRunId).pipe(
          Effect.mapError((cause) => runStoreFailure("read detached child", cause))
        )
      )
      if (child._tag === "None") {
        warnings.push({
          childRunId: edge.childRunId,
          parentSeq: edge.parentSeq,
          reason: "Detached child evidence is missing; the orphaned lineage edge remains disclosed."
        })
        continue
      }
      if (terminal(child.value.status)) {
        warnings.push({
          childRunId: edge.childRunId,
          parentSeq: edge.parentSeq,
          reason: `Terminal detached child ${edge.childRunId} survives as an orphaned lineage edge.`
        })
        continue
      }
      if (policy === "block") {
        return yield* Effect.fail(
          error("live_child", `live detached child ${edge.childRunId} blocks rewind`)
        )
      }
      cancellable.push({ edge, row: child.value })
    }
    return { warnings, cancellable }
  })

const cancelChild = (
  runs: RunStore.Service,
  options: Options,
  plan: ChildPlan
): Effect.Effect<void, TimeTravelFailure> =>
  Effect.gen(function*() {
    const nowMs = yield* Clock.currentTimeMillis
    const childOwner: OwnerId = {
      ...options.owner,
      nonce: `${options.owner.nonce}:rewind-child:${plan.edge.childRunId}`
    }
    const expected = snapshotOf(plan.row)
    const claim = plan.row.status === "running"
      ? yield* Effect.gen(function*() {
        if (options.childLivenessEvidence === undefined) {
          return yield* Effect.fail(
            error("live_child", `child ${plan.edge.childRunId} is running and has no cancellation evidence`)
          )
        }
        const evidence = yield* options.childLivenessEvidence(
          plan.edge.childRunId,
          plan.row,
          childOwner,
          nowMs
        )
        if (evidence === undefined) {
          return yield* Effect.fail(
            error("live_child", `child ${plan.edge.childRunId} is still live`)
          )
        }
        return yield* runs.steal(plan.edge.childRunId, expected, childOwner, nowMs, evidence).pipe(
          Effect.mapError((cause) => runStoreFailure("claim detached child", cause))
        )
      })
      : yield* runs.claim(plan.edge.childRunId, expected, childOwner, nowMs).pipe(
        Effect.mapError((cause) => runStoreFailure("claim detached child", cause))
      )

    if (claim._tag !== "Claimed") {
      return yield* Effect.fail(
        error("live_child", `could not claim detached child ${plan.edge.childRunId} for cancellation`)
      )
    }
    const activated = yield* runs.activate(
      plan.edge.childRunId,
      childOwner,
      claim.claimedAtMs,
      expected
    ).pipe(
      Effect.mapError((cause) => runStoreFailure("activate detached child", cause))
    )
    if (activated._tag !== "Activated") {
      yield* Effect.ignore(runs.abandonClaim(plan.edge.childRunId, childOwner, claim.claimedAtMs))
      return yield* Effect.fail(
        error("live_child", `detached child ${plan.edge.childRunId} lost its cancellation claim`)
      )
    }
    const cancelled = yield* runs.transitionOwned(
      plan.edge.childRunId,
      childOwner,
      "cancelled"
    ).pipe(
      Effect.mapError((cause) => runStoreFailure("cancel detached child", cause))
    )
    if (cancelled._tag !== "Transitioned") {
      return yield* Effect.fail(
        error("live_child", `detached child ${plan.edge.childRunId} lost its cancellation fence`)
      )
    }
  })

const toFailure = (cause: Cause.Cause<unknown>): TimeTravelFailure => {
  const squashed = Cause.squash(cause)
  return squashed instanceof TimeTravelError
    ? squashed
    : error("unknown", squashed instanceof Error ? squashed.message : String(squashed), cause)
}

const initialDetail = (
  originalStatus: "pending" | "suspended"
): AuditDetail => ({
  version: 1,
  phase: "audit_written",
  originalStatus,
  suffixCount: 0,
  warnings: [],
  cancelledChildren: []
})

/**
 * Rewinds a run through the single public ownership CAS.
 *
 * Handler resolution, cache checks, and detached-child classification all
 * complete before compensation starts. The child-inclusive archive/truncate
 * is the final journal mutation and its commit becomes the recovery commit
 * point; a crash after that point is completed by `Recovery`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const rewind = (
  options: Options
): Effect.Effect<
  Result,
  TimeTravelFailure,
  | CacheStore.CacheStore
  | EffectHandlerRegistry
  | Jj
  | Journal.Journal
  | RunStore.RunStore
  | TimeTravelStore
> =>
  Effect.fn("Rewind.rewind")(() =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({
        runId: options.runId,
        lineageId: options.frame.lineageId,
        seq: options.frame.seq
      })
      const runs = yield* RunStore.RunStore
      const journal = yield* Journal.Journal
      const store = yield* TimeTravelStore
      const nowMs = yield* Clock.currentTimeMillis
      const auditId = options.auditId ??
        `${options.runId}:rewind:${options.owner.nonce}:${nowMs}:${options.frame.seq}`

      let claimed: ClaimedRun | undefined
      let archiveCommitted = false
      let compensation: Compensation.Result = { handlerReceipts: [] }
      let detail: AuditDetail | undefined
      const cancelledChildren: Array<string> = []

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function*() {
          const protocol = restore(
            Effect.gen(function*() {
              claimed = yield* claimRun(runs, options, nowMs)
              const originalStatus = claimed.row.status

              const rateLimit = options.rateLimit?.({
                runId: options.runId,
                frame: options.frame,
                nowMs
              }) ?? Effect.succeed({ allowed: true } as const)
              const decision = yield* rateLimit
              const auditDetail = initialDetail(originalStatus)
              const audit: Audit = {
                id: auditId,
                runId: options.runId,
                frame: options.frame,
                status: "in_progress",
                rateLimit: "detail" in decision && decision.detail !== undefined
                  ? decision.detail
                  : { allowed: decision.allowed, checkedAtMs: nowMs },
                detail: auditDetail
              }
              yield* store.writeAudit(audit)
              detail = auditDetail

              yield* runHook(options, "claim-run")
              yield* runHook(options, "rate-limit")
              if (!decision.allowed) {
                return yield* Effect.fail(error("rate_limited", `rewind rate limit exceeded for ${options.runId}`))
              }
              yield* runHook(options, "write-audit")

              const snapshot = yield* store.snapshotAt(options.runId, options.frame)
              const descendants = yield* store.descendants(options.runId, options.frame)
              const suffix = yield* readSuffix(
                journal,
                options.runId,
                options.frame,
                options.pageSize ?? 100
              )
              const effects = yield* EffectBoundary.fromEntries(suffix)
              yield* runHook(options, "load-suffix")

              const childAssessment = yield* assessChildren(
                runs,
                descendants.detached,
                options.detachedChildPolicy ?? "block"
              )
              const plan = yield* Compensation.assess(effects, snapshot?.changeId)
              const blocking = plan.assessments.filter(
                (assessment) => assessment.classification === "blocking"
              )
              if (blocking.length > 0) {
                return yield* Effect.fail(
                  error("irreversible", `rewind is blocked by ${blocking.length} effect(s)`, blocking)
                )
              }
              detail = {
                ...detail,
                phase: "preflight_complete",
                suffixCount: suffix.length,
                ...(suffix.at(-1) === undefined ? {} : { suffixTailSeq: suffix.at(-1)!.seq }),
                ...(snapshot === undefined ? {} : { targetChangeId: snapshot.changeId }),
                warnings: childAssessment.warnings
              }
              yield* store.updateAudit(auditId, { detail })
              yield* runHook(options, "assess-boundary")

              const handlerReceipts = yield* Compensation.compensate(plan)
              compensation = { handlerReceipts }
              yield* runHook(options, "compensate-effects")

              compensation = yield* Compensation.restoreWorkspace(plan, handlerReceipts)
              yield* runHook(options, "restore-workspace")
              detail = {
                ...detail,
                phase: "compensated",
                compensation,
                cancelledChildren: [...cancelledChildren]
              }
              yield* store.updateAudit(auditId, { detail })

              yield* runHook(options, "archive-and-truncate")
              const archive = yield* store.archiveAndTruncate(
                options.runId,
                options.frame,
                Compensation.toStoreReceipts(auditId, compensation),
                // The rewind claimed and activated the run with this owner;
                // the store re-checks it at commit, so a superseded rewind
                // never truncates behind the live owner.
                options.owner
              )
              archiveCommitted = true
              detail = { ...detail, phase: "archive_committed" }
              yield* store.updateAudit(auditId, { detail })

              // Detached-child cancellation is terminal and has no inverse.
              // It therefore happens only after the archive commit point: a
              // failed pre-commit rewind leaves every child exactly as it was.
              for (
                const child of [...childAssessment.cancellable].sort(
                  (left, right) => right.edge.parentSeq - left.edge.parentSeq
                )
              ) {
                yield* cancelChild(runs, options, child)
                cancelledChildren.push(child.edge.childRunId)
                detail = { ...detail, cancelledChildren: [...cancelledChildren] }
                yield* store.updateAudit(auditId, { detail })
              }

              const suspended = yield* runs.transitionOwned(
                options.runId,
                options.owner,
                "suspended"
              ).pipe(
                Effect.mapError((cause) => runStoreFailure("suspend rewound run", cause))
              )
              if (suspended._tag !== "Transitioned") {
                return yield* Effect.fail(
                  error("busy", `run ${options.runId} lost ownership before suspension`)
                )
              }

              detail = { ...detail, phase: "completed" }
              yield* store.updateAudit(auditId, {
                status: "completed",
                detail
              })
              return {
                auditId,
                frame: options.frame,
                archive,
                assessments: plan.assessments,
                warnings: childAssessment.warnings,
                cancelledChildren: [...cancelledChildren]
              }
            })
          )

          const protocolExit = yield* Effect.exit(protocol)
          if (Exit.isSuccess(protocolExit)) return protocolExit.value
          const failure = toFailure(protocolExit.cause)

          if (!archiveCommitted) {
            const rollbackExit = yield* Effect.exit(Compensation.rollback(compensation))
            if (claimed !== undefined) {
              const restored = yield* runs.transitionOwned(
                options.runId,
                options.owner,
                claimed.row.status,
                claimed.row.stateJson
              ).pipe(
                Effect.mapError((cause) => runStoreFailure("restore run state", cause)),
                Effect.exit
              )
              if (Exit.isFailure(restored) && detail === undefined) {
                yield* Effect.ignore(runs.abandonClaim(options.runId, options.owner, claimed.claimedAtMs))
              }
            }
            if (detail !== undefined) {
              const currentDetail = detail
              const rollbackFailure = Exit.isFailure(rollbackExit) ? Cause.squash(rollbackExit.cause) : undefined
              const failureMessage = rollbackFailure === undefined
                ? failure.message
                : `${failure.message}; rollback failed: ${String(rollbackFailure)}`
              const { compensation: _, ...rolledBack } = currentDetail
              detail = {
                ...rolledBack,
                phase: rollbackFailure === undefined ? "rolled_back" : "terminal_failure",
                cancelledChildren: [...cancelledChildren],
                failure: failureMessage
              }
              yield* Effect.ignore(
                store.updateAudit(auditId, {
                  status: "failed",
                  detail
                })
              )
              if (Exit.isFailure(rollbackExit)) {
                return yield* Effect.fail(
                  error("compensation_failed", failureMessage, {
                    rewind: protocolExit.cause,
                    rollback: rollbackExit.cause
                  })
                )
              }
            }
          }

          // The protocol runs under `restore(...)` inside an uninterruptible
          // mask, so an interrupt lands as an interrupt-only cause on
          // `protocolExit` and the rollback above still runs to completion.
          // Squashing that cause through `toFailure` produced
          // `TimeTravelError{code:"unknown"}`, so a cancelled rewind reported
          // as a *failed* rewind: a caller racing `rewind` against a
          // supervisor observed a failure and kept running on the fiber it
          // believed it had cancelled. Cancellation is fiber interruption
          // (`CLAUDE.md`), so the cause is re-raised verbatim and an interrupt
          // stays an interrupt. A cause carrying any `Fail` or `Die` reason
          // still reports as the typed failure the callers match on.
          if (Cause.hasInterruptsOnly(protocolExit.cause)) {
            return yield* Effect.failCause(protocolExit.cause)
          }
          return yield* Effect.fail(failure)
        })
      )
    })
  )()
