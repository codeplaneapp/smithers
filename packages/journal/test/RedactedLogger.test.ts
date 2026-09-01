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
import { inspect } from "node:util"
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

  it.effect("keeps a credential out of a log span's label", () =>
    Effect.gen(function*() {
      // A span label reaches the same line by a different route: Effect
      // sanitizes it first, folding `token=` into `token_`, and `_` is a word
      // character, so a rule anchored on `\b` could never fire after it.
      const recorded = yield* logged(
        Effect.logInfo("deploying").pipe(Effect.withLogSpan("fetch token=sk-live-e2ecase22NEVERLOGTHIS"))
      )
      expect(rendered(recorded)).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
    }))

  it.effect("keeps a credential out of a logged function's own properties", () =>
    Effect.gen(function*() {
      // The walker returned anything that was neither a string nor an object
      // untouched, so `util.inspect` printed a function's own properties in
      // full: `[Function: deploy] { token: 'sk-...' }` on the operator's
      // terminal, on the path case 22 guards.
      const handler = Object.assign(() => undefined, { token: "sk-live-e2ecase22NEVERLOGTHIS" })
      const recorded = yield* logged(Effect.logInfo("handler installed", handler))
      expect(rendered(recorded)).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
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

  it("survives every exotic value a log line can carry", () => {
    // The failure mode is one thing: a value the walk cannot faithfully
    // rebuild must never throw out of the logger, because the throw happens
    // while the line is being rendered and it kills the run. Own-key counts
    // do not predict it (Event carries four own symbols AND private fields),
    // so these cover the shapes an inferred rule kept missing.
    const redactor = Redaction.make()
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const throwingGetter = {}
    Object.defineProperty(throwingGetter, "boom", {
      get: () => {
        throw new Error("nope")
      },
      enumerable: true
    })
    const deepUnderError = new Error("outer") as Error & { detail?: unknown }
    let chain: Record<string, unknown> = { token: "sk-live-abcdefgh" }
    for (let level = 0; level < 5_000; level++) chain = { chain }
    deepUnderError.detail = chain
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["Event", new Event("evt-sk-live-abcdefgh")],
      ["CustomEvent", new CustomEvent("evt", { detail: "sk-live-abcdefgh" })],
      ["Headers", new Headers({ authorization: "Bearer sk-live-abcdefgh" })],
      ["URLSearchParams", new URLSearchParams({ token: "sk-live-abcdefgh" })],
      ["AbortController", new AbortController()],
      ["Blob", new Blob(["sk-live-abcdefgh"])],
      ["unparseable RegExp after redaction", new RegExp("(?<sk_live_abcdefgh>x)")],
      ["RegExp whose class breaks", new RegExp("[q sk_livexyz1234]", "u")],
      ["URL whose host is credential-shaped", new URL("https://sk-live-abcdefgh.example.com/")],
      ["revoked proxy", revoked.proxy],
      ["throwing getter", throwingGetter],
      ["deep value under an Error", deepUnderError]
    ]
    for (const [name, value] of cases) {
      const rendered = expect(() => RedactedLogger.redactArgument(value, redactor), name).not.toThrow
      void rendered
      const out = RedactedLogger.redactArgument(value, redactor)
      expect(() => inspect(out), name).not.toThrow()
      expect(inspect(out), name).not.toContain("sk-live-abcdefgh")
      expect(inspect(out), name).not.toContain("sk_live_abcdefgh")
    }
  })

  it("keeps the line when the console itself refuses to render it", () => {
    // The delegate renders what the wrapper hands it, and a value can survive
    // redaction and still break the renderer. The line degrades to text; the
    // run does not die.
    const redactor = Redaction.make()
    const seen: Array<ReadonlyArray<unknown>> = []
    let refuse = true
    // Every method the wrapper binds must exist, so the double is the real
    // console with `log` replaced.
    const brittle = {
      ...console,
      log: (...args: ReadonlyArray<unknown>) => {
        if (refuse) {
          refuse = false
          throw new TypeError("cannot render that")
        }
        seen.push(args)
      }
    } as unknown as Console.Console
    const view = RedactedLogger.redactingConsole(brittle, redactor)
    // A BigInt survives redaction and still breaks `JSON.stringify`, so the
    // text fallback needs its own fallback.
    expect(() => view.log("token=sk-live-abcdefgh", { a: 1 }, 7n, undefined)).not.toThrow()
    expect(JSON.stringify(seen.map((entry) => entry.map((value) => String(value))))).not.toContain(
      "sk-live-abcdefgh"
    )
    expect(seen.length).toBe(1)
  })

  it("names a prototype chain it cannot rebuild rather than guessing", () => {
    // A chain that never reaches Object.prototype is not a plain object and
    // not an ordinary class instance, so it is not rebuilt.
    const redactor = Redaction.make()
    const orphan = Object.create(Object.create(null) as object) as Record<string, unknown>
    orphan["token"] = "sk-live-abcdefgh"
    expect(() => RedactedLogger.redactArgument(orphan, redactor)).not.toThrow()
    expect(inspect(RedactedLogger.redactArgument(orphan, redactor))).not.toContain("sk-live-abcdefgh")
  })

  it("survives a host object whose state lives in internal slots", () => {
    // A brand-checked class (Headers, URLSearchParams, Request, ...) keeps its
    // state in internal slots, so a clone built on its prototype with only its
    // own keys copied is an impostor that Node's inspector rejects: rendering
    // it threw from inside the logger and killed the fiber.
    const redactor = Redaction.make()
    const headers = new Headers({ authorization: "Bearer sk-live-abcdefgh" })
    const rendered = RedactedLogger.redactArgument(headers, redactor)
    expect(() => inspect(rendered)).not.toThrow()
    expect(inspect(rendered)).not.toContain("sk-live-abcdefgh")

    const params = new URLSearchParams({ token: "sk-live-abcdefgh" })
    expect(() => inspect(RedactedLogger.redactArgument(params, redactor))).not.toThrow()
    expect(inspect(RedactedLogger.redactArgument(params, redactor))).not.toContain("sk-live-abcdefgh")
  })

  it("gives an annotation the same treatment the message gets", () => {
    // Restated 2026-09-01: this asserted an annotated Date stayed a Date,
    // which was the type-preserving render. That render was removed after
    // three rounds of review found it could kill the run it was logging, so
    // the shared treatment is now the plain redacted form. The property the
    // case exists for is unchanged: both halves of one log event obey one
    // rule, and neither leaks.
    const redactor = Redaction.make()
    const annotations = RedactedLogger.redactArgument(
      { at: new Date(0), token: "sk-live-abcdefgh", nested: { authorization: "Bearer abcdefghijkl" } },
      redactor
    )
    const rendered = inspect(annotations)
    expect(rendered).not.toContain("sk-live-abcdefgh")
    expect(rendered).not.toContain("Bearer abcdefghijkl")
    expect(RedactedLogger.redactArgument({ token: "sk-live-abcdefgh" }, redactor)).toEqual(
      RedactedLogger.redactArgument({ token: "sk-live-abcdefgh" }, redactor)
    )
  })

  it("redacts a credential used as a Map key", () => {
    const redactor = Redaction.make()
    const keyed = RedactedLogger.redactArgument(new Map([["sk-live-abcdefgh", "v"]]), redactor) as Map<
      string,
      unknown
    >
    expect(inspect(keyed)).not.toContain("sk-live-abcdefgh")
  })

  it("stops at the depth cap on an Error's own members, not only beside one", () => {
    // Round 4 found the cap did not bind through an Error: the Error walk ran
    // before the check and carried no depth, so a deep value on a cause still
    // exhausted the stack and the RangeError killed the run from inside the
    // logger. The chain here is deeper than the cap and hangs off the Error.
    const redactor = Redaction.make()
    const outer = new Error("outer") as Error & { detail?: unknown }
    let chain: Record<string, unknown> = { token: "sk-live-abcdefgh" }
    for (let level = 0; level < 400; level++) chain = { chain }
    outer.detail = chain
    const redacted = RedactedLogger.redactArgument(outer, redactor) as Error & { detail?: unknown }
    // `inspect` of an Error shows its stack, so the member is read directly.
    const rendered = inspect(redacted.detail, { depth: null })
    expect(rendered).not.toContain("sk-live-abcdefgh")
    expect(rendered).toContain(Redaction.depthMarker)
  })

  it("stops at the depth cap on a long chain of nested errors", () => {
    // The Error walk recurses through Error-valued members, so a deep cause
    // chain is its own way to exhaust the stack. The cap binds there too.
    const redactor = Redaction.make()
    let nested = new Error("root token=sk-live-abcdefgh") as Error & { inner?: unknown }
    for (let level = 0; level < 250; level++) {
      const outer = new Error(`level ${level}`) as Error & { inner?: unknown }
      outer.inner = nested
      nested = outer
    }
    const rendered = inspect(RedactedLogger.redactArgument(nested, redactor), { depth: null })
    expect(rendered).not.toContain("sk-live-abcdefgh")
    expect(rendered).toContain(Redaction.depthMarker)
  })

  it("does not leak a credential carried by a function or a symbol", () => {
    // The shared walker returns anything that is neither a string nor an
    // object untouched, so a function's own properties never met a rule and
    // `util.inspect` printed them: `[Function: deploy] { token: 'sk-...' }`
    // reached the operator's terminal on the very path case 22 guards.
    const redactor = Redaction.make()
    const handler = Object.assign(() => undefined, { token: "sk-live-abcdefgh" })
    expect(inspect(RedactedLogger.redactArgument(handler, redactor))).not.toContain("sk-live-abcdefgh")
    expect(inspect(RedactedLogger.redactArgument(Symbol("sk-live-abcdefgh"), redactor))).not.toContain(
      "sk-live-abcdefgh"
    )
    class Holder {
      static readonly token = "sk-live-abcdefgh"
    }
    expect(inspect(RedactedLogger.redactArgument(Holder, redactor))).not.toContain("sk-live-abcdefgh")
  })

  it("does not leak a credential a log span carries", () => {
    // Effect's span sanitizer folds `token=` into `token_`, and `_` is a word
    // character, so the api-key rule's leading \b could never fire after it.
    // The assignment rule documents this exact hazard and already guards it.
    const redactor = Redaction.make()
    expect(String(redactor("fetch_token_sk-live-abcdefgh=0ms"))).not.toContain("sk-live-abcdefgh")
    expect(String(redactor("ANTHROPIC_sk-ant-api03-abcdefghij"))).not.toContain("sk-ant-api03-abcdefghij")
  })

  it("keeps a binary view whole instead of one key per byte", () => {
    // The collapse rebuilds a value from its entries, which turns a buffer
    // into an object with one key per byte: a 100 kB buffer rendered 1.4 MB of
    // stderr. A binary view holds no strings, so there is nothing to redact.
    const redactor = Redaction.make()
    const bytes = Buffer.alloc(1_000, 7)
    const rendered = RedactedLogger.redactArgument(bytes, redactor)
    expect(ArrayBuffer.isView(rendered)).toBe(true)
    expect(inspect(rendered).length).toBeLessThan(500)
  })

  it("does not leak a credential the walk cannot reach when the console refuses", () => {
    // Round 5's leak: the delegate's fallback rendered a value the rules had
    // never seen. These are the two shapes that exposed it.
    const redactor = Redaction.make()
    const seen: Array<ReadonlyArray<unknown>> = []
    const brittle = {
      ...console,
      log: (...args: ReadonlyArray<unknown>) => {
        if (seen.length === 0) {
          seen.push(args)
          throw new TypeError("cannot render that")
        }
        seen.push(args)
      }
    } as unknown as Console.Console
    const view = RedactedLogger.redactingConsole(brittle, redactor)
    const hidden = { toJSON: (): string => "Bearer sk-live-abcdefgh" }
    const leaky = Object.assign(() => "sk-live-abcdefgh", { note: "sk-live-abcdefgh" })
    expect(() => view.log(hidden, leaky)).not.toThrow()
    const printed = seen.map((entry) => entry.map((value) => inspect(value)).join(" ")).join("\n")
    expect(printed).not.toContain("sk-live-abcdefgh")
  })

  it("survives a console that refuses every call", () => {
    // The marker retry sits inside the first catch with no guard of its own.
    const redactor = Redaction.make()
    const always = {
      ...console,
      log: () => {
        throw new TypeError("always refuse")
      }
    } as unknown as Console.Console
    const view = RedactedLogger.redactingConsole(always, redactor)
    expect(() => view.log("token=sk-live-abcdefgh")).not.toThrow()
  })

  it("does not leak a credential a RegExp was built from", () => {
    // Restated 2026-09-01: this asserted the value came back as a RegExp with
    // a redacted source. Rebuilding a RegExp from redacted text can throw a
    // SyntaxError from inside the logger, so the class is no longer preserved.
    // What matters is unchanged and still asserted: the credential is gone.
    const redactor = Redaction.make()
    const rendered = inspect(RedactedLogger.redactArgument(new RegExp("sk-live-abcdefgh"), redactor))
    expect(rendered).not.toContain("sk-live-abcdefgh")
  })

  it("renders a value nested past the walk's depth instead of exhausting the stack", () => {
    const redactor = Redaction.make()
    let deep: Record<string, unknown> = { token: "sk-live-abcdefgh" }
    for (let level = 0; level < 20_000; level++) deep = { deep }
    expect(() => RedactedLogger.redactArgument(deep, redactor)).not.toThrow()
  })

  it("collapses an exotic value to its plain redacted form", () => {
    // Restated 2026-09-01: this pinned the type-preserving render (a Date
    // stayed a Date, a Map a Map, a class instance its class). That render is
    // gone: it rebuilt each value on its own prototype, and a host class keeps
    // state a property walk cannot see, so the clone threw the moment a brand
    // check read it and killed the run. The collapse is documented in
    // rc-contract section 7. The invariant this case now holds is the one that
    // matters: whatever the shape, nothing leaks and nothing throws.
    const redactor = Redaction.make()
    const values: ReadonlyArray<unknown> = [
      new Date(0),
      new Map([["apiKey", "sk-live-abcdefgh"]]),
      new Set(["token=sk-live-abcdefgh"]),
      new URL("https://example.test/?token=sk-live-abcdefgh"),
      { apiKey: "sk-live-abcdefgh", endpoint: "https://example.test" },
      ["token=sk-live-abcdefgh"]
    ]
    for (const value of values) {
      const rendered = inspect(RedactedLogger.redactArgument(value, redactor))
      expect(rendered).not.toContain("sk-live-abcdefgh")
    }
    // A plain object still renders as itself, with its credential replaced.
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
