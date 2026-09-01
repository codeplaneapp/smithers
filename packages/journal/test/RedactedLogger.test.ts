/**
 * The redacting logger over the rule fixtures `Redaction.test.ts` documents.
 *
 * The assertions read what the logger handed the console, because that is what
 * reaches the operator's terminal. rc-contract section 5.2 owns this
 * deliverable and `e2e/faults/case22-secret-never-in-journal.test.ts` proves
 * the same rules on the real binary.
 */
import { describe, expect, it } from "@effect/vitest"
import { Cause, Console, Effect, Logger, Tracer } from "effect"
import * as RedactedLogger from "../src/RedactedLogger.ts"
import * as Redaction from "../src/Redaction.ts"

interface Capture {
  readonly lines: Array<Array<unknown>>
  readonly console: Console.Console
}

/** A console that records every argument each writing method was handed. */
const capture = (): Capture => {
  const lines: Array<Array<unknown>> = []
  const record = (...args: ReadonlyArray<unknown>) => {
    lines.push([...args])
  }
  const ignore = () => {}
  return {
    lines,
    console: {
      assert: record,
      clear: ignore,
      count: ignore,
      countReset: ignore,
      debug: record,
      dir: record,
      dirxml: record,
      error: record,
      group: record,
      groupCollapsed: record,
      groupEnd: ignore,
      info: record,
      log: record,
      table: record,
      time: ignore,
      timeEnd: ignore,
      timeLog: record,
      trace: record,
      warn: record
    } as Console.Console
  }
}

/** Everything the console was handed for the run, as one string. */
const rendered = (recorded: Capture): string =>
  recorded.lines.map((line) => line.map((value) => String(value)).join(" ")).join("\n")

/** Runs `body` under `logger`, redacted, against a capturing console. */
const loggedWith = <E>(
  logger: Logger.Logger<unknown, void>,
  body: Effect.Effect<void, E>
): Effect.Effect<Capture, E> =>
  Effect.suspend(() => {
    const recorded = capture()
    return body.pipe(
      Effect.provide(RedactedLogger.layer()),
      Effect.provide(Logger.layer([logger])),
      Effect.provideService(Console.Console, recorded.console),
      Effect.as(recorded)
    )
  })

/** Runs `body` under the pretty logger, which is what an operator's terminal gets. */
const logged = <E>(body: Effect.Effect<void, E>): Effect.Effect<Capture, E> =>
  loggedWith(Logger.consolePretty({ colors: false, mode: "tty" }), body)

/**
 * Runs `body` under the real `Logger.tracerLogger` inside a recorded span.
 *
 * That logger is the non-console logger that actually ships: Effect installs
 * it by default alongside the console one, it never reads the fiber's
 * `Console`, and what it writes leaves the process for an OTLP collector.
 */
const traced = <E>(body: Effect.Effect<void, E>): Effect.Effect<Array<Tracer.NativeSpan>, E> =>
  Effect.suspend(() => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    return body.pipe(
      Effect.withSpan("probe"),
      Effect.provide(RedactedLogger.layer()),
      Effect.provide(Logger.layer([Logger.tracerLogger])),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.as(spans)
    )
  })

/** The one log event the tracer logger recorded on the probe span. */
const onlyEvent = (
  spans: ReadonlyArray<Tracer.NativeSpan>
): [name: string, startTime: bigint, attributes: Record<string, unknown>] => {
  const events = spans.flatMap((span) => span.events)
  expect(events.length).toBe(1)
  return events[0]!
}

describe("RedactedLogger", () => {
  it.effect("keeps a credential-shaped token out of the line the console prints", () =>
    Effect.gen(function*() {
      const recorded = yield* logged(
        Effect.logInfo("calling https://example.test/deploy with Bearer sk-live-e2ecase22NEVERLOGTHIS")
      )
      const text = rendered(recorded)
      expect(text).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
      // The provider-key rule wins the span before the bearer rule reaches it,
      // which is the journal's own order and the reason both rules exist.
      expect(text).toContain("Bearer [REDACTED_API_KEY]")
    }))

  it.effect("applies the documented textual rules to a logged message", () =>
    Effect.gen(function*() {
      const recorded = yield* logged(Effect.gen(function*() {
        yield* Effect.logInfo("use sk-proj-abcdefghij when calling")
        yield* Effect.logInfo("Authorization: Bearer abcdefghijkl")
        yield* Effect.logInfo("ANTHROPIC_API_KEY=shhh")
      }))
      const text = rendered(recorded)
      expect(text).toContain("[REDACTED_API_KEY]")
      expect(text).toContain("Bearer [REDACTED_TOKEN]")
      expect(text).toContain(`ANTHROPIC_API_KEY=${Redaction.placeholder}`)
      expect(text).not.toContain("sk-proj-abcdefghij")
      expect(text).not.toContain("Bearer abcdefghijkl")
      expect(text).not.toContain("=shhh")
    }))

  it.effect("redacts the message a logger reads directly, not only what the console prints", () =>
    Effect.gen(function*() {
      // `Logger.tracerLogger` ships in Effect's default logger set and never
      // reads the fiber's Console: it publishes the message as a span event
      // name. A wrapper that only substitutes the Console leaves the raw
      // credential on the exported span.
      const seen: Array<unknown> = []
      const direct = Logger.make<unknown, void>(({ message }) => {
        seen.push(message)
      })
      yield* Effect.logInfo("calling with Bearer sk-live-e2ecase22NEVERLOGTHIS").pipe(
        Effect.provide(Logger.layer([RedactedLogger.wrap(direct)]))
      )
      // A multi-part message arrives as an array, and every part is redacted.
      yield* Effect.logInfo("deploying with", "sk-proj-abcdefghij", { apiKey: "sk-ant-api03-abcdefgh" }).pipe(
        Effect.provide(Logger.layer([RedactedLogger.wrap(direct)]))
      )
      const text = seen.map((entry) =>
        Array.isArray(entry) ? entry.map((part) => JSON.stringify(part)).join(" ") : String(entry)
      ).join("\n")
      expect(text).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
      expect(text).not.toContain("sk-proj-abcdefghij")
      expect(text).not.toContain("sk-ant-api03-abcdefgh")
      expect(text).toContain("[REDACTED_API_KEY]")
    }))

  it.effect("redacts a message a caller passed without wrapping it in parts", () =>
    Effect.gen(function*() {
      // Effect's own logging API always delivers an array of parts, but
      // `Logger.log` takes whatever LogOptions a caller builds; a bare message
      // is redacted the same way rather than walked as a sequence. The options
      // are captured from a real log call so the fiber is a real one.
      const seen: Array<unknown> = []
      let captured: Parameters<typeof direct.log>[0] | undefined
      const direct = Logger.make<unknown, void>((options) => {
        captured = options
        seen.push(options.message)
      })
      const wrapped = RedactedLogger.wrap(direct)
      yield* Effect.logInfo("warm").pipe(Effect.provide(Logger.layer([wrapped])))
      seen.length = 0
      yield* Effect.sync(() => wrapped.log({ ...captured!, message: "bare Bearer sk-live-e2ecase22NEVERLOGTHIS" }))
      const text = JSON.stringify(seen)
      expect(text).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
      expect(text).toContain("[REDACTED_API_KEY]")
    }))

  it.effect("redacts the span event the tracer logger exports", () =>
    Effect.gen(function*() {
      const spans = yield* traced(
        Effect.logInfo("calling https://example.test/deploy with Bearer sk-live-e2ecase22NEVERLOGTHIS").pipe(
          Effect.annotateLogs({ apiKey: "sk-ant-api03-abcdefgh" })
        )
      )
      const [name, , attributes] = onlyEvent(spans)
      expect(name).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
      expect(name).toBe("calling https://example.test/deploy with Bearer [REDACTED_API_KEY]")
      expect(attributes.apiKey).toBe(Redaction.placeholder)
    }))

  it.effect("redacts the cause that logger renders into the span itself", () =>
    Effect.gen(function*() {
      // A failure is logged as a `Cause`, not as message parts, and the tracer
      // logger renders it with `Cause.pretty` into `effect.cause`. Nothing on
      // that path touches the console.
      const spans = yield* traced(
        Effect.logError(
          Cause.fail(new Error("POST https://example.test failed: token=sk-live-e2ecase22NEVERLOGTHIS"))
        )
      )
      const rendered = String(onlyEvent(spans)[2]["effect.cause"])
      expect(rendered).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
      expect(rendered).toContain(`token=${Redaction.placeholder}`)
      expect(rendered).toContain("POST https://example.test failed")
    }))

  it("keeps a redacted error's class and own fields, which a rendered cause reads", () => {
    class DeployError extends Error {
      readonly _tag = "DeployError"
      readonly status: number
      constructor(message: string, status: number) {
        super(message)
        this.name = "DeployError"
        this.status = status
      }
    }
    const redacted = RedactedLogger.redactArgument(
      new DeployError("POST failed: token=sk-live-abcdefgh", 502),
      Redaction.make()
    ) as DeployError
    expect(redacted).toBeInstanceOf(DeployError)
    expect(redacted._tag).toBe("DeployError")
    expect(redacted.status).toBe(502)
    expect(redacted.name).toBe("DeployError")
    expect(redacted.message).toBe(`POST failed: token=${Redaction.placeholder}`)
    expect(redacted.stack).not.toContain("sk-live-abcdefgh")
  })

  it("redacts an error's own fields, reads its getters, and stops at a cycle", () => {
    // `Cause.pretty` walks `error.cause`, so a nested error is rendered too.
    // A cycle is not exotic once errors carry each other: the walk records
    // what it has seen and hands the original back rather than recurring.
    const inner = new Error("inner token=sk-live-abcdefgh")
    const outer = new Error("outer Bearer abcdefghijkl", { cause: inner }) as Error & { self?: unknown }
    outer.self = outer
    Object.defineProperty(outer, "detail", {
      get: () => "sent Bearer abcdefghijkl",
      enumerable: true,
      configurable: true
    })
    const redacted = RedactedLogger.redactArgument(outer, Redaction.make()) as Error & {
      self: unknown
      detail: string
    }
    expect(redacted.message).toBe("outer Bearer [REDACTED_TOKEN]")
    expect(redacted.cause).toBeInstanceOf(Error)
    expect((redacted.cause as Error).message).toBe(`inner token=${Redaction.placeholder}`)
    // Restated 2026-08-31: this asserted `toBe(outer)`, which made the repeat
    // reference the UNREDACTED original. A diamond (two fields naming one
    // error) then carried the credential in clear on the second field, and a
    // logger that reads the event rather than rendering it through the console
    // printed it. The memo returns the clone, so every reference is redacted
    // and the shape a reader sees is still a self-reference.
    expect(redacted.self).toBe(redacted)
    // A getter is read once and stored, so what it returned is redacted too.
    expect(redacted.detail).toBe("sent Bearer [REDACTED_TOKEN]")
  })

  it.effect("redacts a defect and passes an interrupt through", () =>
    Effect.gen(function*() {
      const spans = yield* traced(
        Effect.logError(
          Cause.combine(
            Cause.die(new Error("crashed calling with Bearer sk-live-e2ecase22NEVERLOGTHIS")),
            Cause.interrupt(1)
          )
        )
      )
      const rendered = String(onlyEvent(spans)[2]["effect.cause"])
      expect(rendered).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
      expect(rendered).toContain("Bearer [REDACTED_API_KEY]")
    }))

  it("keeps the type a logger was given, and still redacts what it holds", () => {
    // The redactor rebuilds an object from its own enumerable entries, which
    // turns a Date, Map, Set, URL, RegExp or class instance into `{}`. That is
    // right for the journal, whose rows are JSON, and wrong for a log line,
    // where the operator keeps the format they had.
    const redactor = Redaction.make()
    const at = new Date(0)
    expect(RedactedLogger.redactArgument(at, redactor)).toBeInstanceOf(Date)
    expect((RedactedLogger.redactArgument(at, redactor) as Date).toISOString()).toBe(at.toISOString())
    expect(RedactedLogger.redactArgument(/x/g, redactor)).toBeInstanceOf(RegExp)

    const map = RedactedLogger.redactArgument(new Map([["apiKey", "sk-live-abcdefgh"]]), redactor) as Map<
      string,
      unknown
    >
    expect(map).toBeInstanceOf(Map)
    expect(map.get("apiKey")).toBe(Redaction.placeholder)

    const set = RedactedLogger.redactArgument(new Set(["token=sk-live-abcdefgh"]), redactor) as Set<string>
    expect(set).toBeInstanceOf(Set)
    expect([...set].join()).not.toContain("sk-live-abcdefgh")

    class Detail {
      readonly apiKey: string
      readonly endpoint: string
      constructor(apiKey: string, endpoint: string) {
        this.apiKey = apiKey
        this.endpoint = endpoint
      }
    }
    const detail = RedactedLogger.redactArgument(new Detail("sk-live-abcdefgh", "https://example.test"), redactor)
    expect(detail).toBeInstanceOf(Detail)
    expect((detail as Detail).apiKey).toBe(Redaction.placeholder)
    expect((detail as Detail).endpoint).toBe("https://example.test")

    // A repeat reference is the same clone, a binary view passes through, a
    // URL keeps its type with its query redacted, and a symbol-keyed member
    // of a class instance survives with its own value.
    const shared = new Map([["endpoint", "https://example.test"]])
    const twice = RedactedLogger.redactArgument({ a: shared, b: shared }, redactor) as {
      a: Map<string, unknown>
      b: Map<string, unknown>
    }
    expect(twice.b).toBe(twice.a)
    const bytes = new Uint8Array([1, 2, 3])
    expect(RedactedLogger.redactArgument(bytes, redactor)).toBe(bytes)
    const url = RedactedLogger.redactArgument(new URL("https://example.test/?token=sk-live-abcdefgh"), redactor)
    expect(url).toBeInstanceOf(URL)
    expect(String(url)).not.toContain("sk-live-abcdefgh")
    const tag = Symbol("tag")
    class Tagged {
      readonly apiKey = "sk-live-abcdefgh"
      readonly [tag] = "kept"
    }
    const tagged = RedactedLogger.redactArgument(new Tagged(), redactor) as Tagged
    expect(tagged[tag]).toBe("kept")
    expect(tagged.apiKey).toBe(Redaction.placeholder)

    // A getter on a class instance is read once and stored as data, so the
    // reader cannot pull the unredacted value back out of the original.
    class Lazy {}
    const lazy = new Lazy()
    Object.defineProperty(lazy, "detail", {
      get: () => "sent Bearer abcdefghijkl",
      enumerable: true,
      configurable: true
    })
    const rendered = RedactedLogger.redactArgument(lazy, redactor) as { detail: string }
    expect(rendered).toBeInstanceOf(Lazy)
    expect(rendered.detail).toBe("sent Bearer [REDACTED_TOKEN]")

    // A plain object and an array still walk exactly as before.
    expect(RedactedLogger.redactArgument({ a: ["token=sk-live-abcdefgh"] }, redactor)).toEqual({
      a: [`token=${Redaction.placeholder}`]
    })
  })

  it("redacts every reference to one error, not only the first", () => {
    // A diamond: two fields of one error naming the same child. The cycle
    // guard used to hand back the original on the second visit, so the
    // credential survived on `second` while `first` was clean.
    const base = new Error("upstream token=sk-live-abcdefgh")
    const top = new Error("deploy failed") as Error & { first?: unknown; second?: unknown }
    top.first = base
    top.second = base
    const redacted = RedactedLogger.redactArgument(top, Redaction.make()) as Error & {
      first: Error
      second: Error
    }
    expect(redacted.first.message).not.toContain("sk-live-abcdefgh")
    expect(redacted.second.message).not.toContain("sk-live-abcdefgh")
    expect(redacted.second).toBe(redacted.first)
  })

  it.effect("redacts a credential-named log annotation wholesale", () =>
    Effect.gen(function*() {
      const recorded = yield* logged(
        Effect.logInfo("deploying").pipe(
          Effect.annotateLogs({ apiKey: "sk-ant-api03-abcdefgh", endpoint: "https://example.test" })
        )
      )
      const text = rendered(recorded)
      expect(text).not.toContain("sk-ant-api03-abcdefgh")
      expect(text).toContain(Redaction.placeholder)
      expect(text).toContain("https://example.test")
    }))

  it.effect("redacts a credential inside a logged structure without flattening it", () =>
    Effect.gen(function*() {
      const recorded = yield* logged(
        Effect.logInfo("request", { headers: ["Authorization: Bearer abcdefghijkl"], attempt: 2 })
      )
      const structure = recorded.lines.flat().find((value) =>
        typeof value === "object" && value !== null && "attempt" in value
      )
      expect(structure).toEqual({ headers: ["Authorization: Bearer [REDACTED_TOKEN]"], attempt: 2 })
    }))

  it.effect("keeps a logged Error an Error and redacts its message and stack", () =>
    Effect.gen(function*() {
      const recorded = yield* logged(Effect.logError("failed", new Error("POST failed: token=sk-live-abcdefgh")))
      const error = recorded.lines.flat().find((value) => value instanceof Error) as Error
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toBe(`POST failed: token=${Redaction.placeholder}`)
      expect(error.stack).not.toContain("sk-live-abcdefgh")
    }))

  it("rebuilds a stackless Error without inventing a stack", () => {
    const bare = new Error("token=sk-live-abcdefgh")
    Object.defineProperty(bare, "stack", { value: undefined })
    const rebuilt = RedactedLogger.redactArgument(bare, Redaction.make()) as Error
    expect(rebuilt).toBeInstanceOf(Error)
    expect(rebuilt.message).toBe(`token=${Redaction.placeholder}`)
    expect(rebuilt.stack).toBeUndefined()
  })

  it("forwards a console method that carries no output untouched", () => {
    const recorded = capture()
    const redacting = RedactedLogger.redactingConsole(recorded.console, Redaction.make())
    redacting.groupEnd()
    redacting.log("Bearer abcdefghijkl")
    expect(rendered(recorded)).toBe("Bearer [REDACTED_TOKEN]")
  })

  it("wraps a logger once", () => {
    const sink = Logger.make<unknown, void>(() => {})
    const wrapped = RedactedLogger.wrap(sink)
    expect(RedactedLogger.isRedacted(sink)).toBe(false)
    expect(RedactedLogger.isRedacted(wrapped)).toBe(true)
    expect(RedactedLogger.wrap(wrapped)).toBe(wrapped)
  })

  it.effect("honours a caller's own rule set", () =>
    Effect.gen(function*() {
      const recorded = capture()
      yield* Effect.logInfo("ship it CODENAME=osprey").pipe(
        Effect.provide(
          RedactedLogger.layer({ rules: [{ id: "codename", pattern: /CODENAME=\w+/g, replace: "CODENAME=[HIDDEN]" }] })
        ),
        Effect.provide(Logger.layer([Logger.consolePretty({ colors: false, mode: "tty" })])),
        Effect.provideService(Console.Console, recorded.console)
      )
      expect(rendered(recorded)).toContain("CODENAME=[HIDDEN]")
    }))

  it.effect("bounds the cost of a long line", () =>
    Effect.gen(function*() {
      // Four hundred thousand characters of the shapes the rules scan for,
      // interleaved so a backtracking engine would have every chance to
      // explode. A linear scan finishes in milliseconds; the budget is three
      // orders of magnitude above that so machine load cannot fail it, and it
      // is still finite, which is the whole claim.
      const line = "Bearer " + "aaaaaaaa-".repeat(40_000) + " api_key=" + "b".repeat(200_000)
      expect(line.length).toBeGreaterThan(400_000)
      const started = Date.now()
      const recorded = yield* logged(Effect.logInfo(line))
      const elapsed = Date.now() - started
      expect(elapsed).toBeLessThan(2_000)
      const text = rendered(recorded)
      expect(text).toContain("Bearer [REDACTED_TOKEN]")
      expect(text).toContain(`api_key=${Redaction.placeholder}`)
    }))

  // `packages/cli/src/bin.ts` sends every built-in logger to `console.error`
  // through `Logger.LogToStderr` and keeps whichever logger is installed, so
  // the rules have to hold for the JSON document a machine-readable stream
  // carries as well as for the pretty line a terminal shows.
  it.effect("redacts the JSON document the structured logger writes", () =>
    Effect.gen(function*() {
      const recorded = yield* loggedWith(
        Logger.consoleJson,
        Effect.logInfo("calling https://example.test/deploy with Bearer sk-live-abcdefgh").pipe(
          Effect.annotateLogs({ apiKey: "sk-ant-api03-abcdefgh" })
        )
      )
      const document = JSON.parse(String(recorded.lines.flat()[0]))
      expect(document.message).toBe("calling https://example.test/deploy with Bearer [REDACTED_API_KEY]")
      expect(document.annotations.apiKey).toBe(Redaction.placeholder)
    }))

  it.effect("leaves the logger set alone when nothing matches", () =>
    Effect.gen(function*() {
      const recorded = yield* logged(Effect.logInfo("plain operational line"))
      expect(rendered(recorded)).toContain("plain operational line")
    }))
})
