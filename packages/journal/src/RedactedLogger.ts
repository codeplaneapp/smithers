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
 * log line: it hands the wrapped logger a view of the fiber whose `Console` is
 * a redacting console and whose log annotations are already redacted, so
 * whatever that logger renders — the message, the pretty cause, the annotation
 * values, a JSON document — passes through `Redaction.redact` on its way to
 * the stream. A logger that writes somewhere other than the console, such as
 * the tracer logger, still reads the redacted annotations.
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
 * `{}` where the operator expected a failure. A logged `Error` is therefore
 * rebuilt as an `Error` whose `message` and `stack` went through the rules.
 *
 * @since 0.1.0
 */
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
 * Redacts one value on its way to the console.
 *
 * @since 0.1.0
 * @category redaction
 * @slop
 */
export const redactArgument = (value: unknown, redactor: Redaction.Redactor): unknown => {
  if (value instanceof Error) {
    const rebuilt = new Error(String(redactor(value.message)))
    rebuilt.name = value.name
    // Defined rather than assigned. `Error.stack` is an optional property, so
    // under `exactOptionalPropertyTypes` an assignment cannot carry the
    // `undefined` an already stackless error has, and `new Error` has just
    // given `rebuilt` a stack of its own that would otherwise stand in for it.
    Object.defineProperty(rebuilt, "stack", {
      value: typeof value.stack === "string" ? String(redactor(value.stack)) : value.stack,
      writable: true,
      configurable: true
    })
    return rebuilt
  }
  return redactor(value)
}

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
