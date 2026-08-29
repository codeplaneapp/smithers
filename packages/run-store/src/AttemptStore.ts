/**
 * Durable storage for individual step attempts.
 *
 * Attempt metadata is deliberately opaque to this module. Its shape belongs to
 * the step executor, and is persisted unchanged across attempt state changes.
 *
 * Governing design: `docs/specs/Concepts/Run Ownership.md`.
 * Schema boundary: `docs/specs/Research/Smithers Deviations 2026-07-28.md`.
 *
 * The running-state and owner fences follow Flue's
 * `reserveSubmissionSettlement`/store contract: stale attempts and repeated
 * terminal transitions never overwrite the winning row.
 *
 * @since 0.1.0
 */
import { DatabaseError, DurableWriter } from "@smthrs/database/DurableWriter"
import type { OwnerId } from "@smthrs/journal/OwnerId"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"

/** JSON text carrying an arbitrary decoded value. */
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown)

/**
 * Stable error codes returned by attempt persistence operations.
 *
 * @category models
 * @since 0.1.0
 */
export const AttemptStoreErrorCode = Schema.Literals([
  "invalid_attempt",
  "constraint",
  "decode_failed",
  "persistence_failed",
  "unknown"
])

/**
 * Stable error codes returned by attempt persistence operations.
 *
 * @category models
 * @since 0.1.0
 */
export type AttemptStoreErrorCode = typeof AttemptStoreErrorCode.Type

/**
 * Error raised by attempt persistence operations.
 *
 * The identity string equals the defining module path, like every other
 * identity in this repository.
 *
 * @category errors
 * @since 0.1.0
 */
export class AttemptStoreError extends Schema.TaggedError<AttemptStoreError>()(
  "@smthrs/run-store/AttemptStoreError",
  {
    code: AttemptStoreErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Identifies one execution of a content-addressed step within a run.
 *
 * @category models
 * @since 0.1.0
 */
export const AttemptId = Schema.Struct({
  runId: Schema.NonEmptyString,
  stepKeyDigest: Schema.NonEmptyString,
  attempt: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
  )
})

/**
 * Identifies one execution of a content-addressed step within a run.
 *
 * @category models
 * @since 0.1.0
 */
export type AttemptId = typeof AttemptId.Type

/**
 * A durable attempt row.
 *
 * @category models
 * @since 0.1.0
 */
export const Attempt = Schema.Struct({
  ...AttemptId.fields,
  state: Schema.NonEmptyString,
  startedAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  finishedAtMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  heartbeatAtMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  checkpoint: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
  outcome: Schema.optionalKey(Schema.Unknown),
  meta: Schema.Unknown
})

/**
 * A durable attempt row.
 *
 * @category models
 * @since 0.1.0
 */
export type Attempt = typeof Attempt.Type

/**
 * Input used to finish an existing attempt. `error`, `outcome`, and `meta`
 * follow the same rule as {@link AttemptPatch}: an omitted field is left as
 * recorded, so a terminal transition never erases a value written mid-flight
 * by `put` or `patch`. Supplying one replaces it atomically with the terminal
 * state, which lets an executor durably record what it discovered while
 * handling a failure.
 *
 * @category models
 * @since 0.1.0
 */
export const FinishAttempt = Schema.Struct({
  ...AttemptId.fields,
  state: Schema.NonEmptyString,
  finishedAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  error: Schema.optionalKey(Schema.Unknown),
  outcome: Schema.optionalKey(Schema.Unknown),
  meta: Schema.optionalKey(Schema.Unknown)
})

/**
 * Input used to finish an existing attempt.
 *
 * @category models
 * @since 0.1.0
 */
export type FinishAttempt = typeof FinishAttempt.Type

/**
 * Result of starting an owner-fenced attempt.
 *
 * @category models
 * @since 0.1.0
 */
export type PutResult =
  | { readonly _tag: "Inserted" }
  | { readonly _tag: "Upserted" }
  | { readonly _tag: "ExistingSame" }
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "FenceLost" }
  | { readonly _tag: "RunNotFound" }

/**
 * Fields a patch may rewrite.
 *
 * A patch never touches `state`, `started_at_ms`, or `finished_at_ms`: those
 * are the lifecycle, and only `put`/`heartbeat`/`finish` move them. An
 * omitted field is left as recorded.
 *
 * @category models
 * @since 0.1.0
 */
export const AttemptPatch = Schema.Struct({
  checkpoint: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
  outcome: Schema.optionalKey(Schema.Unknown),
  meta: Schema.optionalKey(Schema.Unknown)
})

/**
 * Fields a patch may rewrite.
 *
 * @category models
 * @since 0.1.0
 */
export type AttemptPatch = typeof AttemptPatch.Type

/**
 * Result of an owner-fenced attempt patch.
 *
 * @category models
 * @since 0.1.0
 */
export type PatchResult =
  | { readonly _tag: "Patched" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "FenceLost" }

/**
 * Store-wide policy.
 *
 * Defaults treat only `running` attempts as in progress, cap checkpoints at
 * 1 MiB, and make attempt insertion first-writer-wins.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * States the store treats as "attempt still in progress". `heartbeat` and
   * `finish` fence on membership, and `finish` refuses them as targets.
   * Defaults to `["running"]`.
   */
  readonly inProgressStates?: ReadonlyArray<string> | undefined
  /** Largest encoded checkpoint accepted, in bytes. Defaults to 1 MiB. */
  readonly maxCheckpointBytes?: number | undefined
  /**
   * `"insert"` (the default) is first-writer-wins: a re-put with different
   * content reports `Conflict`. `"upsert"` overwrites it and reports
   * `Upserted`. Both modes keep the run-ownership fence.
   */
  readonly putMode?: "insert" | "upsert" | undefined
}

/**
 * Result of a fenced attempt heartbeat.
 *
 * @category models
 * @since 0.1.0
 */
export type HeartbeatResult =
  | { readonly _tag: "Updated" }
  | { readonly _tag: "FenceLost" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "StateChanged" }

/**
 * Result of a fenced terminal attempt transition.
 *
 * @category models
 * @since 0.1.0
 */
export type FinishResult =
  | { readonly _tag: "Finished" }
  | { readonly _tag: "FenceLost" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "StateChanged" }

/**
 * Attempt persistence operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly put: (attempt: Attempt, owner: OwnerId) => Effect.Effect<PutResult, AttemptStoreError>
  readonly get: (id: AttemptId) => Effect.Effect<Option.Option<Attempt>, AttemptStoreError>
  readonly heartbeat: (
    runId: string,
    stepKeyDigest: string,
    attempt: number,
    owner: OwnerId,
    nowMs: number,
    checkpoint?: unknown
  ) => Effect.Effect<HeartbeatResult, AttemptStoreError>
  readonly finish: (attempt: FinishAttempt, owner: OwnerId) => Effect.Effect<FinishResult, AttemptStoreError>
  /**
   * Rewrites opaque fields without competing for the attempt lifecycle: a
   * patch never moves `state`, so executors record response text, worktree
   * pointers, or cache flags on running *and* terminal rows. It is fenced on
   * run ownership like every other write — `outcome` is replayed verbatim as
   * the attempt's result, so a delayed patch from an owner that lost the run
   * (or from any writer after the run reached a terminal status and its
   * owner columns were cleared) reports `FenceLost` instead of rewriting the
   * winning row. Prior art: Temporal conditions every persistence write on
   * the shard `rangeID` (`reference/temporal/service/history/shard/`); there
   * is no unfenced write surface.
   */
  readonly patch: (
    id: AttemptId,
    patch: AttemptPatch,
    owner: OwnerId
  ) => Effect.Effect<PatchResult, AttemptStoreError>
}

/**
 * Service tag for durable step attempts.
 *
 * The identity string equals the defining module path, like every other
 * service identity in this repository. The pre-split
 * `flows/journal/AttemptStore` identity from
 * `docs/specs/Concepts/Journal Split.md` was retired pre-release, while no
 * persisted journal or step-key digest named it.
 *
 * @category services
 * @since 0.1.0
 */
export class AttemptStore extends Context.Service<AttemptStore, Service>()("@smthrs/run-store/AttemptStore") {}

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

const AttemptRow = Schema.Struct({
  run_id: Schema.NonEmptyString,
  step_key_digest: Schema.NonEmptyString,
  attempt: NonNegativeSafeInt,
  state: Schema.NonEmptyString,
  started_at_ms: NonNegativeSafeInt,
  finished_at_ms: Schema.NullOr(NonNegativeSafeInt),
  heartbeat_at_ms: Schema.NullOr(NonNegativeSafeInt),
  checkpoint_json: Schema.NullOr(Schema.String),
  error_json: Schema.NullOr(Schema.String),
  outcome_json: Schema.NullOr(Schema.String),
  meta_json: Schema.String
})

type AttemptRow = typeof AttemptRow.Type

interface RunFenceRow {
  readonly status: string
  readonly owner_host_id: string | null
  readonly owner_pid: number | null
  readonly owner_nonce: string | null
}

const error = (code: AttemptStoreErrorCode, message: string, cause?: unknown): AttemptStoreError =>
  new AttemptStoreError({ code, message, ...(cause === undefined ? {} : { cause }) })

// Checkpoints, outcomes, errors, and metadata are executable state: a
// checkpoint is handed back to the retrying step and an outcome is returned
// verbatim as the replayed result, so nothing rewrites them on the way
// through (issue #72).
const encode = (value: unknown, field: string): Effect.Effect<string, AttemptStoreError> =>
  Schema.encodeEffect(UnknownFromJsonString)(value).pipe(
    Effect.mapError((cause) => error("invalid_attempt", `${field} must be JSON-serializable`, cause))
  )

const encodeOptionalWith = (
  encode: (value: unknown, field: string) => Effect.Effect<string, AttemptStoreError>
) =>
(value: unknown | undefined, field: string): Effect.Effect<string | null, AttemptStoreError> =>
  value === undefined ? Effect.succeed(null) : encode(value, field)

const defaultMaxCheckpointBytes = 1024 * 1024

const defaultInProgressStates: ReadonlyArray<string> = ["running"]

const encodeCheckpointWith = (
  maxBytes: number,
  encodeOptional: (value: unknown | undefined, field: string) => Effect.Effect<string | null, AttemptStoreError>
) =>
(value: unknown | undefined): Effect.Effect<string | null, AttemptStoreError> =>
  Effect.flatMap(
    encodeOptional(value, "checkpoint"),
    (encoded) =>
      encoded !== null && new TextEncoder().encode(encoded).length > maxBytes
        ? Effect.fail(error("invalid_attempt", `checkpoint must not exceed ${maxBytes} bytes`))
        : Effect.succeed(encoded)
  )

const decode = (value: string | null, field: string): Effect.Effect<unknown | undefined, AttemptStoreError> =>
  value === null
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(UnknownFromJsonString)(value).pipe(
      Effect.mapError((cause) => error("decode_failed", `could not decode ${field}`, cause))
    )

const validateId = (id: AttemptId): Effect.Effect<void, AttemptStoreError> =>
  id.runId.length > 0 &&
    id.stepKeyDigest.length > 0 &&
    Number.isSafeInteger(id.attempt) &&
    id.attempt >= 0
    ? Effect.void
    : Effect.fail(
      error("invalid_attempt", "runId and stepKeyDigest must not be empty and attempt must be non-negative")
    )

const ownsRunningRun = (row: RunFenceRow, owner: OwnerId): boolean =>
  row.status === "running" &&
  row.owner_host_id === owner.hostId &&
  row.owner_pid === owner.pid &&
  row.owner_nonce === owner.nonce

const sameOptional = (actual: string | null, expected: string | null): boolean => actual === expected

const sameAttempt = (
  row: AttemptRow,
  attempt: Attempt,
  checkpoint: string | null,
  attemptError: string | null,
  outcome: string | null,
  meta: string
): boolean =>
  row.state === attempt.state &&
  row.started_at_ms === attempt.startedAtMs &&
  row.finished_at_ms === (attempt.finishedAtMs ?? null) &&
  row.heartbeat_at_ms === (attempt.heartbeatAtMs ?? null) &&
  sameOptional(row.checkpoint_json, checkpoint) &&
  sameOptional(row.error_json, attemptError) &&
  sameOptional(row.outcome_json, outcome) &&
  row.meta_json === meta

const mapPersistenceError = (cause: unknown): AttemptStoreError => {
  if (Schema.is(AttemptStoreError)(cause)) {
    return cause
  }
  const constraint = Schema.is(DatabaseError)(cause)
    ? cause.code === "constraint"
    : SqlError.isSqlError(cause) &&
      (cause.reason instanceof SqlError.ConstraintError || cause.reason instanceof SqlError.UniqueViolation)
  return error(
    constraint ? "constraint" : "persistence_failed",
    "attempt persistence failed",
    cause
  )
}

const decodeRow = (input: unknown): Effect.Effect<Attempt, AttemptStoreError> =>
  Schema.decodeUnknownEffect(AttemptRow)(input).pipe(
    Effect.mapError((cause) => error("decode_failed", "could not decode flows_attempts row", cause)),
    Effect.flatMap((row) =>
      Effect.all({
        checkpoint: decode(row.checkpoint_json, "checkpoint_json"),
        error: decode(row.error_json, "error_json"),
        outcome: decode(row.outcome_json, "outcome_json"),
        meta: decode(row.meta_json, "meta_json")
      }).pipe(
        Effect.map(({ checkpoint, error: attemptError, outcome, meta }) => ({
          runId: row.run_id,
          stepKeyDigest: row.step_key_digest,
          attempt: row.attempt,
          state: row.state,
          startedAtMs: row.started_at_ms,
          ...(row.finished_at_ms === null ? {} : { finishedAtMs: row.finished_at_ms }),
          ...(row.heartbeat_at_ms === null ? {} : { heartbeatAtMs: row.heartbeat_at_ms }),
          ...(checkpoint === undefined ? {} : { checkpoint }),
          ...(attemptError === undefined ? {} : { error: attemptError }),
          ...(outcome === undefined ? {} : { outcome }),
          meta
        }))
      )
    )
  )

/**
 * Builds the SQL-backed attempt store under an explicit policy.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeWith = (
  options: Options = {}
): Effect.Effect<Service, AttemptStoreError, DurableWriter | SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const writer = yield* DurableWriter

    const inProgressStates = options.inProgressStates ?? defaultInProgressStates
    const maxCheckpointBytes = options.maxCheckpointBytes ?? defaultMaxCheckpointBytes
    const upsert = options.putMode === "upsert"
    const encodeOptional = encodeOptionalWith(encode)
    if (inProgressStates.length === 0 || inProgressStates.some((state) => state.length === 0)) {
      return yield* Effect.fail(
        error("invalid_attempt", "inProgressStates must contain at least one non-empty state")
      )
    }
    if (!Number.isSafeInteger(maxCheckpointBytes) || maxCheckpointBytes <= 0) {
      return yield* Effect.fail(error("invalid_attempt", "maxCheckpointBytes must be a positive safe integer"))
    }
    const encodeCheckpoint = encodeCheckpointWith(maxCheckpointBytes, encodeOptional)
    const inProgress = sql.in("state", inProgressStates as Array<string>)

    const put: Service["put"] = Effect.fn("AttemptStore.put")((attempt, owner) =>
      Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({
          runId: attempt.runId,
          stepKeyDigest: attempt.stepKeyDigest,
          attempt: attempt.attempt
        })
        yield* validateId(attempt)
        if (
          attempt.state.length === 0 ||
          !Number.isSafeInteger(attempt.startedAtMs) ||
          attempt.startedAtMs < 0 ||
          (attempt.finishedAtMs !== undefined &&
            (!Number.isSafeInteger(attempt.finishedAtMs) || attempt.finishedAtMs < 0)) ||
          (attempt.heartbeatAtMs !== undefined &&
            (!Number.isSafeInteger(attempt.heartbeatAtMs) || attempt.heartbeatAtMs < 0))
        ) {
          return yield* Effect.fail(error("invalid_attempt", "attempt timestamps and state are invalid"))
        }
        const checkpoint = yield* encodeCheckpoint(attempt.checkpoint)
        const attemptError = yield* encodeOptional(attempt.error, "error")
        const outcome = yield* encodeOptional(attempt.outcome, "outcome")
        const meta = yield* encode(attempt.meta, "meta")
        return yield* writer.write(
          Effect.gen(function*() {
            const inserted = yield* sql<{ readonly attempt: number }>`
            INSERT INTO flows_attempts (
              run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms,
              heartbeat_at_ms, checkpoint_json, error_json, outcome_json, meta_json
            )
            SELECT
              ${attempt.runId}, ${attempt.stepKeyDigest}, ${attempt.attempt}, ${attempt.state},
              ${attempt.startedAtMs}, ${attempt.finishedAtMs ?? null}, ${attempt.heartbeatAtMs ?? null},
              ${checkpoint}, ${attemptError}, ${outcome}, ${meta}
            WHERE EXISTS (
              SELECT 1 FROM flows_runs
              WHERE run_id = ${attempt.runId}
                AND status = 'running'
                AND owner_host_id = ${owner.hostId}
                AND owner_pid = ${owner.pid}
                AND owner_nonce = ${owner.nonce}
            )
            ON CONFLICT (run_id, step_key_digest, attempt) DO NOTHING
            RETURNING attempt
          `
            if (inserted.length > 0) {
              return { _tag: "Inserted" } as const
            }

            if (upsert) {
              const replaced = yield* sql<{ readonly attempt: number }>`
              UPDATE flows_attempts
              SET
                state = ${attempt.state},
                started_at_ms = ${attempt.startedAtMs},
                finished_at_ms = ${attempt.finishedAtMs ?? null},
                heartbeat_at_ms = ${attempt.heartbeatAtMs ?? null},
                checkpoint_json = ${checkpoint},
                error_json = ${attemptError},
                outcome_json = ${outcome},
                meta_json = ${meta}
              WHERE run_id = ${attempt.runId}
                AND step_key_digest = ${attempt.stepKeyDigest}
                AND attempt = ${attempt.attempt}
                AND EXISTS (
                  SELECT 1 FROM flows_runs
                  WHERE run_id = ${attempt.runId}
                    AND status = 'running'
                    AND owner_host_id = ${owner.hostId}
                    AND owner_pid = ${owner.pid}
                    AND owner_nonce = ${owner.nonce}
                )
              RETURNING attempt
            `
              if (replaced.length > 0) {
                return { _tag: "Upserted" } as const
              }
            }

            const runRows = yield* sql<RunFenceRow>`
            SELECT status, owner_host_id, owner_pid, owner_nonce
            FROM flows_runs WHERE run_id = ${attempt.runId}
          `
            if (runRows.length === 0) {
              return { _tag: "RunNotFound" } as const
            }
            if (!ownsRunningRun(runRows[0]!, owner)) {
              return { _tag: "FenceLost" } as const
            }

            const rows = yield* sql<AttemptRow>`
            SELECT run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms,
              heartbeat_at_ms, checkpoint_json, error_json, outcome_json, meta_json
            FROM flows_attempts
            WHERE run_id = ${attempt.runId}
              AND step_key_digest = ${attempt.stepKeyDigest}
              AND attempt = ${attempt.attempt}
          `
            /* v8 ignore next -- the owned run and conflicting row are read in the same serialized write transaction */
            if (rows.length === 0) {
              return yield* Effect.fail(error("unknown", "attempt disappeared during put"))
            }
            return sameAttempt(rows[0]!, attempt, checkpoint, attemptError, outcome, meta)
              ? { _tag: "ExistingSame" } as const
              : { _tag: "Conflict" } as const
          })
        ).pipe(Effect.mapError(mapPersistenceError))
      })
    )

    const get: Service["get"] = Effect.fn("AttemptStore.get")((id) =>
      Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({
          runId: id.runId,
          stepKeyDigest: id.stepKeyDigest,
          attempt: id.attempt
        })
        yield* validateId(id)
        const rows = yield* sql<Record<string, unknown>>`
        SELECT run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms,
          heartbeat_at_ms, checkpoint_json, error_json, outcome_json, meta_json
        FROM flows_attempts
        WHERE run_id = ${id.runId} AND step_key_digest = ${id.stepKeyDigest} AND attempt = ${id.attempt}
      `.pipe(Effect.mapError(mapPersistenceError))
        return rows.length === 0 ? Option.none() : yield* Effect.map(decodeRow(rows[0]!), Option.some)
      })
    )

    const heartbeat: Service["heartbeat"] = Effect.fn("AttemptStore.heartbeat")((
      runId,
      stepKeyDigest,
      attempt,
      owner,
      nowMs,
      checkpointValue
    ) =>
      Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({ runId, stepKeyDigest, attempt })
        yield* validateId({ runId, stepKeyDigest, attempt })
        if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
          return yield* Effect.fail(error("invalid_attempt", "nowMs must be a non-negative safe integer"))
        }
        const checkpoint = yield* encodeCheckpoint(checkpointValue)
        return yield* writer.write(
          Effect.gen(function*() {
            const updated = yield* sql<{ readonly attempt: number }>`
            UPDATE flows_attempts
            SET
              heartbeat_at_ms = ${nowMs},
              checkpoint_json = COALESCE(${checkpoint}, checkpoint_json)
            WHERE run_id = ${runId}
              AND step_key_digest = ${stepKeyDigest}
              AND attempt = ${attempt}
              AND ${inProgress}
              AND EXISTS (
                SELECT 1 FROM flows_runs
                WHERE run_id = ${runId}
                  AND status = 'running'
                  AND owner_host_id = ${owner.hostId}
                  AND owner_pid = ${owner.pid}
                  AND owner_nonce = ${owner.nonce}
              )
            RETURNING attempt
          `
            if (updated.length > 0) {
              return { _tag: "Updated" } as const
            }
            const found = yield* sql<Pick<AttemptRow, "state">>`
            SELECT state FROM flows_attempts
            WHERE run_id = ${runId} AND step_key_digest = ${stepKeyDigest} AND attempt = ${attempt}
          `
            if (found.length === 0) {
              return { _tag: "NotFound" } as const
            }
            const runRows = yield* sql<RunFenceRow>`
            SELECT status, owner_host_id, owner_pid, owner_nonce
            FROM flows_runs WHERE run_id = ${runId}
          `
            return runRows.length === 0 || !ownsRunningRun(runRows[0]!, owner)
              ? { _tag: "FenceLost" } as const
              : { _tag: "StateChanged" } as const
          })
        ).pipe(Effect.mapError(mapPersistenceError))
      })
    )

    const finish: Service["finish"] = Effect.fn("AttemptStore.finish")((attempt, owner) =>
      Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({
          runId: attempt.runId,
          stepKeyDigest: attempt.stepKeyDigest,
          attempt: attempt.attempt
        })
        yield* validateId(attempt)
        if (
          attempt.state.length === 0 ||
          inProgressStates.includes(attempt.state) ||
          !Number.isSafeInteger(attempt.finishedAtMs) ||
          attempt.finishedAtMs < 0
        ) {
          return yield* Effect.fail(error("invalid_attempt", "finish requires a terminal state and valid timestamp"))
        }
        const attemptError = yield* encodeOptional(attempt.error, "error")
        const outcome = yield* encodeOptional(attempt.outcome, "outcome")
        const meta = yield* encodeOptional(attempt.meta, "meta")
        return yield* writer.write(
          Effect.gen(function*() {
            const updated = yield* sql<{ readonly attempt: number }>`
            UPDATE flows_attempts
            SET
              state = ${attempt.state},
              finished_at_ms = ${attempt.finishedAtMs},
              error_json = COALESCE(${attemptError}, error_json),
              outcome_json = COALESCE(${outcome}, outcome_json),
              meta_json = COALESCE(${meta}, meta_json)
            WHERE run_id = ${attempt.runId}
              AND step_key_digest = ${attempt.stepKeyDigest}
              AND attempt = ${attempt.attempt}
              AND ${inProgress}
              AND EXISTS (
                SELECT 1 FROM flows_runs
                WHERE run_id = ${attempt.runId}
                  AND status = 'running'
                  AND owner_host_id = ${owner.hostId}
                  AND owner_pid = ${owner.pid}
                  AND owner_nonce = ${owner.nonce}
              )
            RETURNING attempt
          `
            if (updated.length > 0) {
              return { _tag: "Finished" } as const
            }
            const found = yield* sql<Pick<AttemptRow, "state">>`
            SELECT state FROM flows_attempts
            WHERE run_id = ${attempt.runId}
              AND step_key_digest = ${attempt.stepKeyDigest}
              AND attempt = ${attempt.attempt}
          `
            if (found.length === 0) {
              return { _tag: "NotFound" } as const
            }
            const runRows = yield* sql<RunFenceRow>`
            SELECT status, owner_host_id, owner_pid, owner_nonce
            FROM flows_runs WHERE run_id = ${attempt.runId}
          `
            return runRows.length === 0 || !ownsRunningRun(runRows[0]!, owner)
              ? { _tag: "FenceLost" } as const
              : { _tag: "StateChanged" } as const
          })
        ).pipe(Effect.mapError(mapPersistenceError))
      })
    )

    const patch: Service["patch"] = Effect.fn("AttemptStore.patch")((id, fields, owner) =>
      Effect.gen(function*() {
        yield* Effect.annotateCurrentSpan({
          runId: id.runId,
          stepKeyDigest: id.stepKeyDigest,
          attempt: id.attempt
        })
        yield* validateId(id)
        const checkpoint = yield* encodeCheckpoint(fields.checkpoint)
        const attemptError = yield* encodeOptional(fields.error, "error")
        const outcome = yield* encodeOptional(fields.outcome, "outcome")
        const meta = yield* encodeOptional(fields.meta, "meta")
        return yield* writer.write(
          Effect.gen(function*() {
            // Unlike `heartbeat`/`finish` there is no state predicate: a patch
            // may touch a terminal row (evidence quarantine does), so the run
            // fence is the only gate. After a terminal run transition the
            // owner columns are cleared and every patch is refused.
            const updated = yield* sql<{ readonly attempt: number }>`
            UPDATE flows_attempts
            SET
              checkpoint_json = COALESCE(${checkpoint}, checkpoint_json),
              error_json = COALESCE(${attemptError}, error_json),
              outcome_json = COALESCE(${outcome}, outcome_json),
              meta_json = COALESCE(${meta}, meta_json)
            WHERE run_id = ${id.runId}
              AND step_key_digest = ${id.stepKeyDigest}
              AND attempt = ${id.attempt}
              AND EXISTS (
                SELECT 1 FROM flows_runs
                WHERE run_id = ${id.runId}
                  AND status = 'running'
                  AND owner_host_id = ${owner.hostId}
                  AND owner_pid = ${owner.pid}
                  AND owner_nonce = ${owner.nonce}
              )
            RETURNING attempt
          `
            if (updated.length > 0) {
              return { _tag: "Patched" } as const
            }
            const found = yield* sql<Pick<AttemptRow, "state">>`
            SELECT state FROM flows_attempts
            WHERE run_id = ${id.runId} AND step_key_digest = ${id.stepKeyDigest} AND attempt = ${id.attempt}
          `
            return found.length === 0
              ? { _tag: "NotFound" } as const
              : { _tag: "FenceLost" } as const
          })
        ).pipe(Effect.mapError(mapPersistenceError))
      })
    )

    return { put, get, heartbeat, finish, patch }
  })

/**
 * Builds the SQL-backed attempt store with default policy.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<Service, never, DurableWriter | SqlClient.SqlClient> = Effect.orDie(makeWith())

/**
 * Creates an attempt store from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => {
  const unavailable = (method: string) => Effect.fail(error("unknown", `${method} is unavailable`))
  return {
    put: Effect.fn("AttemptStore.put")(() => unavailable("put")),
    get: Effect.fn("AttemptStore.get")(() => unavailable("get")),
    heartbeat: Effect.fn("AttemptStore.heartbeat")(() => unavailable("heartbeat")),
    finish: Effect.fn("AttemptStore.finish")(() => unavailable("finish")),
    patch: Effect.fn("AttemptStore.patch")(() => unavailable("patch")),
    ...overrides
  }
}

/**
 * Provides a no-op attempt store.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<AttemptStore> =>
  Layer.succeed(AttemptStore)(makeNoop(overrides))

/**
 * Provides the SQL-backed attempt store.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<AttemptStore, never, DurableWriter | SqlClient.SqlClient> = Layer.effect(AttemptStore)(
  make
)

/**
 * Provides the SQL-backed attempt store under an explicit policy.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerWith = (
  options: Options
): Layer.Layer<AttemptStore, AttemptStoreError, DurableWriter | SqlClient.SqlClient> =>
  Layer.effect(AttemptStore)(makeWith(options))
