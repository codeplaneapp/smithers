/**
 * The redacting logger: the journal's redaction rules applied to log output.
 *
 * The journal redacts on the write path, so a credential a cell logs or
 * returns never reaches a committed row (`./Redaction.ts`). The operator's
 * terminal was the other place the same credential surfaces: every built-in
 * Effect logger renders through the fiber's `Console`, so an action that hands
 * a token to `Effect.logInfo` wrote it to stderr in full and it reached
 * whatever collected that stream.
 *
 * This module closes that half with the SAME rules rather than a second rule
 * set. {@link wrap} does not re-implement redaction and does not re-format a
 * log line. It redacts the log event itself — the message, the cause, and the
 * log annotations — before the wrapped logger is handed it, and it hands that
 * logger a view of the fiber whose `Console` is a redacting console, so
 * whatever the logger renders for itself — a pretty line, a JSON document —
 * passes through `Redaction.redact` on its way to the stream as well.
 *
 * Both halves carry load. Most built-in loggers write through the fiber's
 * `Console`, which is what covers the pretty line, the `--json` document, and
 * the `.flows/logs/<runId>.log` stream. But a logger is free to read the event
 * instead of rendering it, and one in Effect's own default logger set does:
 * `Logger.tracerLogger` publishes the message as a span event name and
 * `Cause.pretty` of the cause as the span's `effect.cause` attribute, and
 * never reads `Console` at all. Redacting only the console would hide a
 * credential on stderr and export it in clear to whatever OTLP collector is
 * configured (`examples/src/10-telemetry-export.ts`, `docs/pages/telemetry.md`).
 *
 * Cost is bounded by the rules themselves: `Redaction.defaultRules` are three
 * unanchored character-class scans with no nested quantifier and no
 * alternation inside a repetition, so each one is linear in the length of the
 * line and no input backtracks catastrophically.
 *
 * One deliberate difference from the journal write path. `Redaction.redact`
 * rebuilds an object from its own enumerable entries, which is right for a row
 * that is about to be JSON-encoded and wrong for a terminal: an `Error` keeps
 * `message` and `stack` on non-enumerable properties, so rebuilding one prints
 * `{}` where the operator expected a failure. An `Error` is cloned instead:
 * the clone keeps the original prototype, so a tagged error carried by a cause
 * is still an instance of its own class when `Cause.pretty` renders it, keeps
 * the own fields that rendering copies over, and carries `message` and `stack`
 * rewritten by the rules.
 *
 * @since 0.1.0
 */
import * as Cause from "effect/Cause"
import * as Console from "effect/Console"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as References from "effect/References"
import * as Redaction from "./Redaction.ts"

/**
 * Marks a logger this module already wrapped.
 *
 * Both the CLI and the durable runtime install {@link layer}, and a detached
 * `smithers run` is both at once. Wrapping twice would be correct but pay the
 * rules twice per line, so a wrapped logger is returned unchanged.
 *
 * @since 0.1.0
 * @category type ids
 * @slop
 */
export const TypeId: unique symbol = Symbol.for("@smthrs/journal/RedactedLogger")

/**
 * Whether {@link wrap} already wrapped this logger.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const isRedacted = (logger: Logger.Logger<any, any>): boolean => TypeId in logger

/**
 * Console methods that write caller-supplied values, mapped to whether their
 * arguments carry log output. The ones marked `false` take a label or nothing
 * at all and are forwarded untouched.
 */
const consoleMethods = {
  assert: true,
  clear: false,
  count: false,
  countReset: false,
  debug: true,
  dir: true,
  dirxml: true,
  error: true,
  group: true,
  groupCollapsed: true,
  groupEnd: false,
  info: true,
  log: true,
  table: true,
  time: false,
  timeEnd: false,
  timeLog: true,
  trace: true,
  warn: true
} as const

/**
 * The parts of a log message.
 *
 * Effect's logging API passes an array, one entry per argument, including for
 * a single argument. A caller that builds `LogOptions` by hand may pass the
 * message itself, so it is wrapped rather than walked.
 *
 * @since 0.1.0
 * @category redaction
 * @slop
 */
const toArray = (message: unknown): ReadonlyArray<unknown> => Array.isArray(message) ? message : [message]

/**
 * A copy of `error` carrying the same information with the rules applied.
 *
 * `Object.create` over the original prototype rather than `new Error`, so a
 * tagged error stays an instance of its own class: a cause carries the error
 * a flow failed with, and `Cause.pretty` renders it by reading `name`,
 * `stack`, and the error's own keys. Those own properties are copied by
 * descriptor for the same reason. `message` and `stack` are handled apart from
 * that loop and defined as data properties, because V8 gives an error an own
 * `stack` ACCESSOR whose getter would read the unredacted text straight back
 * out of the original.
 */
const redactError = (error: Error, redactor: Redaction.Redactor, seen: WeakSet<object>): Error => {
  if (seen.has(error)) return error
  seen.add(error)
  const clone = Object.create(Object.getPrototypeOf(error)) as Error
  for (const key of Reflect.ownKeys(error)) {
    if (key === "message" || key === "stack") continue
    const descriptor = Object.getOwnPropertyDescriptor(error, key)!
    // An accessor is read once here and stored as data. The clone is a
    // rendering, not a live object, and a getter carried across unchanged
    // would hand the unredacted value to whatever reads it next.
    const value = "value" in descriptor
      ? descriptor.value
      : (error as unknown as Record<PropertyKey, unknown>)[key]
    Object.defineProperty(clone, key, {
      value: value instanceof Error ? redactError(value, redactor, seen) : redactor(value),
      writable: true,
      enumerable: descriptor.enumerable === true,
      configurable: true
    })
  }
  Object.defineProperty(clone, "message", {
    value: String(redactor(error.message)),
    writable: true,
    configurable: true
  })
  // Defined rather than assigned. `Error.stack` is an optional property, so
  // under `exactOptionalPropertyTypes` an assignment cannot carry the
  // `undefined` an already stackless error has.
  Object.defineProperty(clone, "stack", {
    value: typeof error.stack === "string" ? String(redactor(error.stack)) : error.stack,
    writable: true,
    configurable: true
  })
  return clone
}

/**
 * Redacts one value on its way out of the logger.
 *
 * @since 0.1.0
 * @category redaction
 * @slop
 */
export const redactArgument = (value: unknown, redactor: Redaction.Redactor): unknown =>
  value instanceof Error ? redactError(value, redactor, new WeakSet()) : redactor(value)

/**
 * A console that runs every value it is handed through `redactor` and then
 * delegates to `target`.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const redactingConsole = (target: Console.Console, redactor: Redaction.Redactor): Console.Console => {
  const methods = target as unknown as Record<string, (...args: ReadonlyArray<any>) => unknown>
  const view: Record<string, unknown> = {}
  for (const [name, redacts] of Object.entries(consoleMethods)) {
    const method = methods[name]!.bind(target)
    view[name] = redacts
      ? (...args: ReadonlyArray<unknown>) => method(...args.map((value) => redactArgument(value, redactor)))
      : method
  }
  return view as unknown as Console.Console
}

/**
 * A view of `fiber` whose console redacts and whose log annotations are
 * already redacted.
 *
 * The view inherits from the fiber itself, so `id`, `currentSpan`, and every
 * other member a logger reads answer exactly as before; only the two
 * references a logger renders from are substituted.
 */
const redactedFiber = (
  fiber: Fiber.Fiber<unknown, unknown>,
  redactor: Redaction.Redactor
): Fiber.Fiber<unknown, unknown> => {
  const view = Object.create(fiber) as Fiber.Fiber<unknown, unknown>
  Object.defineProperty(view, "getRef", {
    value: <X>(reference: Context.Reference<X>): X => {
      const current = fiber.getRef(reference)
      if (reference === (Console.Console as unknown as Context.Reference<X>)) {
        return redactingConsole(current as Console.Console, redactor) as X
      }
      if (reference === (References.CurrentLogAnnotations as unknown as Context.Reference<X>)) {
        return redactor(current) as X
      }
      return current
    }
  })
  return view
}

/**
 * The log event's cause with the rules applied to each failure and defect.
 *
 * A reason is copied as a view over itself rather than rebuilt through
 * `Cause.makeFailReason`: those constructors take no `annotations`, and
 * annotations are what `Cause.pretty` uses to annotate a stack, so rebuilding
 * would redact the credential and lose the trace. An `Interrupt` carries no
 * caller-supplied value and is passed through untouched, and an empty cause —
 * every ordinary `Effect.logInfo` — is returned as it came.
 */
const redactedCause = (
  cause: Cause.Cause<unknown>,
  redactor: Redaction.Redactor
): Cause.Cause<unknown> => {
  if (cause.reasons.length === 0) return cause
  return Cause.fromReasons(cause.reasons.map((reason) => {
    if (reason._tag === "Interrupt") return reason
    const key = reason._tag === "Fail" ? "error" : "defect"
    const view = Object.create(reason) as Cause.Reason<unknown>
    Object.defineProperty(view, key, {
      value: redactArgument((reason as unknown as Record<string, unknown>)[key], redactor),
      enumerable: true
    })
    return view
  }))
}

/**
 * Returns `logger` with the journal's redaction rules over everything it
 * renders. A logger this module already wrapped is returned unchanged.
 *
 * @since 0.1.0
 * @category combinators
 * @slop
 */
export const wrap = <Message, Output>(
  logger: Logger.Logger<Message, Output>,
  options?: Redaction.Options
): Logger.Logger<Message, Output> => {
  if (isRedacted(logger)) return logger
  const redactor = Redaction.make(options)
  const wrapped = Logger.make<Message, Output>((logOptions) =>
    logger.log({
      ...logOptions,
      // The message is redacted here, not only behind the fiber's Console,
      // because a logger is free to read it directly: `Logger.tracerLogger`
      // ships in Effect's default set and publishes the message as a span
      // event name, so a Console-only substitution would export a credential
      // in clear to whatever collector is configured.
      //
      // Effect delivers the message as an array of parts, one per argument,
      // including the single-argument case; a non-array reaches here only from
      // a caller that builds `LogOptions` by hand, and `toArray` covers it
      // without a branch no test could reach through the logging API.
      message: (toArray(logOptions.message).map((part) => redactArgument(part, redactor))) as Message,
      // The cause travels the same way and for the same reason. A failure is
      // logged as a `Cause`, not as message parts (`Effect.logError(cause)`
      // moves it out of the arguments), and `Logger.tracerLogger` renders it
      // itself into the span's `effect.cause` attribute without going near the
      // console, so an error message carrying a token would leave the process
      // in clear.
      cause: redactedCause(logOptions.cause, redactor),
      fiber: redactedFiber(logOptions.fiber, redactor)
    })
  )
  Object.defineProperty(wrapped, TypeId, { value: true })
  return wrapped
}

/**
 * Replaces the active logger set with redacting wrappers of the same loggers.
 *
 * It composes over whatever loggers are already installed rather than
 * choosing one, so an operator keeps the format they had and a host that
 * installed its own logger keeps it too.
 *
 * @since 0.1.0
 * @category layers
 * @slop
 */
export const layer = (options?: Redaction.Options): Layer.Layer<never> =>
  Layer.effect(
    Logger.CurrentLoggers,
    Effect.withFiber((fiber) =>
      Effect.sync(() => {
        const wrapped = new Set<Logger.Logger<unknown, any>>()
        for (const logger of fiber.getRef(Logger.CurrentLoggers)) wrapped.add(wrap(logger, options))
        return wrapped
      })
    )
  )
