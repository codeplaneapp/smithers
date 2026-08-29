/**
 * Fenced run persistence and ownership compare-and-swap operations.
 *
 * Governing design: `docs/specs/Concepts/Run Ownership.md`.
 * Schema boundary: `docs/specs/Research/Smithers Deviations 2026-07-28.md`.
 *
 * The two-phase snapshot/claim/activation CAS and heartbeat fence are adapted
 * from smithers `packages/db` and `packages/engine`.
 *
 * @since 0.1.0
 */
import { DurableWriter, fromSqlError } from "@smthrs/database/DurableWriter"
import type { OwnerId } from "@smthrs/journal/OwnerId"
import { Cause, Clock, Context, Duration, Effect, Layer, Metric, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as SqlError from "effect/unstable/sql/SqlError"
import { heartbeatStaleAfter } from "./Heartbeat.ts"
import type { LivenessEvidence } from "./Ownership.ts"
import * as RunStoreMetrics from "./RunStoreMetrics.ts"

/** JSON text carrying an arbitrary decoded value. */
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown)

/**
 * Stable run states understood by the durability layer.
 *
 * @since 0.1.0
 * @category models
 */
export const RunStatus = Schema.Literals([
  "pending",
  "running",
  "suspended",
  "completed",
  "failed",
  "cancelled"
])

/**
 * A stable run state.
 *
 * @since 0.1.0
 * @category models
 */
export type RunStatus = typeof RunStatus.Type

/**
 * Stable failure codes surfaced by `RunStore`.
 *
 * @since 0.1.0
 * @category errors
 */
export const RunStoreErrorCode = Schema.Literals([
  "invalid_run",
  "not_found_row",
  "constraint",
  "decode_failed",
  "persistence_failed",
  "unknown"
])

/**
 * A stable `RunStore` failure code.
 *
 * @since 0.1.0
 * @category errors
 */
export type RunStoreErrorCode = typeof RunStoreErrorCode.Type

/**
 * A normalized run persistence failure.
 *
 * Compare-and-swap competition is represented by successful outcome values,
 * never by this error channel.
 *
 * The identity string equals the defining module path, like every other
 * identity in this repository.
 *
 * @since 0.1.0
 * @category errors
 */
export class RunStoreError extends Schema.TaggedError<RunStoreError>()("@smthrs/run-store/RunStoreError", {
  code: RunStoreErrorCode,
  method: Schema.String,
  message: Schema.String,
  cause: Schema.Unknown
}) {}

/**
 * The exact persisted fields guarded by a claim and its later activation.
 *
 * @since 0.1.0
 * @category models
 */
export interface RunSnapshot {
  readonly status: RunStatus
  readonly owner: OwnerId | null
  readonly heartbeatAtMs: number | null
}

/**
 * A decoded row in `flows_runs`.
 *
 * @since 0.1.0
 * @category models
 */
export interface RunRow extends RunSnapshot {
  readonly runId: string
  readonly createdAtMs: number
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
  readonly claim: OwnerId | null
  readonly claimedAtMs: number | null
  readonly parentRunId: string | null
  readonly cancelRequestedAtMs: number | null
  /**
   * The trampoline lineage this run is a round of, and which round it is
   * (`docs/specs/Concepts/Trampoline Loops.md`). `null` on every run that is
   * not part of a lineage, which reads as round 0 of a lineage of one.
   *
   * Optional on the interface so a caller that builds a `RunRow` by hand —
   * a time-travel fixture, a recovery double — keeps compiling: the pair was
   * added by an append-only migration, and every reader must already tolerate
   * a row written before it.
   */
  readonly lineageId?: string | null | undefined
  readonly roundOrdinal?: number | null | undefined
  readonly stateJson: string
}

/**
 * Metadata recorded when a run row is created.
 *
 * `parentRunId` is the ancestry edge a fork, rewind, child, or later
 * trampoline round carries. It is a column rather than a `state_json` field
 * because ancestry is walked in SQL.
 *
 * `lineageId` and `roundOrdinal` are the trampoline pair
 * (`docs/specs/Concepts/Trampoline Loops.md`): which lineage a run is a round
 * of, and which round. Both absent — the ordinary case — means the run is a
 * lineage of one, and is read back as round 0 of itself.
 *
 * @since 0.1.0
 * @category models
 */
export interface CreateOptions {
  readonly parentRunId?: string | undefined
  readonly lineageId?: string | undefined
  readonly roundOrdinal?: number | undefined
}

/**
 * An extra compare-and-swap predicate over first-class run metadata.
 *
 * A guard is the seam for lifecycle rules a harness must enforce atomically —
 * `{ cancelRequested: "absent" }` is the "do not finalize a run someone asked
 * to cancel" rule, expressed as SQL rather than as a read-then-write race.
 *
 * @since 0.1.0
 * @category models
 */
export interface TransitionGuard {
  readonly cancelRequested?: "absent" | "present" | undefined
}

/**
 * Result of recording a cancellation request.
 *
 * The request is deliberately unfenced: any observer may ask, and the owner
 * decides. `requestedAtMs` is the winning request, so a repeat request reports
 * the original time rather than overwriting it.
 *
 * @since 0.1.0
 * @category models
 */
export type RequestCancelOutcome =
  | { readonly _tag: "CancelRequested"; readonly requestedAtMs: number }
  | { readonly _tag: "AlreadyRequested"; readonly requestedAtMs: number }
  | { readonly _tag: "NotFound" }

/**
 * Result of acquiring claim columns for a later activation.
 *
 * @since 0.1.0
 * @category models
 */
export type ClaimOutcome =
  | { readonly _tag: "Claimed"; readonly claimedAtMs: number }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "AlreadyClaimed" }
  | { readonly _tag: "HeartbeatFresh" }
  | { readonly _tag: "SnapshotChanged" }

/**
 * Result of claiming and activating ownership in one compare-and-swap.
 *
 * @since 0.1.0
 * @category models
 */
export type ClaimAndOwnOutcome =
  | { readonly _tag: "Activated" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "AlreadyClaimed" }
  | { readonly _tag: "HeartbeatFresh" }
  | { readonly _tag: "SnapshotChanged" }
  /**
   * The caller expected a running run owned by someone else and supplied no
   * matching `LivenessEvidence`, so it was refused before any compare-and-swap
   * ran. Re-reading and retrying cannot make progress; supply evidence, or use
   * `steal`. This replaces the `SnapshotChanged` this path used to report,
   * which asserted a comparison it never performed.
   */
  | { readonly _tag: "EvidenceRequired" }

type ClaimLossOutcome = Exclude<ClaimOutcome, { readonly _tag: "Claimed" }>

/**
 * Result of activating a held claim.
 *
 * @since 0.1.0
 * @category models
 */
export type ActivateOutcome =
  | { readonly _tag: "Activated" }
  | { readonly _tag: "ClaimLost" }
  | { readonly _tag: "SnapshotChanged" }

/**
 * Result of clearing a held claim.
 *
 * @since 0.1.0
 * @category models
 */
export type AbandonClaimOutcome =
  | { readonly _tag: "Abandoned" }
  | { readonly _tag: "ClaimLost" }

/**
 * Result of clearing an exact stale claim after its claimant was proven dead.
 *
 * @since 0.1.0
 * @category models
 */
export type RecoverClaimOutcome =
  | { readonly _tag: "Recovered" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "ClaimFresh" }
  | { readonly _tag: "ClaimChanged" }
  | { readonly _tag: "LivenessUnconfirmed" }

/**
 * Result of a fenced ownership heartbeat.
 *
 * @since 0.1.0
 * @category models
 */
export type HeartbeatOutcome =
  | { readonly _tag: "Updated" }
  | { readonly _tag: "FenceLost" }
  | { readonly _tag: "NotFound" }

/**
 * Result of a fenced owned transition.
 *
 * @since 0.1.0
 * @category models
 */
export type TransitionOutcome =
  | { readonly _tag: "Transitioned" }
  | { readonly _tag: "FenceLost" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "GuardFailed" }

/**
 * Fenced persistence operations for durable runs.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  readonly create: (
    runId: string,
    stateJson: string,
    options?: CreateOptions | undefined
  ) => Effect.Effect<void, RunStoreError>
  readonly get: (runId: string) => Effect.Effect<RunRow, RunStoreError>
  /** Records an unfenced cancellation request that later guarded transitions observe. */
  readonly requestCancel: (runId: string, nowMs: number) => Effect.Effect<RequestCancelOutcome, RunStoreError>
  readonly claim: (
    runId: string,
    expected: RunSnapshot,
    claimant: OwnerId,
    nowMs: number
  ) => Effect.Effect<ClaimOutcome, RunStoreError>
  /**
   * Claims and activates an exact snapshot atomically under the supplied owner.
   * Replacing a different running owner also requires matching liveness evidence.
   */
  readonly claimAndOwn: (
    runId: string,
    expected: RunSnapshot,
    owner: OwnerId,
    nowMs: number,
    evidence?: LivenessEvidence | undefined
  ) => Effect.Effect<ClaimAndOwnOutcome, RunStoreError>
  readonly activate: (
    runId: string,
    claimant: OwnerId,
    claimedAtMs: number,
    expected: RunSnapshot
  ) => Effect.Effect<ActivateOutcome, RunStoreError>
  readonly abandonClaim: (
    runId: string,
    claimant: OwnerId,
    claimedAtMs: number
  ) => Effect.Effect<AbandonClaimOutcome, RunStoreError>
  readonly recoverClaim: (
    runId: string,
    staleClaimant: OwnerId,
    claimedAtMs: number,
    observer: OwnerId,
    nowMs: number,
    evidence: LivenessEvidence
  ) => Effect.Effect<RecoverClaimOutcome, RunStoreError>
  readonly heartbeat: (
    runId: string,
    owner: OwnerId,
    nowMs: number
  ) => Effect.Effect<HeartbeatOutcome, RunStoreError>
  readonly transitionOwned: (
    runId: string,
    owner: OwnerId,
    toStatus: RunStatus,
    stateJson?: string | undefined,
    guard?: TransitionGuard | undefined
  ) => Effect.Effect<TransitionOutcome, RunStoreError>
  readonly steal: (
    runId: string,
    expected: RunSnapshot,
    claimant: OwnerId,
    nowMs: number,
    evidence: LivenessEvidence
  ) => Effect.Effect<ClaimOutcome, RunStoreError>
}

/**
 * Service tag for fenced run persistence.
 *
 * The identity string equals the defining module path, like every other
 * service identity in this repository. The pre-split `flows/journal/RunStore`
 * identity from `docs/specs/Concepts/Journal Split.md` was retired pre-release,
 * while no persisted journal or step-key digest named it.
 *
 * @since 0.1.0
 * @category services
 */
export class RunStore extends Context.Service<RunStore, Service>()("@smthrs/run-store/RunStore") {}

const claimed = (claimedAtMs: number): ClaimOutcome => ({ _tag: "Claimed", claimedAtMs })
const notFound = { _tag: "NotFound" } as const
const alreadyClaimed = { _tag: "AlreadyClaimed" } as const
const heartbeatFresh = { _tag: "HeartbeatFresh" } as const
const snapshotChanged = { _tag: "SnapshotChanged" } as const
const evidenceRequired = { _tag: "EvidenceRequired" } as const
const activated = { _tag: "Activated" } as const
const claimLost = { _tag: "ClaimLost" } as const
const abandoned = { _tag: "Abandoned" } as const
const recovered = { _tag: "Recovered" } as const
const claimFresh = { _tag: "ClaimFresh" } as const
const claimChanged = { _tag: "ClaimChanged" } as const
const livenessUnconfirmed = { _tag: "LivenessUnconfirmed" } as const
const updated = { _tag: "Updated" } as const
const fenceLost = { _tag: "FenceLost" } as const
const transitioned = { _tag: "Transitioned" } as const
const guardFailed = { _tag: "GuardFailed" } as const

/** Rewrites an outcome tag (`HeartbeatFresh`) as a span attribute value (`heartbeat_fresh`). */
const outcomeValue = (tag: string): string => tag.replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_").toLowerCase()

/** Classifies a non-success exit for the span `outcome` attribute. */
const causeOutcome = <E>(cause: Cause.Cause<E>): "failure" | "interrupt" =>
  Cause.hasInterruptsOnly(cause) ? "interrupt" : "failure"

/**
 * Observes a store operation's exit onto its span, and — when the operation
 * has an outcome-keyed counter — updates it in the same observation: the
 * domain tag (`claimed`, `fence_lost`) on success, `failure` or `interrupt`
 * otherwise, so a span never closes without saying how. `Effect.onExit` only
 * reads the exit; the value, cause, and interruption propagate
 * byte-identically.
 */
const observeOutcome = <A extends { readonly _tag: string }>(
  metricOf?: ((outcome: A) => Metric.Metric<number, Metric.CounterState<number>>) | undefined
) =>
<E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.onExit((exit) =>
      exit._tag === "Success"
        ? Effect.annotateCurrentSpan({ outcome: outcomeValue(exit.value._tag) }).pipe(
          Effect.andThen(metricOf === undefined ? Effect.void : Metric.update(metricOf(exit.value), 1))
        )
        : Effect.annotateCurrentSpan({ outcome: causeOutcome(exit.cause) })
    )
  )

/**
 * `observeOutcome` for operations whose success carries no domain outcome
 * tag — `create` inserts or fails, `get` returns the row or fails — so the
 * span still closes with `success`, `failure`, or `interrupt`.
 */
const observeExit = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.onExit((exit) =>
      Effect.annotateCurrentSpan({
        outcome: exit._tag === "Success" ? "success" : causeOutcome(exit.cause)
      })
    )
  )

/**
 * The staleness cutoff in milliseconds, derived from the one definition rather
 * than restated. `Ownership` imports `RunStore`, so the shared constants live
 * in the `Heartbeat` leaf both can reach.
 */
const heartbeatStaleAfterMs = Duration.toMillis(heartbeatStaleAfter)
const terminalStatuses: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"])

const DatabaseRunRow = Schema.Struct({
  runId: Schema.String,
  status: RunStatus,
  createdAtMs: Schema.Number,
  startedAtMs: Schema.NullOr(Schema.Number),
  finishedAtMs: Schema.NullOr(Schema.Number),
  ownerHostId: Schema.NullOr(Schema.String),
  ownerPid: Schema.NullOr(Schema.Number),
  ownerNonce: Schema.NullOr(Schema.String),
  heartbeatAtMs: Schema.NullOr(Schema.Number),
  claimHostId: Schema.NullOr(Schema.String),
  claimPid: Schema.NullOr(Schema.Number),
  claimNonce: Schema.NullOr(Schema.String),
  claimedAtMs: Schema.NullOr(Schema.Number),
  parentRunId: Schema.NullOr(Schema.String),
  cancelRequestedAtMs: Schema.NullOr(Schema.Number),
  lineageId: Schema.NullOr(Schema.String),
  roundOrdinal: Schema.NullOr(Schema.Number),
  stateJson: Schema.String
})

type DatabaseRunRow = typeof DatabaseRunRow.Type

const runStoreError = (
  method: string,
  code: RunStoreErrorCode,
  message: string,
  cause: unknown
): RunStoreError =>
  new RunStoreError({
    code,
    method,
    message: `${code}: RunStore.${method}: ${message}`,
    cause
  })

const persistenceError = (method: string, cause: unknown): RunStoreError => {
  const code = typeof cause === "object" && cause !== null && "code" in cause && cause.code === "constraint"
    ? "constraint"
    : "persistence_failed"
  return runStoreError(method, code, "database operation failed", cause)
}

const invalidRunError = (method: string, cause: unknown): RunStoreError =>
  runStoreError(method, "invalid_run", "run input is invalid", cause)

const isJsonString = (value: string): boolean =>
  Schema.decodeUnknownResult(UnknownFromJsonString)(value)._tag === "Success"

const ownerFromColumns = (
  hostId: string | null,
  pid: number | null,
  nonce: string | null
): OwnerId | null | undefined => {
  if (hostId === null && pid === null && nonce === null) return null
  if (hostId !== null && pid !== null && nonce !== null) return { hostId, pid, nonce }
  return undefined
}

const sameOwner = (left: OwnerId, right: OwnerId): boolean =>
  left.hostId === right.hostId && left.pid === right.pid && left.nonce === right.nonce

const rowMatchesClaim = (row: DatabaseRunRow, claimant: OwnerId, claimedAtMs: number): boolean =>
  row.claimHostId === claimant.hostId &&
  row.claimPid === claimant.pid &&
  row.claimNonce === claimant.nonce &&
  row.claimedAtMs === claimedAtMs

const decodeRunRow = (method: string, input: unknown): Effect.Effect<RunRow, RunStoreError> =>
  Schema.decodeUnknownEffect(DatabaseRunRow)(input).pipe(
    Effect.mapError((cause) => runStoreError(method, "decode_failed", "could not decode flows_runs row", cause)),
    Effect.flatMap((row) => {
      const owner = ownerFromColumns(row.ownerHostId, row.ownerPid, row.ownerNonce)
      const claim = ownerFromColumns(row.claimHostId, row.claimPid, row.claimNonce)
      const invalidOwner = owner === undefined ||
        (owner === null && row.heartbeatAtMs !== null) ||
        (owner !== null && row.heartbeatAtMs === null) ||
        (row.status === "running" ? owner === null : owner !== null)
      const invalidClaim = claim === undefined ||
        (claim === null && row.claimedAtMs !== null) ||
        (claim !== null && row.claimedAtMs === null)
      if (invalidOwner || invalidClaim || !isJsonString(row.stateJson)) {
        return Effect.fail(
          runStoreError(method, "decode_failed", "flows_runs row violates ownership invariants", row)
        )
      }
      return Effect.succeed({
        runId: row.runId,
        status: row.status,
        createdAtMs: row.createdAtMs,
        startedAtMs: row.startedAtMs,
        finishedAtMs: row.finishedAtMs,
        owner,
        heartbeatAtMs: row.heartbeatAtMs,
        claim,
        claimedAtMs: row.claimedAtMs,
        parentRunId: row.parentRunId,
        cancelRequestedAtMs: row.cancelRequestedAtMs,
        lineageId: row.lineageId,
        roundOrdinal: row.roundOrdinal,
        stateJson: row.stateJson
      })
    })
  )

const selectRun = (sql: SqlClient.SqlClient, runId: string) =>
  sql<DatabaseRunRow>`
    SELECT
      run_id AS "runId",
      status AS "status",
      created_at_ms AS "createdAtMs",
      started_at_ms AS "startedAtMs",
      finished_at_ms AS "finishedAtMs",
      owner_host_id AS "ownerHostId",
      owner_pid AS "ownerPid",
      owner_nonce AS "ownerNonce",
      heartbeat_at_ms AS "heartbeatAtMs",
      claim_host_id AS "claimHostId",
      claim_pid AS "claimPid",
      claim_nonce AS "claimNonce",
      claimed_at_ms AS "claimedAtMs",
      parent_run_id AS "parentRunId",
      cancel_requested_at_ms AS "cancelRequestedAtMs",
      lineage_id AS "lineageId",
      round_ordinal AS "roundOrdinal",
      state_json AS "stateJson"
    FROM flows_runs
    WHERE run_id = ${runId}
  `

const classifyClaimLoss = (
  row: DatabaseRunRow | undefined,
  nowMs: number
): ClaimLossOutcome => {
  if (row === undefined) return notFound
  if (row.claimHostId !== null) return alreadyClaimed
  if (
    row.status === "running" &&
    row.heartbeatAtMs !== null &&
    row.heartbeatAtMs >= nowMs - heartbeatStaleAfterMs
  ) {
    return heartbeatFresh
  }
  return snapshotChanged
}

const evidenceMatches = (
  expected: RunSnapshot,
  claimant: OwnerId,
  nowMs: number,
  evidence: LivenessEvidence
): boolean =>
  expected.status === "running" &&
  expected.owner !== null &&
  evidenceMatchesOwner(expected.owner, claimant, nowMs, evidence)

const evidenceMatchesOwner = (
  expectedOwner: OwnerId,
  observer: OwnerId,
  nowMs: number,
  evidence: LivenessEvidence
): boolean => {
  if (!sameOwner(expectedOwner, evidence.expectedOwner) || evidence.checkedAtMs !== nowMs) return false
  return evidence.kind === "same-host-pid-dead"
    ? expectedOwner.hostId === observer.hostId
    : expectedOwner.hostId !== observer.hostId
}

/**
 * Constructs the production `RunStore` implementation.
 *
 * `state_json` is executable state: it is decoded and re-entered on every
 * resume, so it is persisted and returned byte-for-byte. Nothing rewrites it
 * on the way through — a redactor here would silently change what the flow
 * re-reads (issue #72). Credential hygiene is an observability concern and
 * lives on the journal-event and export surfaces; a value that must never be
 * persisted at all is a `Redacted` field in the caller's state schema.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make: Effect.Effect<Service, never, DurableWriter | SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter

  const write = <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, RunStoreError, R> =>
    writer.write(effect).pipe(Effect.mapError((cause) => persistenceError(method, cause)))

  // A bare SELECT needs no write transaction and no replay; only the error
  // vocabulary stays shared with `write`.
  const read = <A, R>(
    method: string,
    effect: Effect.Effect<A, SqlError.SqlError, R>
  ): Effect.Effect<A, RunStoreError, R> =>
    effect.pipe(Effect.mapError((cause) => persistenceError(method, fromSqlError(cause))))

  const create = Effect.fn("RunStore.create")(
    (runId: string, stateJson: string, options?: CreateOptions | undefined): Effect.Effect<void, RunStoreError> =>
      Effect.annotateCurrentSpan({ runId }).pipe(
        Effect.andThen(Effect.suspend(() => {
          const parentRunId = options?.parentRunId ?? null
          const lineageId = options?.lineageId ?? null
          const roundOrdinal = options?.roundOrdinal ?? null
          const invalidLineage = (lineageId === null) !== (roundOrdinal === null) ||
            (lineageId !== null && lineageId.length === 0) ||
            (roundOrdinal !== null && (!Number.isSafeInteger(roundOrdinal) || roundOrdinal < 0))
          if (
            runId.length === 0 ||
            !isJsonString(stateJson) ||
            parentRunId?.length === 0 ||
            invalidLineage
          ) {
            return Effect.fail(
              invalidRunError("create", { runId, stateJson, parentRunId, lineageId, roundOrdinal })
            )
          }
          return Clock.currentTimeMillis.pipe(
            Effect.flatMap((createdAtMs) =>
              write(
                "create",
                sql`
            INSERT INTO flows_runs (
              run_id,
              status,
              created_at_ms,
              started_at_ms,
              finished_at_ms,
              owner_host_id,
              owner_pid,
              owner_nonce,
              heartbeat_at_ms,
              claim_host_id,
              claim_pid,
              claim_nonce,
              claimed_at_ms,
              parent_run_id,
              lineage_id,
              round_ordinal,
              state_json
            ) VALUES (
              ${runId},
              'pending',
              ${createdAtMs},
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              ${parentRunId},
              ${lineageId},
              ${roundOrdinal},
              ${stateJson}
            )
          `.pipe(Effect.asVoid)
              )
            )
          )
        })),
        observeExit
      )
  )

  const get = Effect.fn("RunStore.get")((runId: string): Effect.Effect<RunRow, RunStoreError> =>
    Effect.annotateCurrentSpan({ runId }).pipe(
      Effect.andThen(
        read("get", selectRun(sql, runId)).pipe(
          Effect.flatMap((rows) =>
            rows[0] === undefined
              ? Effect.fail(runStoreError("get", "not_found_row", `run ${runId} was not found`, runId))
              : decodeRunRow("get", rows[0])
          )
        )
      ),
      observeExit
    )
  )

  const requestCancel = Effect.fn("RunStore.requestCancel")((
    runId: string,
    nowMs: number
  ): Effect.Effect<RequestCancelOutcome, RunStoreError> =>
    Effect.annotateCurrentSpan({ runId }).pipe(
      Effect.andThen(Effect.suspend(() => {
        if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
          return Effect.fail(invalidRunError("requestCancel", { runId, nowMs }))
        }
        return write(
          "requestCancel",
          Effect.gen(function*() {
            const record = () =>
              sql<{ readonly requestedAtMs: number }>`
          UPDATE flows_runs
          SET cancel_requested_at_ms = ${nowMs}
          WHERE run_id = ${runId}
            AND cancel_requested_at_ms IS NULL
          RETURNING cancel_requested_at_ms AS "requestedAtMs"
        `
            const rows = yield* record()
            if (rows[0] !== undefined) {
              return { _tag: "CancelRequested", requestedAtMs: Number(rows[0].requestedAtMs) } as const
            }
            const current = yield* sql<{ readonly requestedAtMs: number | null }>`
          SELECT cancel_requested_at_ms AS "requestedAtMs" FROM flows_runs WHERE run_id = ${runId}
        `
            const row = current[0]
            if (row === undefined) {
              return notFound
            }
            if (row.requestedAtMs !== null) {
              return { _tag: "AlreadyRequested", requestedAtMs: Number(row.requestedAtMs) } as const
            }
            // The row is present and the column is NULL. `row === undefined` and
            // `requestedAtMs === null` used to collapse into one `== null` test, so
            // a writer on another connection clearing the column between the UPDATE
            // and this read made a live run report `NotFound` — and the caller
            // skipped the retry it performs for a genuine race. The UPDATE's own
            // precondition holds again, so re-run it. Only a row that is really
            // gone reports `NotFound`.
            const retried = yield* record()
            const recorded = retried[0]
            return recorded === undefined
              ? notFound
              : { _tag: "CancelRequested", requestedAtMs: Number(recorded.requestedAtMs) } as const
          })
        )
      })),
      observeOutcome<RequestCancelOutcome>()
    )
  )

  const claim = Effect.fn("RunStore.claim")((
    runId: string,
    expected: RunSnapshot,
    claimant: OwnerId,
    nowMs: number
  ): Effect.Effect<ClaimOutcome, RunStoreError> =>
    Effect.annotateCurrentSpan({ runId, claimantHostId: claimant.hostId }).pipe(
      Effect.andThen(
        write(
          "claim",
          Effect.gen(function*() {
            // `claim` never admits a running run, so it needs no staleness
            // disjunction. `status IN ('pending', 'suspended')` already excludes
            // 'running', which made the preceding `status <> 'running'` redundant
            // and the trailing `(status <> 'running' OR heartbeat IS NULL OR
            // heartbeat < cutoff)` a tautology — its first branch was already
            // known true. `claimAndOwn` is the method that genuinely needs the
            // staleness test, because it does admit 'running'.
            const rows = yield* sql<{ readonly runId: string }>`
          UPDATE flows_runs
          SET
            claim_host_id = ${claimant.hostId},
            claim_pid = ${claimant.pid},
            claim_nonce = ${claimant.nonce},
            claimed_at_ms = ${nowMs}
          WHERE run_id = ${runId}
            AND status IN ('pending', 'suspended')
            AND status = ${expected.status}
            AND owner_host_id IS ${expected.owner?.hostId ?? null}
            AND owner_pid IS ${expected.owner?.pid ?? null}
            AND owner_nonce IS ${expected.owner?.nonce ?? null}
            AND heartbeat_at_ms IS ${expected.heartbeatAtMs}
            AND claim_host_id IS NULL
            AND claim_pid IS NULL
            AND claim_nonce IS NULL
            AND claimed_at_ms IS NULL
          RETURNING run_id AS "runId"
        `
            if (rows.length > 0) return claimed(nowMs)
            const current = yield* selectRun(sql, runId)
            return classifyClaimLoss(current[0], nowMs)
          })
        )
      ),
      observeOutcome((outcome) => RunStoreMetrics.claim[outcome._tag])
    )
  )

  const claimAndOwn = Effect.fn("RunStore.claimAndOwn")((
    runId: string,
    expected: RunSnapshot,
    owner: OwnerId,
    nowMs: number,
    evidence?: LivenessEvidence | undefined
  ): Effect.Effect<ClaimAndOwnOutcome, RunStoreError> =>
    Effect.annotateCurrentSpan({ runId, ownerHostId: owner.hostId }).pipe(
      Effect.andThen(Effect.suspend((): Effect.Effect<ClaimAndOwnOutcome, RunStoreError> => {
        const canReplaceExpectedOwner = expected.status !== "running" ||
          (expected.owner !== null && sameOwner(expected.owner, owner)) ||
          (evidence !== undefined && evidenceMatches(expected, owner, nowMs, evidence))

        if (!canReplaceExpectedOwner) {
          return read("claimAndOwn", selectRun(sql, runId)).pipe(
            Effect.map((current) => {
              const loss = classifyClaimLoss(current[0], nowMs)
              // No CAS ran on this path — the caller expected a running run owned
              // by someone else and supplied no matching evidence, so it was
              // refused before the write. `SnapshotChanged` therefore asserts
              // something this branch never tested, and it is the one classification
              // that misdirects: a recovery sweeper told its snapshot was wrong
              // re-reads, gets the identical snapshot, and calls again, livelocking
              // on a run that is genuinely recoverable. The other three still
              // describe the row itself and are reported unchanged.
              return loss === snapshotChanged ? evidenceRequired : loss
            })
          )
        }

        return write(
          "claimAndOwn",
          Effect.gen(function*() {
            const rows = yield* sql<{ readonly runId: string }>`
          UPDATE flows_runs
          SET
            status = 'running',
            started_at_ms = COALESCE(started_at_ms, ${nowMs}),
            finished_at_ms = NULL,
            owner_host_id = ${owner.hostId},
            owner_pid = ${owner.pid},
            owner_nonce = ${owner.nonce},
            heartbeat_at_ms = ${nowMs}
          WHERE run_id = ${runId}
            AND status IN ('pending', 'suspended', 'running')
            AND status = ${expected.status}
            AND owner_host_id IS ${expected.owner?.hostId ?? null}
            AND owner_pid IS ${expected.owner?.pid ?? null}
            AND owner_nonce IS ${expected.owner?.nonce ?? null}
            AND heartbeat_at_ms IS ${expected.heartbeatAtMs}
            AND claim_host_id IS NULL
            AND claim_pid IS NULL
            AND claim_nonce IS NULL
            AND claimed_at_ms IS NULL
            AND (
              status <> 'running'
              OR heartbeat_at_ms IS NULL
              OR heartbeat_at_ms < ${nowMs - heartbeatStaleAfterMs}
            )
          RETURNING run_id AS "runId"
        `
            if (rows.length > 0) return activated
            const current = yield* selectRun(sql, runId)
            return classifyClaimLoss(current[0], nowMs)
          })
        )
      })),
      observeOutcome((outcome) => RunStoreMetrics.claimAndOwn[outcome._tag])
    )
  )

  const activate = Effect.fn("RunStore.activate")((
    runId: string,
    claimant: OwnerId,
    claimedAtMs: number,
    expected: RunSnapshot
  ): Effect.Effect<ActivateOutcome, RunStoreError> =>
    Effect.annotateCurrentSpan({ runId, claimantHostId: claimant.hostId }).pipe(
      Effect.andThen(
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((activatedAtMs) =>
            write(
              "activate",
              Effect.gen(function*() {
                const rows = yield* sql<{ readonly runId: string }>`
              UPDATE flows_runs
              SET
                status = 'running',
                started_at_ms = COALESCE(started_at_ms, ${activatedAtMs}),
                finished_at_ms = NULL,
                owner_host_id = ${claimant.hostId},
                owner_pid = ${claimant.pid},
                owner_nonce = ${claimant.nonce},
                heartbeat_at_ms = ${activatedAtMs},
                claim_host_id = NULL,
                claim_pid = NULL,
                claim_nonce = NULL,
                claimed_at_ms = NULL
              WHERE run_id = ${runId}
                AND status = ${expected.status}
                AND owner_host_id IS ${expected.owner?.hostId ?? null}
                AND owner_pid IS ${expected.owner?.pid ?? null}
                AND owner_nonce IS ${expected.owner?.nonce ?? null}
                AND heartbeat_at_ms IS ${expected.heartbeatAtMs}
                AND claim_host_id = ${claimant.hostId}
                AND claim_pid = ${claimant.pid}
                AND claim_nonce = ${claimant.nonce}
                AND claimed_at_ms = ${claimedAtMs}
              RETURNING run_id AS "runId"
            `
                if (rows.length > 0) return activated

                const current = yield* selectRun(sql, runId)
                if (current[0] === undefined || !rowMatchesClaim(current[0], claimant, claimedAtMs)) return claimLost

                yield* sql`
              UPDATE flows_runs
              SET
                claim_host_id = NULL,
                claim_pid = NULL,
                claim_nonce = NULL,
                claimed_at_ms = NULL
              WHERE run_id = ${runId}
                AND claim_host_id = ${claimant.hostId}
                AND claim_pid = ${claimant.pid}
                AND claim_nonce = ${claimant.nonce}
                AND claimed_at_ms = ${claimedAtMs}
            `
                return snapshotChanged
              })
            )
          )
        )
      ),
      observeOutcome((outcome) => RunStoreMetrics.activate[outcome._tag])
    )
  )

  const abandonClaim = Effect.fn("RunStore.abandonClaim")((
    runId: string,
    claimant: OwnerId,
    claimedAtMs: number
  ): Effect.Effect<AbandonClaimOutcome, RunStoreError> =>
    Effect.annotateCurrentSpan({ runId, claimantHostId: claimant.hostId }).pipe(
      Effect.andThen(write(
        "abandonClaim",
        Effect.map(
          sql<{ readonly runId: string }>`
          UPDATE flows_runs
          SET
            claim_host_id = NULL,
            claim_pid = NULL,
            claim_nonce = NULL,
            claimed_at_ms = NULL
          WHERE run_id = ${runId}
            AND claim_host_id = ${claimant.hostId}
            AND claim_pid = ${claimant.pid}
            AND claim_nonce = ${claimant.nonce}
            AND claimed_at_ms = ${claimedAtMs}
          RETURNING run_id AS "runId"
        `,
          (rows) => rows.length > 0 ? abandoned : claimLost
        )
      )),
      observeOutcome<AbandonClaimOutcome>()
    )
  )

  const recoverClaim = Effect.fn("RunStore.recoverClaim")((
    runId: string,
    staleClaimant: OwnerId,
    claimedAtMs: number,
    observer: OwnerId,
    nowMs: number,
    evidence: LivenessEvidence
  ): Effect.Effect<RecoverClaimOutcome, RunStoreError> =>
    Effect.annotateCurrentSpan({ runId, observerHostId: observer.hostId }).pipe(
      Effect.andThen(Effect.suspend((): Effect.Effect<RecoverClaimOutcome, RunStoreError> => {
        if (!evidenceMatchesOwner(staleClaimant, observer, nowMs, evidence)) {
          return Effect.succeed(livenessUnconfirmed)
        }
        return write(
          "recoverClaim",
          Effect.gen(function*() {
            const rows = yield* sql<{ readonly runId: string }>`
          UPDATE flows_runs
          SET
            claim_host_id = NULL,
            claim_pid = NULL,
            claim_nonce = NULL,
            claimed_at_ms = NULL
          WHERE run_id = ${runId}
            AND claim_host_id = ${staleClaimant.hostId}
            AND claim_pid = ${staleClaimant.pid}
            AND claim_nonce = ${staleClaimant.nonce}
            AND claimed_at_ms = ${claimedAtMs}
            AND claimed_at_ms < ${nowMs - heartbeatStaleAfterMs}
          RETURNING run_id AS "runId"
        `
            if (rows.length > 0) return recovered
            const current = yield* selectRun(sql, runId)
            if (current[0] === undefined) return notFound
            return rowMatchesClaim(current[0], staleClaimant, claimedAtMs) &&
                claimedAtMs >= nowMs - heartbeatStaleAfterMs
              ? claimFresh
              : claimChanged
          })
        )
      })),
      observeOutcome<RecoverClaimOutcome>()
    )
  )

  const heartbeat = Effect.fn("RunStore.heartbeat")((
    runId: string,
    owner: OwnerId,
    nowMs: number
  ): Effect.Effect<HeartbeatOutcome, RunStoreError> =>
    Effect.annotateCurrentSpan({ runId, ownerHostId: owner.hostId }).pipe(
      Effect.andThen(Effect.suspend(() => {
        // Validated before the write because the monotonic MAX below would
        // otherwise silently absorb a negative or non-integer timestamp
        // instead of letting the column CHECK reject it.
        if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
          return Effect.fail(invalidRunError("heartbeat", { runId, nowMs }))
        }
        return write(
          "heartbeat",
          Effect.gen(function*() {
            // The lease timestamp is monotonic: MAX() keeps a heartbeat that
            // arrives late — delayed past a newer one from the same owner —
            // from moving `heartbeat_at_ms` backwards and making a live run
            // look stale to `claimAndOwn`/`steal`'s cutoff. The outcome is
            // still `Updated`: the fence held, and the write proves liveness
            // regardless of which caller clock reading it carried. Prior art:
            // Temporal's shard `rangeID` only ever advances
            // (`reference/temporal/service/history/shard/context_impl.go`,
            // `renewRangeLocked`).
            const rows = yield* sql<{ readonly runId: string }>`
          UPDATE flows_runs
          SET heartbeat_at_ms = MAX(heartbeat_at_ms, ${nowMs})
          WHERE run_id = ${runId}
            AND status = 'running'
            AND owner_host_id = ${owner.hostId}
            AND owner_pid = ${owner.pid}
            AND owner_nonce = ${owner.nonce}
          RETURNING run_id AS "runId"
        `
            if (rows.length > 0) return updated
            const current = yield* selectRun(sql, runId)
            return current.length === 0 ? notFound : fenceLost
          })
        )
      })),
      observeOutcome((outcome) => RunStoreMetrics.heartbeat[outcome._tag])
    )
  )

  const transitionOwned = Effect.fn("RunStore.transitionOwned")((
    runId: string,
    owner: OwnerId,
    toStatus: RunStatus,
    stateJson?: string | undefined,
    guard?: TransitionGuard | undefined
  ): Effect.Effect<TransitionOutcome, RunStoreError> =>
    Effect.annotateCurrentSpan({ runId, ownerHostId: owner.hostId, to: toStatus }).pipe(
      Effect.andThen(Effect.suspend(() => {
        if (
          Schema.decodeUnknownResult(RunStatus)(toStatus)._tag === "Failure" ||
          (stateJson !== undefined && !isJsonString(stateJson))
        ) {
          return Effect.fail(invalidRunError("transitionOwned", { runId, toStatus, stateJson }))
        }
        const state = stateJson ?? null
        // A guard is compiled into the same UPDATE as the ownership fence, so a
        // concurrent cancellation request can never slip between check and write.
        const requireCancelAbsent = guard?.cancelRequested === "absent" ? 1 : 0
        const requireCancelPresent = guard?.cancelRequested === "present" ? 1 : 0
        return Clock.currentTimeMillis.pipe(
          Effect.flatMap((transitionedAtMs) =>
            write(
              "transitionOwned",
              Effect.gen(function*() {
                const rows = toStatus === "running"
                  ? yield* sql<{ readonly runId: string }>`
                UPDATE flows_runs
                SET
                  status = 'running',
                  finished_at_ms = NULL,
                  state_json = COALESCE(${state}, state_json)
                WHERE run_id = ${runId}
                  AND status = 'running'
                  AND owner_host_id = ${owner.hostId}
                  AND owner_pid = ${owner.pid}
                  AND owner_nonce = ${owner.nonce}
                  AND (${requireCancelAbsent} = 0 OR cancel_requested_at_ms IS NULL)
                  AND (${requireCancelPresent} = 0 OR cancel_requested_at_ms IS NOT NULL)
                RETURNING run_id AS "runId"
              `
                  : yield* sql<{ readonly runId: string }>`
                UPDATE flows_runs
                SET
                  status = ${toStatus},
                  finished_at_ms = ${terminalStatuses.has(toStatus) ? transitionedAtMs : null},
                  owner_host_id = NULL,
                  owner_pid = NULL,
                  owner_nonce = NULL,
                  heartbeat_at_ms = NULL,
                  claim_host_id = NULL,
                  claim_pid = NULL,
                  claim_nonce = NULL,
                  claimed_at_ms = NULL,
                  state_json = COALESCE(${state}, state_json)
                WHERE run_id = ${runId}
                  AND status = 'running'
                  AND owner_host_id = ${owner.hostId}
                  AND owner_pid = ${owner.pid}
                  AND owner_nonce = ${owner.nonce}
                  AND (${requireCancelAbsent} = 0 OR cancel_requested_at_ms IS NULL)
                  AND (${requireCancelPresent} = 0 OR cancel_requested_at_ms IS NOT NULL)
                RETURNING run_id AS "runId"
              `
                /* v8 ignore next -- both CAS outcomes are asserted; V8 reports a synthetic implicit branch */
                if (rows.length > 0) return transitioned
                const current = yield* selectRun(sql, runId)
                const row = current[0]
                if (row === undefined) return notFound
                const ownsRow = row.status === "running" &&
                  row.ownerHostId === owner.hostId &&
                  row.ownerPid === owner.pid &&
                  row.ownerNonce === owner.nonce
                return ownsRow ? guardFailed : fenceLost
              })
            )
          )
        )
      })),
      observeOutcome((outcome) => Metric.withAttributes(RunStoreMetrics.transition[outcome._tag], { to: toStatus }))
    )
  )

  const steal = Effect.fn("RunStore.steal")((
    runId: string,
    expected: RunSnapshot,
    claimant: OwnerId,
    nowMs: number,
    evidence: LivenessEvidence
  ): Effect.Effect<ClaimOutcome, RunStoreError> =>
    Effect.annotateCurrentSpan({ runId, claimantHostId: claimant.hostId }).pipe(
      Effect.andThen(Effect.suspend(() => {
        if (!evidenceMatches(expected, claimant, nowMs, evidence)) {
          return Effect.succeed(snapshotChanged)
        }
        const expectedOwner = expected.owner!
        return write(
          "steal",
          Effect.gen(function*() {
            const rows = yield* sql<{ readonly runId: string }>`
          UPDATE flows_runs
          SET
            claim_host_id = ${claimant.hostId},
            claim_pid = ${claimant.pid},
            claim_nonce = ${claimant.nonce},
            claimed_at_ms = ${nowMs}
          WHERE run_id = ${runId}
            AND status = ${expected.status}
            AND owner_host_id IS ${expectedOwner.hostId}
            AND owner_pid IS ${expectedOwner.pid}
            AND owner_nonce IS ${expectedOwner.nonce}
            AND heartbeat_at_ms IS ${expected.heartbeatAtMs}
            AND heartbeat_at_ms < ${nowMs - heartbeatStaleAfterMs}
            AND claim_host_id IS NULL
            AND claim_pid IS NULL
            AND claim_nonce IS NULL
            AND claimed_at_ms IS NULL
          RETURNING run_id AS "runId"
        `
            if (rows.length > 0) return claimed(nowMs)
            const current = yield* selectRun(sql, runId)
            return classifyClaimLoss(current[0], nowMs)
          })
        )
      })),
      observeOutcome((outcome) => RunStoreMetrics.steal[outcome._tag])
    )
  )

  return RunStore.of({
    create,
    get,
    requestCancel,
    claim,
    claimAndOwn,
    activate,
    abandonClaim,
    recoverClaim,
    heartbeat,
    transitionOwned,
    steal
  })
})

/**
 * Constructs a stub `RunStore` whose direct operations fail and whose
 * compare-and-swap operations report typed losses until overridden.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => {
  const unavailable = (method: string) =>
    Effect.fail(runStoreError(method, "persistence_failed", "no run store in this environment", method))
  return RunStore.of({
    create: Effect.fn("RunStore.create")(() => unavailable("create")),
    get: Effect.fn("RunStore.get")(() => unavailable("get")),
    requestCancel: Effect.fn("RunStore.requestCancel")(() => Effect.succeed(notFound)),
    claim: Effect.fn("RunStore.claim")(() => Effect.succeed(notFound)),
    claimAndOwn: Effect.fn("RunStore.claimAndOwn")(() => Effect.succeed(notFound)),
    activate: Effect.fn("RunStore.activate")(() => Effect.succeed(claimLost)),
    abandonClaim: Effect.fn("RunStore.abandonClaim")(() => Effect.succeed(claimLost)),
    recoverClaim: Effect.fn("RunStore.recoverClaim")(() => Effect.succeed(notFound)),
    heartbeat: Effect.fn("RunStore.heartbeat")(() => Effect.succeed(notFound)),
    transitionOwned: Effect.fn("RunStore.transitionOwned")(() => Effect.succeed(notFound)),
    steal: Effect.fn("RunStore.steal")(() => Effect.succeed(notFound)),
    ...overrides
  })
}

/**
 * Provides a stub `RunStore`.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<RunStore> =>
  Layer.succeed(RunStore)(makeNoop(overrides))

/**
 * Provides the database-backed `RunStore`.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<RunStore, never, DurableWriter | SqlClient.SqlClient> = Layer.effect(RunStore, make)
