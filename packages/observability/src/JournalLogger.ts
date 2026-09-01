/**
 * Non-blocking forwarding of operational logs to the durable journal queue.
 *
 * @since 0.1.0
 */
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import type * as LogLevel from "effect/LogLevel"
import * as Queue from "effect/Queue"
import * as References from "effect/References"

/**
 * Options for the journal forwarding logger.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
  readonly runId: string
  readonly capacity?: number | undefined
  readonly minimumLogLevel?: LogLevel.LogLevel | undefined
  readonly mergeWithExisting?: boolean | undefined
}

/**
 * Versioned operational log payload written to the journal.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface TelemetryLog {
  readonly version: 1
  readonly level: LogLevel.LogLevel
  readonly message: unknown
  readonly annotations: Readonly<Record<string, unknown>>
  readonly fiberId: number
  readonly traceId?: string | undefined
  readonly spanId?: string | undefined
  readonly timestamp: string
}

const sourceId = "flows/observability/logger" as JournalEvent.SourceId

const makeLog = (options: Logger.Options<unknown>, sequence: number, runId: JournalEvent.RunId): JournalEvent.Input => {
  const span = options.fiber.currentSpan
  const payload: TelemetryLog = {
    version: 1,
    level: options.logLevel,
    message: options.message,
    annotations: options.fiber.getRef(References.CurrentLogAnnotations),
    fiberId: options.fiber.id,
    traceId: span?.traceId,
    spanId: span?.spanId,
    timestamp: options.date.toISOString()
  }
  return new JournalEvent.Input({
    runId,
    sourceId,
    sourceSeq: sequence as JournalEvent.SourceSeq,
    eventType: "telemetry.log",
    payload,
    meta: {
      version: 1,
      source: "/observability"
    }
  })
}

/**
 * Installs a bounded, drop-on-overflow logger forwarder for one explicit run.
 * The callback only performs synchronous queue admission. A scoped worker owns
 * journal delivery and swallows both dropped receipts and journal failures.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerJournalForwarding = (options: Options): Layer.Layer<never, never, Journal.Journal> =>
  Layer.merge(
    Layer.effect(
      Logger.CurrentLoggers,
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const queue = yield* Queue.bounded<JournalEvent.Input>(options.capacity ?? 256)
        const forward = Effect.fn("JournalLogger.forward")((input: JournalEvent.Input) =>
          journal.emitLossy(input).pipe(
            // This worker is forked before the returned logger is installed,
            // so the warning uses only the ambient loggers and cannot enqueue
            // itself recursively. Defects and interrupts still propagate.
            Effect.catch((error) =>
              Effect.annotateLogs(
                Effect.logWarning("A telemetry log record could not be forwarded"),
                { runId: options.runId, error }
              )
            )
          )
        )
        yield* Effect.forever(
          Queue.take(queue).pipe(
            Effect.flatMap(forward)
          )
        ).pipe(Effect.forkScoped)

        let sequence = 0
        const logger = Logger.make<unknown, void>((logOptions) => {
          const input = makeLog(logOptions, sequence++, options.runId as JournalEvent.RunId)
          Queue.offerUnsafe(queue, input)
        })
        const current = yield* Effect.withFiber((fiber) => Effect.sync(() => fiber.getRef(Logger.CurrentLoggers)))
        return new Set(options.mergeWithExisting === true ? current : []).add(logger)
      })
    ),
    Layer.succeed(References.MinimumLogLevel, options.minimumLogLevel ?? "Info")
  )
