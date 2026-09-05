/**
 * Versioned engine history contracts over the open journal. These schemas do
 * not change journal admission or make history the engine's recovery store.
 *
 * @since 1.0.0
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Event from "./JournalEvent.ts"

/**
 * Required lineage coordinates for a root or derived run.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Lineage = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("root"),
    runId: Event.RunId,
    lineageId: Event.LineageId,
    rootRunId: Event.RunId,
    round: Schema.Literal(0),
    parentRunId: Schema.Null
  }).check(Schema.makeFilter((value) => value.runId === value.rootRunId)),
  Schema.Struct({
    kind: Schema.Literals(["child", "fork", "continuation"]),
    runId: Event.RunId,
    lineageId: Event.LineageId,
    rootRunId: Event.RunId,
    round: Event.NonNegativeQuantity,
    parentRunId: Event.RunId
  }).check(Schema.makeFilter((value) =>
    value.runId !== value.parentRunId && value.runId !== value.rootRunId &&
    (value.kind !== "continuation" || value.round > 0)
  ))
])

/**
 * Required lineage coordinates for a root or derived run.
 *
 * @category models
 * @since 1.0.0
 */
export type Lineage = typeof Lineage.Type

/**
 * Encoded values only: class instances must first pass their own codec.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Success = Schema.TaggedStruct("Success", { value: Schema.Json })

/**
 * Failure channels stay distinct, including interruption and encoding failure.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Failure = Schema.TaggedStruct("Failure", {
  reason: Schema.Literals(["error", "defect", "interrupted", "encoding"]),
  detail: Schema.Json
})

/**
 * Encoded success or a classified failure.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ResultEnvelope = Schema.Union([Success, Failure])
/**
 * Encoded success or a classified failure.
 *
 * @category models
 * @since 1.0.0
 */
export type ResultEnvelope = typeof ResultEnvelope.Type

const timing = { startedAtMs: Event.TimestampMs }
const live = {
  ...timing,
  heartbeatAtMs: Schema.optionalKey(Event.TimestampMs),
  checkpoint: Schema.optionalKey(Schema.Json),
  finishedAtMs: Schema.optionalKey(Schema.Never),
  result: Schema.optionalKey(Schema.Never)
}

/**
 * Completion and its outcome are inseparable; live states cannot carry either.
 *
 * @category schemas
 * @since 1.0.0
 */
export const AttemptLifecycle = Schema.Union([
  Schema.Struct({ state: Schema.Literal("running"), ...live }),
  Schema.Struct({ state: Schema.Literal("suspended"), ...live }),
  Schema.Struct({
    state: Schema.Literal("succeeded"),
    ...timing,
    finishedAtMs: Event.TimestampMs,
    result: Success
  }),
  Schema.Struct({
    state: Schema.Literal("failed"),
    ...timing,
    finishedAtMs: Event.TimestampMs,
    result: Failure
  })
])

/**
 * Wall clocks can move backwards; completion need not be after start.
 *
 * @category models
 * @since 1.0.0
 */
export type AttemptLifecycle = typeof AttemptLifecycle.Type

/**
 * Complete identity and state of one versioned attempt event.
 *
 * @category schemas
 * @since 1.0.0
 */
export const AttemptPayload = Schema.Struct({
  version: Schema.Literal(2),
  lineage: Lineage,
  executionId: Event.RunId,
  stepKeyDigest: Event.DispatchId,
  attempt: Event.NonNegativeQuantity,
  lifecycle: AttemptLifecycle
}).check(Schema.makeFilter((value) => value.executionId === value.lineage.runId))

/**
 * Complete identity and state of one versioned attempt event.
 *
 * @category models
 * @since 1.0.0
 */
export type AttemptPayload = typeof AttemptPayload.Type

/**
 * Durable wait identities; ownership and cancellation remain independent facts.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Wait = Schema.Union([
  Schema.TaggedStruct("Deferred", { waitId: Event.WaitId }),
  Schema.TaggedStruct("Clock", { waitId: Event.WaitId, dueAtMs: Event.TimestampMs })
])

/**
 * A complete execution observation, without operational ownership leases.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ExecutionLifecycle = Schema.Union([
  Schema.Struct({ state: Schema.Literal("running"), waits: Schema.Array(Wait) }),
  Schema.Struct({ state: Schema.Literal("suspended"), waits: Schema.NonEmptyArray(Wait) }),
  Schema.Struct({ state: Schema.Literal("completed"), result: ResultEnvelope })
])

/**
 * Versioned execution, deferred and clock observations. Every variant records
 * its semantic identity and encoded value independently of diagnostics.
 *
 * @category schemas
 * @since 1.0.0
 */
export const StatePayload = Schema.Struct({
  version: Schema.Literal(2),
  lineage: Lineage,
  executionId: Event.RunId,
  event: Schema.Union([
    Schema.TaggedStruct("Execution", { lifecycle: ExecutionLifecycle }),
    Schema.TaggedStruct("DeferredCompleted", { waitId: Event.WaitId, result: ResultEnvelope }),
    Schema.TaggedStruct("ClockScheduled", {
      clockId: Event.CommandId,
      waitId: Event.WaitId,
      dueAtMs: Event.TimestampMs
    })
  ])
}).check(Schema.makeFilter((value) => value.executionId === value.lineage.runId))

/**
 * Versioned execution, deferred and clock observations.
 *
 * @category models
 * @since 1.0.0
 */
export type StatePayload = typeof StatePayload.Type

/**
 * Event family for complete execution, deferred and clock observations.
 *
 * @category constants
 * @since 1.0.0
 */
export const stateEventType = "flows.engine.v2.state-event"

/**
 * New identity prevents old readers mistaking complete state for historical markers.
 *
 * @category constants
 * @since 1.0.0
 */
export const attemptEventType = "flows.engine.v2.attempt-lifecycle"

/**
 * Malformed, foreign, unsupported or inconsistent event evidence.
 *
 * @category errors
 * @since 1.0.0
 */
export class EventError extends Schema.TaggedError<EventError>()("@smthrs/journal/EngineEventError", {
  code: Schema.Literals(["malformed", "unsupported", "foreign", "transition"]),
  message: Schema.String,
  cause: Schema.Unknown
}) {}

/**
 * Every consumer chooses its source allowlist and unknown-namespace policy.
 *
 * @category models
 * @since 1.0.0
 */
export interface Consumer {
  readonly runId: Event.RunId
  readonly lineageId: Event.LineageId
  readonly rootRunId: Event.RunId
  readonly round: number
  readonly parentRunId: Event.RunId | null
  readonly sources: ReadonlyArray<Event.SourceId>
  readonly unknown: "ignore" | "surface"
}

/**
 * A known event or the explicitly selected extension outcome.
 *
 * @category models
 * @since 1.0.0
 */
export type Decoded =
  | { readonly _tag: "Attempt"; readonly entry: Event.Entry; readonly payload: AttemptPayload }
  | { readonly _tag: "State"; readonly entry: Event.Entry; readonly payload: StatePayload }
  | { readonly _tag: "Ignored" }
  | { readonly _tag: "Unknown"; readonly entry: Event.Entry }

const strict = { onExcessProperty: "error" } as const
const decodeRow = (input: unknown) =>
  Effect.gen(function*() {
    const raw = yield* Schema.decodeUnknownEffect(Schema.toEncoded(Event.Entry))(input)
    return yield* Schema.decodeUnknownEffect(Event.Entry)(raw)
  })
const decodePayload = Schema.decodeUnknownSync(AttemptPayload, strict)
const decodeJson = Schema.decodeUnknownSync(Schema.Json)

/**
 * Decode untrusted committed input. Unknown events in the known engine namespace
 * are unsupported errors, never ignored. Original schema/accessor errors stay
 * in cause; foreign identity includes the conflicting evidence in cause.
 *
 * @category decoders
 * @since 1.0.0
 */
export const decodeEntry = (input: unknown, consumer: Consumer): Effect.Effect<Decoded, EventError> =>
  Effect.gen(function*(): Effect.fn.Return<Decoded, unknown> {
    const entry = yield* decodeRow(input)
    if (entry.runId !== consumer.runId || !consumer.sources.includes(entry.sourceId)) {
      throw new EventError({
        code: "foreign",
        message: "event run or source is outside the consumer scope",
        cause: entry
      })
    }
    if (entry.eventType !== attemptEventType && entry.eventType !== stateEventType) {
      if (entry.eventType.startsWith("flows.engine.")) {
        throw new EventError({
          code: "unsupported",
          message: "unsupported engine event family or version",
          cause: entry
        })
      }
      return consumer.unknown === "ignore" ? { _tag: "Ignored" } : { _tag: "Unknown", entry }
    }
    const decoded = entry.eventType === attemptEventType
      ? { _tag: "Attempt" as const, payload: yield* Schema.decodeUnknownEffect(AttemptPayload, strict)(entry.payload) }
      : { _tag: "State" as const, payload: yield* Schema.decodeUnknownEffect(StatePayload, strict)(entry.payload) }
    const { payload } = decoded
    if (
      payload.lineage.runId !== entry.runId || payload.lineage.lineageId !== consumer.lineageId ||
      payload.lineage.rootRunId !== consumer.rootRunId || payload.lineage.round !== consumer.round ||
      payload.lineage.parentRunId !== consumer.parentRunId
    ) {
      throw new EventError({
        code: "foreign",
        message: "event lineage disagrees with its journal or consumer",
        cause: payload.lineage
      })
    }
    // The optional journal side channel is disclosure only. Semantic lineage
    // lives in payload and cannot be replaced by diagnostic metadata.
    yield* Schema.decodeUnknownEffect(Schema.Json)(entry.meta)
    return { ...decoded, entry }
  }).pipe(Effect.catchCause((failure) => {
    const cause = Cause.squash(failure)
    return Effect.fail(
      cause instanceof EventError
        ? cause
        : new EventError({ code: "malformed", message: "invalid engine event", cause })
    )
  }))

/**
 * Construct a versioned submission, validating before journal redaction.
 *
 * @category constructors
 * @since 1.0.0
 */
export const attempt = (
  payload: AttemptPayload,
  sourceId: Event.SourceId,
  sourceSeq: Event.SourceSeq,
  diagnostics: Schema.Json = null
): Event.Input => {
  const validated = decodePayload(payload)
  return new Event.Input({
    runId: validated.lineage.runId,
    sourceId,
    sourceSeq,
    eventType: attemptEventType,
    payload: validated,
    meta: decodeJson(diagnostics)
  })
}

/**
 * Construct a versioned execution, deferred or clock submission. Existing
 * unversioned writers are unchanged and cannot manufacture missing lineage.
 *
 * @category constructors
 * @since 1.0.0
 */
export const stateEvent = (
  payload: StatePayload,
  sourceId: Event.SourceId,
  sourceSeq: Event.SourceSeq,
  diagnostics: Schema.Json = null
): Event.Input => {
  const validated = Schema.decodeUnknownSync(StatePayload, strict)(payload)
  return new Event.Input({
    runId: validated.lineage.runId,
    sourceId,
    sourceSeq,
    eventType: stateEventType,
    payload: validated,
    meta: decodeJson(diagnostics)
  })
}

/**
 * Historical attempt markers deliberately remain incomplete evidence. No
 * result, timestamp, round or lineage root is invented for old rows.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CurrentAttempt = Schema.Union([
  Schema.Struct({
    eventType: Schema.Literal("flows.engine.attempt-started"),
    payload: Schema.Struct({
      version: Schema.optionalKey(Schema.Never),
      runId: Event.RunId,
      stepKeyDigest: Event.DispatchId,
      attempt: Event.NonNegativeQuantity,
      tier: Schema.Literals(["sealed", "compensable", "irreversible"])
    })
  }),
  Schema.Struct({
    eventType: Schema.Literal("flows.engine.attempt-finished"),
    payload: Schema.Struct({
      version: Schema.optionalKey(Schema.Never),
      runId: Event.RunId,
      stepKeyDigest: Event.DispatchId,
      attempt: Event.NonNegativeQuantity,
      state: Schema.Literals(["succeeded", "failed"])
    })
  })
])

/**
 * Decode current markers using their recorded lineage, without upgrading bytes.
 *
 * @category decoders
 * @since 1.0.0
 */
export const decodeCurrentAttempt = (input: unknown, consumer: Consumer) =>
  Effect.gen(function*() {
    const entry = yield* decodeRow(input)
    const marker = yield* Schema.decodeUnknownEffect(CurrentAttempt)(entry)
    const meta = yield* Schema.decodeUnknownEffect(Schema.Struct({ lineageId: Event.LineageId }))(entry.meta)
    if (
      entry.runId !== consumer.runId || marker.payload.runId !== entry.runId ||
      meta.lineageId !== consumer.lineageId || !consumer.sources.includes(entry.sourceId)
    ) {
      throw new EventError({
        code: "foreign",
        message: "current attempt marker is outside the consumer scope",
        cause: entry
      })
    }
    return { entry, marker, lineageId: meta.lineageId }
  }).pipe(Effect.catchCause((failure) => {
    const cause = Cause.squash(failure)
    return Effect.fail(
      cause instanceof EventError
        ? cause
        : new EventError({ code: "malformed", message: "invalid current attempt marker", cause })
    )
  }))
