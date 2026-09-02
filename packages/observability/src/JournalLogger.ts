/**
 * Non-blocking forwarding of bounded operational logs to the durable journal.
 *
 * @since 0.1.0
 */
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Redaction from "@smthrs/journal/Redaction"
import type * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import type * as LogLevel from "effect/LogLevel"
import * as Queue from "effect/Queue"
import * as References from "effect/References"
import * as Schema from "effect/Schema"

/**
 * Largest queue accepted by the forwarding logger.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumCapacity = 65_536

/**
 * Largest detached log payload admitted to the asynchronous queue.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumSnapshotBytes = 1024 * 1024

/**
 * Largest number of container members copied into one detached log payload.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumSnapshotMembers = 4_096

/**
 * Deepest container path copied into one detached log payload.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumSnapshotDepth = 64

/**
 * What a hostile or unreadable logged value becomes.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const unrenderableMarker = "[Unrenderable]"

/**
 * What a value beyond a logger resource ceiling becomes.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const truncatedMarker = "[Truncated]"

/**
 * Options for the journal forwarding logger.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
  readonly runId: JournalEvent.RunId
  readonly capacity?: number | undefined
  readonly minimumLogLevel?: LogLevel.LogLevel | undefined
  readonly mergeWithExisting?: boolean | undefined
}

/**
 * A stable logger configuration refusal.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class InvalidJournalLoggerOptions extends Schema.TaggedError<InvalidJournalLoggerOptions>()(
  "@smthrs/observability/InvalidJournalLoggerOptions",
  {
    code: Schema.Literal("invalid_journal_logger_options"),
    path: Schema.String,
    message: Schema.String
  }
) {}

/**
 * One typed failure retained from an Effect cause.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const TelemetryFail = Schema.Struct({
  _tag: Schema.Literal("Fail"),
  error: Schema.Unknown
})

/**
 * One unexpected defect retained from an Effect cause.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const TelemetryDie = Schema.Struct({
  _tag: Schema.Literal("Die"),
  defect: Schema.Unknown
})

/**
 * One interruption retained from an Effect cause.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const TelemetryInterrupt = Schema.Struct({
  _tag: Schema.Literal("Interrupt"),
  fiberId: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
})

/**
 * One reason in a persisted telemetry cause.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const TelemetryCauseReason = Schema.Union([TelemetryFail, TelemetryDie, TelemetryInterrupt])

/**
 * One reason in a persisted telemetry cause.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type TelemetryCauseReason = typeof TelemetryCauseReason.Type

/**
 * A versioned structural Effect cause.
 *
 * Effect 4 stores composed failures as an ordered reason list. The projection
 * preserves that order and each fail, defect, or interrupt discriminator.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const TelemetryCause = Schema.Struct({
  version: Schema.Literal(1),
  reasons: Schema.Array(TelemetryCauseReason)
})

/**
 * A versioned structural Effect cause.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type TelemetryCause = typeof TelemetryCause.Type

/**
 * Runtime schema for the operational log payload written to the journal.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const TelemetryLog = Schema.Struct({
  version: Schema.Literal(1),
  level: Schema.Literals(["All", "Fatal", "Error", "Warn", "Info", "Debug", "Trace", "None"]),
  message: Schema.Unknown,
  annotations: Schema.Record(Schema.String, Schema.Unknown),
  cause: TelemetryCause,
  fiberId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  traceId: Schema.optionalKey(Schema.String),
  spanId: Schema.optionalKey(Schema.String),
  timestamp: Schema.String
})

/**
 * Versioned operational log payload written to the journal.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type TelemetryLog = typeof TelemetryLog.Type

const sourceId = "flows/observability/logger" as JournalEvent.SourceId
const encoder = new TextEncoder()

const OptionsSchema = Schema.Struct({
  runId: JournalEvent.RunId,
  capacity: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(maximumCapacity)
    )
  ),
  minimumLogLevel: Schema.optional(
    Schema.Literals(["All", "Fatal", "Error", "Warn", "Info", "Debug", "Trace", "None"])
  ),
  mergeWithExisting: Schema.optional(Schema.Boolean)
})

const schemaPath = (error: unknown): string => {
  let issue = (error as { readonly issue?: unknown } | null)?.issue
  const segments: Array<string> = []
  for (let depth = 0; depth < 64 && typeof issue === "object" && issue !== null; depth++) {
    const node = issue as { readonly path?: unknown; readonly issue?: unknown; readonly issues?: unknown }
    if (Array.isArray(node.path)) segments.push(...node.path.map(String))
    if (node.issue !== undefined) {
      issue = node.issue
      continue
    }
    if (Array.isArray(node.issues) && node.issues[0] !== undefined) {
      issue = node.issues[0]
      continue
    }
    break
  }
  return segments.join(".") || "options"
}

const validateOptions = (options: Options) =>
  Schema.decodeUnknownEffect(OptionsSchema)(options).pipe(
    Effect.mapError((cause) => {
      const path = schemaPath(cause)
      return new InvalidJournalLoggerOptions({
        code: "invalid_journal_logger_options",
        path,
        message: `journal logger ${path} is invalid`
      })
    })
  )

interface SnapshotBudget {
  bytes: number
  members: number
}

const reserve = (budget: SnapshotBudget, bytes: number): boolean => {
  if (bytes > budget.bytes) return false
  budget.bytes -= bytes
  return true
}

const textBytes = (value: string): number => encoder.encode(JSON.stringify(value)).byteLength

const boundedText = (value: string, budget: SnapshotBudget): string => {
  const direct = value.length <= maximumSnapshotBytes ? value : value.slice(0, maximumSnapshotBytes)
  const bytes = textBytes(direct)
  if (direct.length === value.length && reserve(budget, bytes)) return direct
  let low = 0
  let high = direct.length
  const markerBytes = textBytes(truncatedMarker)
  const available = Math.max(0, budget.bytes - markerBytes)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (textBytes(direct.slice(0, middle)) <= available) low = middle
    else high = middle - 1
  }
  const prefix = direct.slice(0, low)
  budget.bytes = Math.max(0, budget.bytes - textBytes(prefix) - markerBytes)
  return `${prefix}${truncatedMarker}`
}

const snapshotValue = (
  value: unknown,
  budget: SnapshotBudget,
  ancestors: WeakSet<object>,
  depth = 0
): unknown => {
  if (budget.bytes <= 0) return truncatedMarker
  if (depth > maximumSnapshotDepth) return Redaction.depthMarker
  if (typeof value === "string") return boundedText(value, budget)
  if (typeof value === "number") {
    const projected = Number.isFinite(value) ? value : String(value)
    reserve(budget, String(projected).length)
    return projected
  }
  if (typeof value === "boolean" || value === null) {
    reserve(budget, value === null ? 4 : value ? 4 : 5)
    return value
  }
  if (typeof value === "bigint") return boundedText(`${value}n`, budget)
  if (value === undefined) return boundedText("[Undefined]", budget)
  if (typeof value === "function") return boundedText(Redaction.functionMarker, budget)
  if (typeof value === "symbol") return boundedText(Redaction.symbolMarker, budget)
  try {
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      return boundedText(Redaction.binaryMarker, budget)
    }
  } catch {
    return boundedText(unrenderableMarker, budget)
  }
  if (ancestors.has(value)) return boundedText("[Circular]", budget)
  ancestors.add(value)
  try {
    if (value instanceof Date) {
      try {
        return boundedText(value.toISOString(), budget)
      } catch {
        return boundedText(unrenderableMarker, budget)
      }
    }
    if (value instanceof Error) {
      const record: Record<string, unknown> = Object.create(null)
      for (const key of (["name", "message", "stack", "cause"] as const).slice(0, budget.members)) {
        budget.members--
        try {
          record[key] = snapshotValue(value[key], budget, ancestors, depth + 1)
        } catch {
          record[key] = unrenderableMarker
        }
      }
      return record
    }
    if (Array.isArray(value)) {
      const output: Array<unknown> = []
      const length = value.length
      for (let index = 0; index < length && budget.members > 0; index++) {
        budget.members--
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        output.push(
          descriptor === undefined || !("value" in descriptor)
            ? unrenderableMarker
            : snapshotValue(descriptor.value, budget, ancestors, depth + 1)
        )
      }
      if (output.length < length) output.push(truncatedMarker)
      return output
    }
    const record: Record<string, unknown> = Object.create(null)
    const names = Object.getOwnPropertyNames(value)
    for (let index = 0; index < names.length && budget.members > 0; index++) {
      budget.members--
      const key = names[index]!
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      const boundedKey = boundedText(key, budget)
      record[boundedKey] = descriptor !== undefined && "value" in descriptor
        ? snapshotValue(descriptor.value, budget, ancestors, depth + 1)
        : unrenderableMarker
    }
    if (Object.keys(record).length < names.length) record[truncatedMarker] = truncatedMarker
    return record
  } catch {
    return boundedText(unrenderableMarker, budget)
  } finally {
    ancestors.delete(value)
  }
}

const snapshotCause = (cause: Cause.Cause<unknown>, budget: SnapshotBudget): TelemetryCause => ({
  version: 1,
  reasons: cause.reasons.slice(0, maximumSnapshotMembers).map((reason): TelemetryCauseReason => {
    switch (reason._tag) {
      case "Fail":
        return { _tag: "Fail", error: snapshotValue(reason.error, budget, new WeakSet()) }
      case "Die":
        return { _tag: "Die", defect: snapshotValue(reason.defect, budget, new WeakSet()) }
      case "Interrupt":
        return { _tag: "Interrupt", fiberId: reason.fiberId ?? null }
    }
  })
})

const snapshotLog = (options: Logger.Options<unknown>): TelemetryLog => {
  const budget: SnapshotBudget = {
    bytes: maximumSnapshotBytes,
    members: maximumSnapshotMembers
  }
  try {
    const span = options.fiber.currentSpan
    const candidate: TelemetryLog = {
      version: 1,
      level: options.logLevel,
      message: snapshotValue(options.message, budget, new WeakSet()),
      annotations: snapshotValue(
        options.fiber.getRef(References.CurrentLogAnnotations),
        budget,
        new WeakSet()
      ) as Readonly<Record<string, unknown>>,
      cause: snapshotCause(options.cause, budget),
      fiberId: options.fiber.id,
      ...(span === undefined ? {} : { traceId: span.traceId, spanId: span.spanId }),
      timestamp: options.date.toISOString()
    }
    const redacted = Redaction.redact(candidate, { onTooDeep: "name" }) as TelemetryLog
    return encoder.encode(JSON.stringify(redacted)).byteLength <= maximumSnapshotBytes
      ? redacted
      : { ...candidate, message: truncatedMarker, annotations: {}, cause: { version: 1, reasons: [] } }
  } catch {
    return {
      version: 1,
      level: options.logLevel,
      message: unrenderableMarker,
      annotations: {},
      cause: { version: 1, reasons: [] },
      fiberId: options.fiber.id,
      timestamp: options.date.toISOString()
    }
  }
}

const makeLog = (options: Logger.Options<unknown>, runId: JournalEvent.RunId): JournalEvent.Input =>
  new JournalEvent.Input({
    runId,
    sourceId,
    // The journal owns the durable per-run/source allocation. A local counter
    // starts over when a layer is rebuilt and makes distinct records collide.
    eventType: "telemetry.log",
    payload: snapshotLog(options),
    meta: {
      version: 1,
      source: "/observability"
    }
  })

/**
 * Installs a bounded, drop-on-overflow logger forwarder for one explicit run.
 *
 * Configuration is decoded before a worker starts. The callback snapshots and
 * redacts a bounded DTO synchronously, then performs only non-blocking queue
 * admission. Overflow and journal delivery failures are telemetry losses, not
 * application failures; closing the scope interrupts the worker and may drop
 * records still queued behind an in-flight write.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerJournalForwarding = (
  options: Options
): Layer.Layer<never, InvalidJournalLoggerOptions, Journal.Journal> =>
  Layer.unwrap(
    Effect.map(validateOptions(options), (configured) =>
      Layer.merge(
        Layer.effect(
          Logger.CurrentLoggers,
          Effect.gen(function*() {
            const journal = yield* Journal.Journal
            const queue = yield* Queue.bounded<JournalEvent.Input>(configured.capacity ?? 256)
            const forward = Effect.fn("JournalLogger.forward")((input: JournalEvent.Input) =>
              // Reporting a forwarding failure through this logger would
              // recursively enqueue another record. Delivery is deliberately
              // lossy, so the worker absorbs the typed journal refusal.
              Effect.ignore(journal.emitLossy(input))
            )
            yield* Effect.forever(
              Queue.take(queue).pipe(Effect.flatMap(forward))
            ).pipe(Effect.forkScoped)

            const logger = Logger.make<unknown, void>((logOptions) => {
              Queue.offerUnsafe(queue, makeLog(logOptions, configured.runId))
            })
            const current = yield* Effect.withFiber((fiber) => Effect.sync(() => fiber.getRef(Logger.CurrentLoggers)))
            return new Set(configured.mergeWithExisting === true ? current : []).add(logger)
          })
        ),
        Layer.succeed(References.MinimumLogLevel, configured.minimumLogLevel ?? "Info")
      ))
  )
