import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Cause, Deferred, Effect, Layer, Logger, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  InvalidJournalLoggerOptions,
  layerJournalForwarding,
  maximumCapacity,
  maximumSnapshotBytes,
  maximumSnapshotDepth,
  maximumSnapshotMembers,
  TelemetryLog,
  truncatedMarker,
  unrenderableMarker
} from "../src/JournalLogger.ts"

const run = <A, E>(program: Effect.Effect<A, E, never>) => Effect.runPromise(program.pipe(Effect.scoped))
const runId = (value: string): JournalEvent.RunId => Schema.decodeUnknownSync(JournalEvent.RunId)(value)

const entriesEventually = (
  journal: Journal.Service,
  id: JournalEvent.RunId,
  count: number
): Effect.Effect<ReadonlyArray<JournalEvent.Entry>, Journal.JournalError> =>
  Effect.gen(function*() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const page = yield* journal.entries({ runId: id, limit: 100 })
      if (page.entries.length >= count) return page.entries
      yield* Effect.sleep("5 millis")
    }
    return (yield* journal.entries({ runId: id, limit: 100 })).entries
  })

const logOnce = (id: JournalEvent.RunId, message: unknown) =>
  Effect.gen(function*() {
    yield* Effect.logInfo(message)
    yield* Effect.sleep("10 millis")
  }).pipe(Effect.provide(layerJournalForwarding({ runId: id })), Effect.scoped)

describe("JournalLogger", () => {
  it("forwards a runtime-decodable versioned record without changing the logged effect", async () => {
    const id = runId("obs-run")
    const result = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logInfo("hello")
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload)
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    expect(result).toMatchObject({
      version: 1,
      level: "Info",
      message: ["hello"],
      cause: { version: 1, reasons: [] }
    })
  })

  it("lets the journal allocate distinct identities across restarted and concurrent logger scopes", async () => {
    const id = runId("restart-run")
    const entries = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* logOnce(id, "first")
        yield* logOnce(id, "second")
        yield* Effect.all([logOnce(id, "third"), logOnce(id, "fourth")], { concurrency: "unbounded" })
        return yield* entriesEventually(journal, id, 4)
      }).pipe(Effect.provide(TestJournal.layer()))
    )

    expect(entries.slice(0, 2).map((entry) => entry.payload)).toEqual([
      expect.objectContaining({ message: ["first"] }),
      expect.objectContaining({ message: ["second"] })
    ])
    expect(entries.slice(2).map((entry) => (entry.payload as TelemetryLog).message).sort()).toEqual([
      ["fourth"],
      ["third"]
    ])
    expect(new Set(entries.map((entry) => entry.sourceSeq)).size).toBe(4)
  })

  it("snapshots mutable messages and annotations before asynchronous delivery", async () => {
    const id = runId("snapshot-run")
    const message = { value: "before", nested: { token: "sk-live-abcdefgh" } }
    const annotation = { value: "annotation-before" }
    const payload = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logInfo(message).pipe(Effect.annotateLogs({ snapshot: annotation }))
        message.value = "after"
        message.nested.token = "after"
        annotation.value = "annotation-after"
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload)
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    expect(payload.message).toEqual([{ value: "before", nested: { token: "[REDACTED]" } }])
    expect(payload.annotations).toEqual({ snapshot: { value: "annotation-before" } })
  })

  it("names cycles, accessors, revoked proxies, binaries, and bounded excess", async () => {
    const id = runId("hostile-run")
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        throw new Error("must not run")
      }
    })
    const revoked = Proxy.revocable({ value: "secret" }, {})
    revoked.revoke()
    const many = Object.fromEntries(
      Array.from({ length: maximumSnapshotMembers + 10 }, (_, index) => [`key-${index}`, index])
    )

    const payloads = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        // Effect itself probes top-level messages for its Cause type id, which
        // necessarily touches a revoked proxy before any logger runs. Nesting
        // it exercises the forwarding boundary without tripping that upstream
        // precondition.
        yield* Effect.logInfo(cycle, accessor, { revoked: revoked.proxy }, new Uint8Array([1, 2]), many, 1n, undefined)
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload).message as ReadonlyArray<unknown>
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    expect(payloads[0]).toEqual({ self: "[Circular]" })
    expect(payloads[1]).toEqual({ value: unrenderableMarker })
    expect(payloads[2]).toEqual({ revoked: unrenderableMarker })
    expect(payloads[3]).toBe("[Binary]")
    expect(payloads[4]).toMatchObject({ [truncatedMarker]: truncatedMarker })
    expect(payloads.slice(5)).toEqual([truncatedMarker])
  })

  it("detaches every supported value shape within explicit depth and byte ceilings", async () => {
    const id = runId("value-shapes-run")
    const deep: Record<string, unknown> = {}
    let cursor = deep
    for (let depth = 0; depth <= maximumSnapshotDepth + 1; depth++) {
      const next: Record<string, unknown> = {}
      cursor.next = next
      cursor = next
    }
    const sparse = new Array<unknown>(2)
    sparse[1] = "tail"
    const descriptorless = new Proxy({}, {
      ownKeys: () => ["missing"],
      getOwnPropertyDescriptor: () => undefined
    })
    const unreadable = new Proxy({}, {
      ownKeys: () => {
        throw new Error("unreadable keys")
      }
    })
    const hostileError = new Proxy(new Error("boom"), {
      get: (target, key, receiver) => {
        if (key === "stack") throw new Error("unreadable stack")
        return Reflect.get(target, key, receiver)
      }
    })

    const entries = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logInfo(
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
          Number.NaN,
          true,
          false,
          null,
          1n,
          undefined,
          () => undefined,
          Symbol("shape"),
          new Date(0),
          new Date(Number.NaN),
          hostileError,
          sparse,
          descriptorless,
          unreadable,
          deep
        )
        yield* Effect.logInfo("x".repeat(maximumSnapshotBytes + 100), "after-budget")
        yield* Effect.logInfo(
          "x".repeat(maximumSnapshotBytes - 100),
          "y".repeat(200)
        )
        yield* Effect.logInfo("spanned").pipe(Effect.withSpan("journal-logger-span"))
        return yield* entriesEventually(journal, id, 4)
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    const shapes = Schema.decodeUnknownSync(TelemetryLog)(entries[0]!.payload)
      .message as ReadonlyArray<unknown>
    expect(shapes.slice(0, 7)).toEqual(["Infinity", "-Infinity", "NaN", true, false, null, "1n"])
    expect(shapes[7]).toBe("[Undefined]")
    expect(shapes[8]).toBe("[Function]")
    expect(shapes[9]).toBe("[Symbol]")
    expect(shapes[10]).toBe("1970-01-01T00:00:00.000Z")
    expect(shapes[11]).toBe(unrenderableMarker)
    expect(shapes[12]).toMatchObject({ name: "Error", message: "boom", stack: unrenderableMarker })
    expect(shapes[13]).toEqual([unrenderableMarker, "tail"])
    expect(shapes[14]).toEqual({ missing: unrenderableMarker })
    expect(shapes[15]).toBe(unrenderableMarker)
    expect(JSON.stringify(shapes[16])).toContain("[Deep]")

    const bounded = Schema.decodeUnknownSync(TelemetryLog)(entries[1]!.payload)
    expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(maximumSnapshotBytes)
    expect(JSON.stringify(bounded.message)).toContain(truncatedMarker)

    const secondBounded = Schema.decodeUnknownSync(TelemetryLog)(entries[2]!.payload)
    expect(JSON.stringify(secondBounded.message)).toContain(truncatedMarker)

    const spanned = Schema.decodeUnknownSync(TelemetryLog)(entries[3]!.payload)
    expect(spanned.traceId).toBeTypeOf("string")
    expect(spanned.spanId).toBeTypeOf("string")
  })

  it("keeps the logger callback total when runtime-owned metadata is unreadable", async () => {
    const id = runId("metadata-fallback-run")
    const payload = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.withFiber((fiber) =>
          Effect.sync(() => {
            const logger = [...fiber.getRef(Logger.CurrentLoggers)][0]!
            logger.log({
              message: ["unreachable"],
              logLevel: "Info",
              cause: Cause.empty,
              fiber: {
                id: fiber.id,
                get currentSpan(): never {
                  throw new Error("unreadable current span")
                }
              } as never,
              date: new Date(0)
            })
          })
        )
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload)
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    expect(payload).toMatchObject({
      message: unrenderableMarker,
      annotations: {},
      cause: { version: 1, reasons: [] },
      timestamp: "1970-01-01T00:00:00.000Z"
    })
  })

  it("persists ordered fail, defect, and interrupt reasons with redaction", async () => {
    const id = runId("cause-run")
    const cause = Cause.combine(
      Cause.fail(new Error("request failed token=sk-live-abcdefgh")),
      Cause.combine(
        Cause.die({ apiKey: "secret" }),
        Cause.combine(Cause.interrupt(41), Cause.interrupt())
      )
    )
    const payload = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logError("failed", cause)
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload)
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    expect(payload.cause.reasons).toMatchObject([
      { _tag: "Fail", error: { name: "Error", message: "request failed token=[REDACTED]" } },
      { _tag: "Die", defect: { apiKey: "[REDACTED]" } },
      { _tag: "Interrupt", fiberId: 41 },
      { _tag: "Interrupt", fiberId: null }
    ])
  })

  it("drops a record when the bounded queue is actually saturated", async () => {
    const id = runId("overflow-run")
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const seen: Array<JournalEvent.Input> = []
    let sequence = 0
    await run(
      Effect.gen(function*() {
        yield* Effect.logInfo("first")
        yield* Deferred.await(entered)
        yield* Effect.logInfo("second")
        yield* Effect.logInfo("dropped")
        yield* Deferred.succeed(release, undefined)
        yield* Effect.sleep("20 millis")
      }).pipe(
        Effect.provide(
          Layer.provide(
            layerJournalForwarding({ runId: id, capacity: 1 }),
            Journal.layerNoop({
              emitLossy: (input) =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.tap(() => Effect.sync(() => seen.push(input))),
                  Effect.map(() => ({
                    _tag: "Accepted" as const,
                    seq: sequence as JournalEvent.Seq,
                    sourceSeq: sequence++ as JournalEvent.SourceSeq
                  }))
                )
            })
          )
        )
      )
    )
    expect(seen.map((input) => (input.payload as TelemetryLog).message)).toEqual([["first"], ["second"]])
  })

  it("rejects invalid options before starting a lossy worker", async () => {
    const invalid: ReadonlyArray<readonly [string, unknown]> = [
      ["runId", ""],
      ["runId", `run${String.fromCharCode(0)}id`],
      ["runId", "\ud800"],
      ["runId", "x".repeat(JournalEvent.maxIdentifierLength + 1)],
      ["capacity", 0],
      ["capacity", maximumCapacity + 1],
      ["capacity", 1.5],
      ["capacity", Number.NaN],
      ["capacity", Number.POSITIVE_INFINITY],
      ["options", null]
    ]
    for (const [path, value] of invalid) {
      const options = path === "options"
        ? value
        : path === "runId"
        ? { runId: value }
        : { runId: runId("valid-run"), capacity: value }
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Layer.build(
            Layer.provide(layerJournalForwarding(options as never), Journal.layerNoop())
          )
        )
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const failure = Result.getOrUndefined(Cause.findError(exit.cause))
        expect(failure).toBeInstanceOf(InvalidJournalLoggerOptions)
        expect((failure as InvalidJournalLoggerOptions).path).toContain(path)
      }
    }
  })

  it("accepts the exact queue-capacity boundaries", async () => {
    for (const capacity of [1, maximumCapacity]) {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Layer.build(
            Layer.provide(
              layerJournalForwarding({
                runId: runId(`capacity-${capacity}`),
                capacity,
                ...(capacity === 1 ? { minimumLogLevel: "Debug" as const } : {})
              }),
              Journal.layerNoop()
            )
          )
        )
      )
      expect(exit._tag).toBe("Success")
    }
  })

  it("preserves scope interruption while a journal write is in flight", async () => {
    const entered = Deferred.makeUnsafe<void>()
    await run(
      Effect.gen(function*() {
        yield* Effect.logInfo("closing")
        yield* Deferred.await(entered)
      }).pipe(
        Effect.provide(
          Layer.provide(
            layerJournalForwarding({ runId: runId("interrupt-run") }),
            Journal.layerNoop({
              emitLossy: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
            })
          )
        )
      )
    )
  })

  it("keeps the ambient loggers when asked to merge with them", async () => {
    const seen: Array<unknown> = []
    const ambient = Logger.make<unknown, void>((options) => seen.push(options.message))
    await run(
      Effect.gen(function*() {
        yield* Effect.logInfo("merged")
        yield* Effect.sleep("10 millis")
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            layerJournalForwarding({ runId: runId("obs-merge"), mergeWithExisting: true }),
            Layer.merge(TestJournal.layer(), Logger.layer([ambient], { mergeWithExisting: false }))
          )
        )
      )
    )

    expect(seen).toEqual([["merged"]])
  })
})
