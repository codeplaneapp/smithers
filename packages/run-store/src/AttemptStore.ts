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
import * as Boundary from "./internal/Boundary.ts"

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

const durableIdentifier = Schema.NonEmptyString.check(
  Schema.isMaxLength(Boundary.maximumIdentifierLength),
  Schema.makeFilter((value: string) => Boundary.isDurableText(value), { title: "durableIdentifier" })
)

/**
 * Default encoded-byte limit for attempt metadata, errors, and outcomes.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumValueBytes = 4 * 1024 * 1024

/**
 * Absolute encoded-byte ceiling for a configured checkpoint.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumCheckpointBytes = 16 * 1024 * 1024

/**
 * Maximum nesting admitted for durable attempt JSON.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumJsonDepth = 128

/**
 * Maximum values and members admitted for durable attempt JSON.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumJsonNodes = 100_000

const jsonLimits = (maxBytes: number): Boundary.JsonLimits => ({
  maxBytes,
  maxDepth: maximumJsonDepth,
  maxMembers: maximumJsonNodes,
  maxNodes: maximumJsonNodes,
  maxStringBytes: maxBytes,
  maxKeyBytes: 16 * 1024
})

/**
 * Strict JSON value accepted as executable attempt state.
 *
 * The store still takes an inert snapshot at effect start; this schema is the
 * public declaration contract shared by `Attempt`, `FinishAttempt`, and
 * `AttemptPatch`.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const JsonValue = Schema.declare<Boundary.Json>(
  (value): value is Boundary.Json => Boundary.admitJson(value, jsonLimits(maximumCheckpointBytes)).ok,
  { identifier: "@smthrs/run-store/JsonValue" }
)

/**
 * Strict JSON value accepted as executable attempt state.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type JsonValue = typeof JsonValue.Type

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
  runId: durableIdentifier,
  stepKeyDigest: durableIdentifier,
  attempt: NonNegativeSafeInt
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
  state: durableIdentifier,
  startedAtMs: NonNegativeSafeInt,
  finishedAtMs: Schema.optionalKey(NonNegativeSafeInt),
  heartbeatAtMs: Schema.optionalKey(NonNegativeSafeInt),
  checkpoint: Schema.optionalKey(JsonValue),
  error: Schema.optionalKey(JsonValue),
  outcome: Schema.optionalKey(JsonValue),
  meta: JsonValue
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
  state: durableIdentifier,
  finishedAtMs: NonNegativeSafeInt,
  error: Schema.optionalKey(JsonValue),
  outcome: Schema.optionalKey(JsonValue),
  meta: Schema.optionalKey(JsonValue)
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
  checkpoint: Schema.optionalKey(JsonValue),
  error: Schema.optionalKey(JsonValue),
  outcome: Schema.optionalKey(JsonValue),
  meta: Schema.optionalKey(JsonValue)
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
  /**
   * Largest encoded checkpoint accepted, in bytes. Defaults to 1 MiB and may
   * not exceed {@link maximumCheckpointBytes}.
   */
  readonly maxCheckpointBytes?: number | undefined
  /**
   * `"insert"` (the default) is first-writer-wins: a re-put with different
   * content reports `Conflict`. `"upsert"` overwrites it and reports
   * `Upserted` only while the existing row is still in progress. A terminal
   * row remains immutable. Both modes keep the run-ownership fence.
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
    checkpoint?: JsonValue
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

const AttemptRow = Schema.Struct({
  run_id: durableIdentifier,
  step_key_digest: durableIdentifier,
  attempt: NonNegativeSafeInt,
  state: durableIdentifier,
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

const encode = (
  value: unknown,
  field: string,
  maxBytes = maximumValueBytes
): Effect.Effect<string, AttemptStoreError> =>
  Effect.suspend(() => {
    const admitted = Boundary.admitJson(value, jsonLimits(maxBytes))
    return admitted.ok
      ? Effect.succeed(JSON.stringify(admitted.value))
      : Effect.fail(error("invalid_attempt", `${field} ${admitted.complaint}`))
  })

const encodeOptionalWith = (
  encode: (value: unknown, field: string) => Effect.Effect<string, AttemptStoreError>
) =>
(value: unknown | undefined, field: string): Effect.Effect<string | null, AttemptStoreError> =>
  value === undefined ? Effect.succeed(null) : encode(value, field)

const defaultMaxCheckpointBytes = 1024 * 1024

const defaultInProgressStates: ReadonlyArray<string> = ["running"]

const encodeCheckpointWith = (
  maxBytes: number,
  _encodeOptional: (value: unknown | undefined, field: string) => Effect.Effect<string | null, AttemptStoreError>
) =>
(value: unknown | undefined): Effect.Effect<string | null, AttemptStoreError> =>
  value === undefined ? Effect.succeed(null) : encode(value, "checkpoint", maxBytes)

const decode = (
  value: string | null,
  field: string,
  maxBytes = maximumValueBytes
): Effect.Effect<JsonValue | undefined, AttemptStoreError> =>
  Effect.suspend(() => {
    if (value === null) return Effect.succeed(undefined)
    const admitted = Boundary.admitJsonText(value, jsonLimits(maxBytes))
    return admitted.ok
      ? Effect.succeed(admitted.json)
      : Effect.fail(error("decode_failed", `${field} ${admitted.complaint}`))
  })

const decodeRequired = (
  value: string,
  field: string,
  maxBytes = maximumValueBytes
): Effect.Effect<JsonValue, AttemptStoreError> =>
  decode(value, field, maxBytes).pipe(
    Effect.flatMap((decoded) =>
      decoded === undefined
        ? Effect.fail(error("decode_failed", `${field} is missing`))
        : Effect.succeed(decoded)
    )
  )

const validateId = (id: AttemptId): Effect.Effect<void, AttemptStoreError> =>
  Boundary.isDurableText(id.runId) &&
    Boundary.isDurableText(id.stepKeyDigest) &&
    Number.isSafeInteger(id.attempt) &&
    id.attempt >= 0
    ? Effect.void
    : Effect.fail(
      error("invalid_attempt", "attempt identity violates the durable identifier contract")
    )

const inspectRecord = (
  input: unknown,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string>,
  field: string
): Readonly<Record<string, unknown>> => {
  if (typeof input !== "object" || input === null) throw new TypeError(field)
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(field)
  const allowed = new Set([...required, ...optional])
  const output = Object.create(null) as Record<string, unknown>
  for (const name of required) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name)
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError(field)
    output[name] = descriptor.value
  }
  for (const name of optional) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name)
    if (descriptor === undefined) continue
    if (!("value" in descriptor) || !descriptor.enumerable) throw new TypeError(field)
    if (descriptor.value !== undefined) output[name] = descriptor.value
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      if (Object.getOwnPropertyDescriptor(input, key)?.enumerable) throw new TypeError(field)
    }
  }
  return output
}

const snapshotJson = (
  value: unknown,
  field: string,
  maxBytes = maximumValueBytes
): { readonly ok: true; readonly value: JsonValue } | { readonly ok: false; readonly error: AttemptStoreError } => {
  const admitted = Boundary.admitJson(value, jsonLimits(maxBytes))
  return admitted.ok
    ? { ok: true, value: admitted.value }
    : { ok: false, error: error("invalid_attempt", `${field} ${admitted.complaint}`) }
}

const snapshotId = (input: AttemptId): Effect.Effect<AttemptId, AttemptStoreError> =>
  Effect.suspend(() => {
    try {
      const values = inspectRecord(input, ["runId", "stepKeyDigest", "attempt"], [], "attempt id")
      const id = Object.freeze({
        runId: values.runId,
        stepKeyDigest: values.stepKeyDigest,
        attempt: values.attempt
      }) as AttemptId
      return Effect.as(validateId(id), id)
    } catch {
      return Effect.fail(error("invalid_attempt", "attempt id must be an inert data record"))
    }
  })

const snapshotAttempt = (input: Attempt): Effect.Effect<Attempt, AttemptStoreError> =>
  Effect.suspend(() => {
    try {
      const values = inspectRecord(
        input,
        ["runId", "stepKeyDigest", "attempt", "state", "startedAtMs", "meta"],
        ["finishedAtMs", "heartbeatAtMs", "checkpoint", "error", "outcome"],
        "attempt"
      )
      const checkpoint = values.checkpoint === undefined
        ? undefined
        : snapshotJson(values.checkpoint, "checkpoint", maximumCheckpointBytes)
      const attemptError = values.error === undefined ? undefined : snapshotJson(values.error, "error")
      const outcome = values.outcome === undefined ? undefined : snapshotJson(values.outcome, "outcome")
      const meta = snapshotJson(values.meta, "meta")
      if (checkpoint !== undefined && !checkpoint.ok) return Effect.fail(checkpoint.error)
      if (attemptError !== undefined && !attemptError.ok) return Effect.fail(attemptError.error)
      if (outcome !== undefined && !outcome.ok) return Effect.fail(outcome.error)
      if (!meta.ok) return Effect.fail(meta.error)
      const candidate = Object.freeze({
        runId: values.runId,
        stepKeyDigest: values.stepKeyDigest,
        attempt: values.attempt,
        state: values.state,
        startedAtMs: values.startedAtMs,
        ...(values.finishedAtMs === undefined ? {} : { finishedAtMs: values.finishedAtMs }),
        ...(values.heartbeatAtMs === undefined ? {} : { heartbeatAtMs: values.heartbeatAtMs }),
        ...(checkpoint === undefined ? {} : { checkpoint: checkpoint.value }),
        ...(attemptError === undefined ? {} : { error: attemptError.value }),
        ...(outcome === undefined ? {} : { outcome: outcome.value }),
        meta: meta.value
      })
      return Schema.decodeUnknownEffect(Attempt)(candidate).pipe(
        Effect.mapError(() => error("invalid_attempt", "attempt violates the persistence contract"))
      )
    } catch {
      return Effect.fail(error("invalid_attempt", "attempt must be an inert data record"))
    }
  })

const snapshotFinish = (input: FinishAttempt): Effect.Effect<FinishAttempt, AttemptStoreError> =>
  Effect.suspend(() => {
    try {
      const values = inspectRecord(
        input,
        ["runId", "stepKeyDigest", "attempt", "state", "finishedAtMs"],
        ["error", "outcome", "meta"],
        "finished attempt"
      )
      const attemptError = values.error === undefined ? undefined : snapshotJson(values.error, "error")
      const outcome = values.outcome === undefined ? undefined : snapshotJson(values.outcome, "outcome")
      const meta = values.meta === undefined ? undefined : snapshotJson(values.meta, "meta")
      if (attemptError !== undefined && !attemptError.ok) return Effect.fail(attemptError.error)
      if (outcome !== undefined && !outcome.ok) return Effect.fail(outcome.error)
      if (meta !== undefined && !meta.ok) return Effect.fail(meta.error)
      return Schema.decodeUnknownEffect(FinishAttempt)(Object.freeze({
        runId: values.runId,
        stepKeyDigest: values.stepKeyDigest,
        attempt: values.attempt,
        state: values.state,
        finishedAtMs: values.finishedAtMs,
        ...(attemptError === undefined ? {} : { error: attemptError.value }),
        ...(outcome === undefined ? {} : { outcome: outcome.value }),
        ...(meta === undefined ? {} : { meta: meta.value })
      })).pipe(Effect.mapError(() => error("invalid_attempt", "finished attempt violates the contract")))
    } catch {
      return Effect.fail(error("invalid_attempt", "finished attempt must be an inert data record"))
    }
  })

const snapshotPatch = (input: AttemptPatch): Effect.Effect<AttemptPatch, AttemptStoreError> =>
  Effect.suspend(() => {
    try {
      const values = inspectRecord(input, [], ["checkpoint", "error", "outcome", "meta"], "attempt patch")
      const checkpoint = values.checkpoint === undefined
        ? undefined
        : snapshotJson(values.checkpoint, "checkpoint", maximumCheckpointBytes)
      const attemptError = values.error === undefined ? undefined : snapshotJson(values.error, "error")
      const outcome = values.outcome === undefined ? undefined : snapshotJson(values.outcome, "outcome")
      const meta = values.meta === undefined ? undefined : snapshotJson(values.meta, "meta")
      if (checkpoint !== undefined && !checkpoint.ok) return Effect.fail(checkpoint.error)
      if (attemptError !== undefined && !attemptError.ok) return Effect.fail(attemptError.error)
      if (outcome !== undefined && !outcome.ok) return Effect.fail(outcome.error)
      if (meta !== undefined && !meta.ok) return Effect.fail(meta.error)
      return Effect.succeed(Object.freeze({
        ...(checkpoint === undefined ? {} : { checkpoint: checkpoint.value }),
        ...(attemptError === undefined ? {} : { error: attemptError.value }),
        ...(outcome === undefined ? {} : { outcome: outcome.value }),
        ...(meta === undefined ? {} : { meta: meta.value })
      }))
    } catch {
      return Effect.fail(error("invalid_attempt", "attempt patch must be an inert data record"))
    }
  })

interface ResolvedOptions {
  readonly inProgressStates: ReadonlyArray<string>
  readonly maxCheckpointBytes: number
  readonly putMode: "insert" | "upsert"
}

const snapshotOptions = (input: Options): Effect.Effect<ResolvedOptions, AttemptStoreError> =>
  Effect.suspend(() => {
    try {
      const values = inspectRecord(
        input,
        [],
        ["inProgressStates", "maxCheckpointBytes", "putMode"],
        "attempt store options"
      )
      const rawStates = values.inProgressStates ?? defaultInProgressStates
      const admitted = Boundary.admitJson(rawStates, {
        ...jsonLimits(64 * 1024),
        maxDepth: 2,
        maxMembers: 256,
        maxNodes: 257
      })
      if (!admitted.ok || !Array.isArray(admitted.value)) {
        return Effect.fail(error("invalid_attempt", "inProgressStates must be an inert string array"))
      }
      const states = admitted.value
      if (
        states.length === 0 ||
        states.some((state) => !Boundary.isDurableText(state)) ||
        new Set(states).size !== states.length
      ) {
        return Effect.fail(error("invalid_attempt", "inProgressStates must contain unique durable state names"))
      }
      const maxCheckpointBytes = values.maxCheckpointBytes ?? defaultMaxCheckpointBytes
      if (
        typeof maxCheckpointBytes !== "number" || !Number.isSafeInteger(maxCheckpointBytes) ||
        maxCheckpointBytes <= 0 ||
        maxCheckpointBytes > maximumCheckpointBytes
      ) {
        return Effect.fail(
          error("invalid_attempt", `maxCheckpointBytes must be between 1 and ${maximumCheckpointBytes}`)
        )
      }
      const putMode = values.putMode ?? "insert"
      if (putMode !== "insert" && putMode !== "upsert") {
        return Effect.fail(error("invalid_attempt", "putMode must be insert or upsert"))
      }
      return Effect.succeed(Object.freeze({
        inProgressStates: Object.freeze([...states]) as ReadonlyArray<string>,
        maxCheckpointBytes,
        putMode
      }))
    } catch {
      return Effect.fail(error("invalid_attempt", "attempt store options must be an inert data record"))
    }
  })

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
    "attempt persistence failed"
  )
}

const decodeRow = (input: unknown): Effect.Effect<Attempt, AttemptStoreError> =>
  Schema.decodeUnknownEffect(AttemptRow)(input).pipe(
    Effect.mapError(() => error("decode_failed", "could not decode flows_attempts row")),
    Effect.flatMap((row) => {
      if (
        (row.finished_at_ms !== null && row.finished_at_ms < row.started_at_ms) ||
        (row.heartbeat_at_ms !== null && row.heartbeat_at_ms < row.started_at_ms)
      ) return Effect.fail(error("decode_failed", "flows_attempts row has a reversed lifecycle timeline"))
      return Effect.all({
        checkpoint: decode(row.checkpoint_json, "checkpoint_json", maximumCheckpointBytes),
        error: decode(row.error_json, "error_json"),
        outcome: decode(row.outcome_json, "outcome_json"),
        meta: decodeRequired(row.meta_json, "meta_json")
      }).pipe(
        Effect.map(({ checkpoint, error: attemptError, outcome, meta }) => Object.freeze({
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
    })
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

    const configured = yield* snapshotOptions(options)
    const inProgressStates = configured.inProgressStates
    const maxCheckpointBytes = configured.maxCheckpointBytes
    const upsert = configured.putMode === "upsert"
    const encodeOptional = encodeOptionalWith(encode)
    const encodeCheckpoint = encodeCheckpointWith(maxCheckpointBytes, encodeOptional)
    const inProgress = sql.in("state", [...inProgressStates])

    const put: Service["put"] = Effect.fn("AttemptStore.put")((input, owner) =>
      Effect.gen(function*() {
        const attempt = yield* snapshotAttempt(input)
        yield* Effect.annotateCurrentSpan({
          runId: attempt.runId,
          stepKeyDigest: attempt.stepKeyDigest,
          attempt: attempt.attempt
        })
        if (
          (attempt.finishedAtMs !== undefined && attempt.finishedAtMs < attempt.startedAtMs) ||
          (attempt.heartbeatAtMs !== undefined && attempt.heartbeatAtMs < attempt.startedAtMs)
        ) {
          return yield* Effect.fail(error("invalid_attempt", "attempt lifecycle timestamps must not precede start"))
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

    const get: Service["get"] = Effect.fn("AttemptStore.get")((input) =>
      Effect.gen(function*() {
        const id = yield* snapshotId(input)
        yield* Effect.annotateCurrentSpan({
          runId: id.runId,
          stepKeyDigest: id.stepKeyDigest,
          attempt: id.attempt
        })
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
              heartbeat_at_ms = MAX(COALESCE(heartbeat_at_ms, started_at_ms), ${nowMs}),
              checkpoint_json = COALESCE(${checkpoint}, checkpoint_json)
            WHERE run_id = ${runId}
              AND step_key_digest = ${stepKeyDigest}
              AND attempt = ${attempt}
              AND ${inProgress}
              AND started_at_ms <= ${nowMs}
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
            const found = yield* sql<Pick<AttemptRow, "state" | "started_at_ms">>`
            SELECT state, started_at_ms FROM flows_attempts
            WHERE run_id = ${runId} AND step_key_digest = ${stepKeyDigest} AND attempt = ${attempt}
          `
            if (found.length === 0) {
              return { _tag: "NotFound" } as const
            }
            const runRows = yield* sql<RunFenceRow>`
            SELECT status, owner_host_id, owner_pid, owner_nonce
            FROM flows_runs WHERE run_id = ${runId}
          `
            if (runRows.length === 0 || !ownsRunningRun(runRows[0]!, owner)) {
              return { _tag: "FenceLost" } as const
            }
            if (inProgressStates.includes(found[0]!.state) && nowMs < found[0]!.started_at_ms) {
              return yield* Effect.fail(error("invalid_attempt", "heartbeat timestamp precedes attempt start"))
            }
            return { _tag: "StateChanged" } as const
          })
        ).pipe(Effect.mapError(mapPersistenceError))
      })
    )

    const finish: Service["finish"] = Effect.fn("AttemptStore.finish")((input, owner) =>
      Effect.gen(function*() {
        const attempt = yield* snapshotFinish(input)
        yield* Effect.annotateCurrentSpan({
          runId: attempt.runId,
          stepKeyDigest: attempt.stepKeyDigest,
          attempt: attempt.attempt
        })
        if (
          inProgressStates.includes(attempt.state) ||
          !Boundary.isDurableText(attempt.state)
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
              AND started_at_ms <= ${attempt.finishedAtMs}
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
            const found = yield* sql<Pick<AttemptRow, "state" | "started_at_ms">>`
            SELECT state, started_at_ms FROM flows_attempts
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
            if (runRows.length === 0 || !ownsRunningRun(runRows[0]!, owner)) {
              return { _tag: "FenceLost" } as const
            }
            if (inProgressStates.includes(found[0]!.state) && attempt.finishedAtMs < found[0]!.started_at_ms) {
              return yield* Effect.fail(error("invalid_attempt", "finish timestamp precedes attempt start"))
            }
            return { _tag: "StateChanged" } as const
          })
        ).pipe(Effect.mapError(mapPersistenceError))
      })
    )

    const patch: Service["patch"] = Effect.fn("AttemptStore.patch")((idInput, patchInput, owner) =>
      Effect.gen(function*() {
        const id = yield* snapshotId(idInput)
        const fields = yield* snapshotPatch(patchInput)
        yield* Effect.annotateCurrentSpan({
          runId: id.runId,
          stepKeyDigest: id.stepKeyDigest,
          attempt: id.attempt
        })
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
