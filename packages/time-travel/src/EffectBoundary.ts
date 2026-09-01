/**
 * Journaled execution boundary for tiered effects.
 *
 * @since 0.1.0
 */
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import { OwnerId } from "@smthrs/journal/OwnerId"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { error, type TimeTravelError } from "./TimeTravelError.ts"

/**
 * The three effect tiers used by replay, compensation, and retry.
 *
 * @since 0.1.0
 * @category models
 */
export const EffectTier = Schema.Literals(["sealed", "compensable", "irreversible"])
/**
 * The value form of {@link EffectTier}.
 *
 * @since 0.1.0
 * @category models
 */
export type EffectTier = typeof EffectTier.Type

/**
 * Monotonic completion evidence recorded around an effect.
 *
 * @since 0.1.0
 * @category models
 */
export const EffectStatus = Schema.Literals(["intended", "succeeded", "unknown"])
/**
 * The value form of {@link EffectStatus}.
 *
 * @since 0.1.0
 * @category models
 */
export type EffectStatus = typeof EffectStatus.Type

/**
 * Stable event type emitted for effect-boundary evidence.
 *
 * @since 0.1.0
 * @category constants
 */
export const eventType = "flows.time-travel.effect-boundary"

/**
 * A normalized effect reconstructed from boundary journal entries.
 *
 * @since 0.1.0
 * @category models
 */
export const EffectRecord = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.NonEmptyString,
  tier: EffectTier,
  status: EffectStatus,
  runId: Schema.NonEmptyString,
  lineageId: Schema.NonEmptyString,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  input: Schema.optionalKey(Schema.Unknown),
  output: Schema.optionalKey(Schema.Unknown),
  cacheKey: Schema.optionalKey(Schema.NonEmptyString),
  changeId: Schema.optionalKey(Schema.NonEmptyString),
  idempotencyKey: Schema.optionalKey(Schema.NonEmptyString),
  /**
   * The stable compensation descriptor the adapter that performed this effect
   * owns. `docs/specs/Concepts/Time Travel Compensation.md` puts it in the
   * entry so a rewind's handler preflight resolves against recorded evidence
   * rather than inferring a compensation from the effect kind alone.
   */
  compensation: Schema.optionalKey(Schema.NonEmptyString),
  residue: Schema.optionalKey(Schema.String),
  durableBoundary: Schema.Boolean,
  providerStream: Schema.Boolean,
  attempt: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  nonce: Schema.optionalKey(Schema.NonEmptyString)
})
/**
 * The value form of {@link EffectRecord}.
 *
 * @since 0.1.0
 * @category models
 */
export type EffectRecord = typeof EffectRecord.Type

/**
 * Description supplied before an action crosses its effect boundary.
 *
 * @since 0.1.0
 * @category models
 */
export const Description = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.NonEmptyString,
  tier: EffectTier,
  runId: Schema.NonEmptyString,
  lineageId: Schema.NonEmptyString,
  owner: OwnerId,
  sourceId: Schema.NonEmptyString,
  sourceSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  input: Schema.optionalKey(Schema.Unknown),
  cacheKey: Schema.optionalKey(Schema.NonEmptyString),
  changeId: Schema.optionalKey(Schema.NonEmptyString),
  idempotencyKey: Schema.optionalKey(Schema.NonEmptyString),
  /**
   * The stable compensation descriptor the adapter that performed this effect
   * owns. `docs/specs/Concepts/Time Travel Compensation.md` puts it in the
   * entry so a rewind's handler preflight resolves against recorded evidence
   * rather than inferring a compensation from the effect kind alone.
   */
  compensation: Schema.optionalKey(Schema.NonEmptyString),
  residue: Schema.optionalKey(Schema.String),
  durableBoundary: Schema.optionalKey(Schema.Boolean),
  providerStream: Schema.optionalKey(Schema.Boolean),
  attempt: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  nonce: Schema.optionalKey(Schema.NonEmptyString),
  metadata: Schema.optionalKey(Schema.Unknown)
})
/**
 * The value form of {@link Description}.
 *
 * @since 0.1.0
 * @category models
 */
export type Description = typeof Description.Type

const Metadata = Schema.Record(Schema.String, Schema.Unknown)
const isMetadata = Schema.is(Metadata)

const metadata = (
  description: Description,
  status: EffectStatus
): Readonly<Record<string, unknown>> => ({
  ...(isMetadata(description.metadata) ? description.metadata : { upstream: description.metadata }),
  lineageId: description.lineageId,
  ...(description.cacheKey === undefined ? {} : { cacheKey: description.cacheKey }),
  timeTravel: {
    effectId: description.id,
    kind: description.kind,
    tier: description.tier,
    status
  }
})

const record = (
  description: Description,
  status: EffectStatus,
  output?: unknown
): Omit<EffectRecord, "seq"> => ({
  id: description.id,
  kind: description.kind,
  tier: description.tier,
  status,
  runId: description.runId,
  lineageId: description.lineageId,
  ...(description.input === undefined ? {} : { input: description.input }),
  ...(output === undefined ? {} : { output }),
  ...(description.cacheKey === undefined ? {} : { cacheKey: description.cacheKey }),
  ...(description.changeId === undefined ? {} : { changeId: description.changeId }),
  ...(description.idempotencyKey === undefined ? {} : { idempotencyKey: description.idempotencyKey }),
  ...(description.residue === undefined ? {} : { residue: description.residue }),
  ...(description.compensation === undefined ? {} : { compensation: description.compensation }),
  durableBoundary: description.durableBoundary ?? true,
  providerStream: description.providerStream ?? false,
  ...(description.attempt === undefined ? {} : { attempt: description.attempt }),
  ...(description.nonce === undefined ? {} : { nonce: description.nonce })
})

const emit = (
  journal: Journal.Service,
  description: Description,
  status: EffectStatus,
  output?: unknown
): Effect.Effect<Journal.DurableReceipt, TimeTravelError> => {
  const sourceSeq = (description.sourceSeq + (status === "intended" ? 0 : 1)) as JournalEvent.SourceSeq
  const input: JournalEvent.Input = {
    runId: description.runId as JournalEvent.RunId,
    sourceId: description.sourceId as JournalEvent.SourceId,
    sourceSeq,
    eventType,
    payload: { version: 1, effect: record(description, status, output) },
    meta: metadata(description, status)
  }
  return journal.emitDurable(input, description.owner).pipe(
    Effect.mapError((cause) =>
      error("unknown", `could not record ${status} boundary for effect ${description.id}`, cause)
    )
  )
}

/**
 * Runs an action between durable `intended` and terminal boundary records.
 *
 * Interruption, defects, and typed failures all settle the boundary as
 * `unknown` before their original cause is re-raised. The settlement section
 * is uninterruptible so cancellation cannot strand an in-memory action
 * after it has crossed the boundary without attempting the terminal record.
 *
 * @since 0.1.0
 * @category combinators
 */
export const guard = <A, E, R>(
  description: Description,
  action: Effect.Effect<A, E, R>
): Effect.Effect<A, E | TimeTravelError, R | Journal.Journal> =>
  Effect.gen(function*() {
    const validated = yield* Schema.decodeUnknownEffect(Description)(description).pipe(
      Effect.mapError((cause) => error("invalid", "effect boundary description is invalid", cause))
    )
    if (validated.sourceSeq === Number.MAX_SAFE_INTEGER) {
      return yield* Effect.fail(error("invalid", `effect ${validated.id} has no terminal source sequence`))
    }
    if (validated.tier === "irreversible" && validated.idempotencyKey === undefined) {
      return yield* Effect.fail(
        error("invalid", `irreversible effect ${validated.id} requires an idempotency key`)
      )
    }
    const journal = yield* Journal.Journal
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function*() {
        const intended = yield* emit(journal, validated, "intended")
        if (intended._tag === "Duplicate") {
          // `already_crossed` rather than `busy`: the closed code list exists so
          // a caller can branch on WHY, and `busy` is the code a contended run
          // raises. A re-armed effect and a rewind holding the run are different
          // answers to "why was this refused", and they need different codes.
          return yield* Effect.fail(
            error(
              "already_crossed",
              `effect ${validated.id} already crossed its durable boundary; refusing to execute it again`
            )
          )
        }
        const actionExit = yield* Effect.exit(restore(action))
        if (Exit.isSuccess(actionExit)) {
          yield* emit(journal, validated, "succeeded", actionExit.value)
          return actionExit.value
        }
        yield* Effect.ignore(emit(journal, validated, "unknown"))
        return yield* Effect.failCause(actionExit.cause)
      })
    )
  })

const BoundaryRecord = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.NonEmptyString,
  tier: EffectTier,
  status: EffectStatus,
  runId: Schema.NonEmptyString,
  lineageId: Schema.NonEmptyString,
  input: Schema.optionalKey(Schema.Unknown),
  output: Schema.optionalKey(Schema.Unknown),
  cacheKey: Schema.optionalKey(Schema.NonEmptyString),
  changeId: Schema.optionalKey(Schema.NonEmptyString),
  idempotencyKey: Schema.optionalKey(Schema.NonEmptyString),
  /**
   * The stable compensation descriptor the adapter that performed this effect
   * owns. `docs/specs/Concepts/Time Travel Compensation.md` puts it in the
   * entry so a rewind's handler preflight resolves against recorded evidence
   * rather than inferring a compensation from the effect kind alone.
   */
  compensation: Schema.optionalKey(Schema.NonEmptyString),
  residue: Schema.optionalKey(Schema.String),
  durableBoundary: Schema.optionalKey(Schema.Boolean),
  providerStream: Schema.optionalKey(Schema.Boolean),
  attempt: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  nonce: Schema.optionalKey(Schema.NonEmptyString)
})
const BoundaryPayload = Schema.Struct({
  version: Schema.Literal(1),
  effect: BoundaryRecord
})

/**
 * Decodes one boundary record from a journal entry.
 *
 * Unknown event types and malformed additive metadata are ignored so this
 * projection remains forward-compatible with unrelated journal records.
 *
 * @since 0.1.0
 * @category decoders
 */
export const fromEntry = (
  entry: JournalEvent.Entry
): EffectRecord | undefined => {
  if (entry.eventType !== eventType) return undefined
  const payload = Option.getOrUndefined(Schema.decodeUnknownOption(BoundaryPayload)(entry.payload))
  if (payload === undefined) return undefined
  const effect = payload.effect
  return {
    ...effect,
    seq: entry.seq,
    durableBoundary: effect.durableBoundary !== false,
    providerStream: effect.providerStream === true
  }
}

/**
 * Decodes a known boundary event, failing closed when its durable payload is corrupt.
 *
 * @since 0.1.0
 * @category decoders
 */
export const decodeEntry = (
  entry: JournalEvent.Entry
): Effect.Effect<EffectRecord | undefined, TimeTravelError> => {
  if (entry.eventType !== eventType) return Effect.succeed(undefined)
  return Schema.decodeUnknownEffect(BoundaryPayload)(entry.payload).pipe(
    Effect.map(({ effect }) => ({
      ...effect,
      seq: entry.seq,
      durableBoundary: effect.durableBoundary !== false,
      providerStream: effect.providerStream === true
    })),
    Effect.mapError((cause) =>
      error("invalid", `boundary event ${entry.eventId} has an invalid or unsupported payload`, cause)
    )
  )
}

/**
 * Folds boundary entries to the latest monotonic status for each effect while
 * retaining the sequence of the effect's last boundary record.
 *
 * @since 0.1.0
 * @category projections
 */
export const fromEntries = (
  entries: ReadonlyArray<JournalEvent.Entry>
): Effect.Effect<ReadonlyArray<EffectRecord>, TimeTravelError> =>
  Effect.gen(function*() {
    const effects = new Map<string, EffectRecord>()
    for (const entry of entries) {
      const decoded = yield* decodeEntry(entry)
      if (decoded !== undefined) effects.set(decoded.id, decoded)
    }
    return Array.from(effects.values()).sort((left, right) => left.seq - right.seq)
  })
