import { Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Maintenance from "../src/Maintenance.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const namespace = { kind: "flow", id: "maintenance" } as const

const run = <A, E>(effect: Effect.Effect<A, E, MemoryStore.MemoryStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestMemory.layer), Effect.provide(TestClock.layer())))

const append = (store: MemoryStore.Service, threadId: string, count: number) =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    (index) =>
      store.appendMessage({
        threadId,
        id: `${threadId}-message-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        text: `text-${index}`,
        at: index
      }),
    { discard: true }
  )

describe("Maintenance", () => {
  it("collects expired facts in one finite TTL pass", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({
        namespace,
        key: "temporary",
        value: "value",
        ttlMs: 5,
        provenance: {}
      })
      yield* store.putFact({ namespace, key: "permanent", value: "value", provenance: {} })
      yield* TestClock.adjust("5 millis")
      const collected = yield* Maintenance.ttlGc
      const facts = yield* store.listFacts({ namespace })
      return { collected, facts }
    }))

    expect(result.collected).toEqual({ deletedFacts: 1 })
    expect(result.facts.map((fact) => fact.key)).toEqual(["permanent"])
  })

  it("deletes oldest history until the approximate token budget is met", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.appendMessage({ threadId: "thread", id: "one", role: "user", text: "1111", at: 1 })
      yield* store.appendMessage({ threadId: "thread", id: "two", role: "assistant", text: "2222", at: 2 })
      yield* store.appendMessage({ threadId: "thread", id: "three", role: "user", text: "3333", at: 3 })
      const limited = yield* Maintenance.limitHistory({ maxTokens: 8, charsPerToken: 1 })
      const messages = yield* store.listMessages({ threadId: "thread" })
      return { limited, messages }
    }))

    expect(result.limited).toEqual({ deletedMessages: 1 })
    expect(result.messages.map((message) => message.id)).toEqual(["two", "three"])
  })

  it("writes the summary before deleting old messages in one transaction", async () => {
    const summarized: Array<ReadonlyArray<string>> = []
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* append(store, "thread", 5)
      const compacted = yield* Maintenance.compact({
        summarizer: {
          summarize: ({ messages }) =>
            Effect.sync(() => {
              summarized.push(messages.map((message) => message.id))
              return "summary text"
            })
        },
        makeSummaryId: () => "summary-fixed"
      })
      const messages = yield* store.listMessages({ threadId: "thread" })
      return { compacted, messages }
    }))

    expect(summarized).toEqual([["thread-message-0", "thread-message-1", "thread-message-2"]])
    expect(result.compacted).toEqual({ compactedThreads: 1, deletedMessages: 3 })
    expect(result.messages).toEqual([
      { threadId: "thread", id: "summary-fixed", role: "system", text: "summary text", at: 0 },
      { threadId: "thread", id: "thread-message-3", role: "assistant", text: "text-3", at: 3 },
      { threadId: "thread", id: "thread-message-4", role: "user", text: "text-4", at: 4 }
    ])
  })

  it("keeps source messages when the summarizer or summary write fails", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* append(store, "summarizer-failure", 4)
      const summarizerExit = yield* Effect.exit(
        Maintenance.compact({
          threadId: "summarizer-failure",
          summarizer: { summarize: () => Effect.fail("summary unavailable") }
        })
      )
      const afterSummarizerFailure = yield* store.listMessages({ threadId: "summarizer-failure" })

      yield* append(store, "write-failure", 4)
      yield* store.appendMessage({
        threadId: "other",
        id: "summary-conflict",
        role: "system",
        text: "existing",
        at: 0
      })
      const writeExit = yield* Effect.exit(
        Maintenance.compact({
          threadId: "write-failure",
          summarizer: { summarize: () => Effect.succeed("summary") },
          makeSummaryId: () => "summary-conflict"
        })
      )
      const afterWriteFailure = yield* store.listMessages({ threadId: "write-failure" })
      return { summarizerExit, afterSummarizerFailure, writeExit, afterWriteFailure }
    }))

    expect(Exit.isFailure(result.summarizerExit)).toBe(true)
    expect(result.afterSummarizerFailure.map((message) => message.id)).toEqual([
      "summarizer-failure-message-0",
      "summarizer-failure-message-1",
      "summarizer-failure-message-2",
      "summarizer-failure-message-3"
    ])
    expect(Exit.isFailure(result.writeExit)).toBe(true)
    expect(result.afterWriteFailure.map((message) => message.id)).toEqual([
      "write-failure-message-0",
      "write-failure-message-1",
      "write-failure-message-2",
      "write-failure-message-3"
    ])
  })

  it("cancels compaction through fiber interruption without deleting history", async () => {
    const messages = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* append(store, "thread", 4)
      const started = yield* Deferred.make<void>()
      const fiber = yield* Maintenance.compact({
        threadId: "thread",
        summarizer: {
          summarize: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
        }
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      return yield* store.listMessages({ threadId: "thread" })
    }))

    expect(messages.map((message) => message.id)).toEqual([
      "thread-message-0",
      "thread-message-1",
      "thread-message-2",
      "thread-message-3"
    ])
  })

  it("rejects a token budget or a character ratio that cannot bound history", async () => {
    const failures = await run(Effect.gen(function*() {
      return [
        yield* Effect.flip(Maintenance.limitHistory({ maxTokens: -1 })),
        yield* Effect.flip(Maintenance.limitHistory({ maxTokens: Number.NaN })),
        yield* Effect.flip(Maintenance.limitHistory({ maxTokens: Number.POSITIVE_INFINITY })),
        yield* Effect.flip(Maintenance.limitHistory({ maxTokens: 1, charsPerToken: 0 })),
        yield* Effect.flip(Maintenance.limitHistory({ maxTokens: 1, charsPerToken: -1 })),
        yield* Effect.flip(Maintenance.limitHistory({ maxTokens: 1, charsPerToken: Number.POSITIVE_INFINITY }))
      ]
    }))

    expect(failures.map((error) => [error.code, error.message])).toEqual([
      ["store", "maxTokens must be a non-negative finite number"],
      ["store", "maxTokens must be a non-negative finite number"],
      ["store", "maxTokens must be a non-negative finite number"],
      ["store", "charsPerToken must be a positive finite number"],
      ["store", "charsPerToken must be a positive finite number"],
      ["store", "charsPerToken must be a positive finite number"]
    ])
  })

  it("empties every thread at a zero token budget and keeps everything under the default ratio", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const empty = yield* Maintenance.limitHistory({ maxTokens: 0 })
      yield* append(store, "one", 2)
      yield* append(store, "two", 1)
      const generous = yield* Maintenance.limitHistory({ maxTokens: 1_000 })
      const kept = yield* store.listMessages({ threadId: "one" })
      const cleared = yield* Maintenance.limitHistory({ maxTokens: 0, charsPerToken: 1 })
      const remaining = yield* Effect.all([
        store.countMessages({ threadId: "one" }),
        store.countMessages({ threadId: "two" })
      ])
      return { empty, generous, kept, cleared, remaining }
    }))

    expect(result.empty).toEqual({ deletedMessages: 0 })
    expect(result.generous).toEqual({ deletedMessages: 0 })
    expect(result.kept.map((message) => message.id)).toEqual(["one-message-0", "one-message-1"])
    expect(result.cleared).toEqual({ deletedMessages: 3 })
    expect(result.remaining).toEqual([0, 0])
  })

  it("rejects a negative or fractional keepRecent", async () => {
    const failures = await run(Effect.gen(function*() {
      const summarizer = { summarize: () => Effect.succeed("summary") }
      return [
        yield* Effect.flip(Maintenance.compact({ summarizer, keepRecent: -1 })),
        yield* Effect.flip(Maintenance.compact({ summarizer, keepRecent: 1.5 }))
      ]
    }))

    expect(failures.map((error) => [error.code, error.message])).toEqual([
      ["store", "keepRecent must be a non-negative safe integer"],
      ["store", "keepRecent must be a non-negative safe integer"]
    ])
  })

  it("compacts nothing when there is no thread, no surplus, or only a system message", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const emptyStore = yield* Maintenance.compact({ summarizer: { summarize: () => Effect.succeed("s") } })
      yield* append(store, "short", 2)
      const atKeepRecent = yield* Maintenance.compact({
        threadId: "short",
        summarizer: { summarize: () => Effect.succeed("s") }
      })
      yield* store.appendMessage({ threadId: "system", id: "system-0", role: "system", text: "boot", at: 0 })
      yield* store.appendMessage({ threadId: "system", id: "system-1", role: "user", text: "one", at: 1 })
      yield* store.appendMessage({ threadId: "system", id: "system-2", role: "assistant", text: "two", at: 2 })
      const systemOnly = yield* Maintenance.compact({
        threadId: "system",
        summarizer: { summarize: () => Effect.succeed("s") }
      })
      const untouched = yield* store.listMessages({ threadId: "system" })
      return { emptyStore, atKeepRecent, systemOnly, untouched }
    }))

    expect(result.emptyStore).toEqual({ compactedThreads: 0, deletedMessages: 0 })
    expect(result.atKeepRecent).toEqual({ compactedThreads: 0, deletedMessages: 0 })
    expect(result.systemOnly).toEqual({ compactedThreads: 0, deletedMessages: 0 })
    expect(result.untouched.map((message) => message.id)).toEqual(["system-0", "system-1", "system-2"])
  })

  it("compacts a single non-system message and replaces every message when keepRecent is zero", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* append(store, "single", 3)
      const single = yield* Maintenance.compact({
        threadId: "single",
        summarizer: { summarize: () => Effect.succeed("older context") }
      })
      const afterSingle = yield* store.listMessages({ threadId: "single" })
      yield* append(store, "all", 2)
      const all = yield* Maintenance.compact({
        threadId: "all",
        keepRecent: 0,
        summarizer: { summarize: ({ messages }) => Effect.succeed(`summary of ${messages.length}`) }
      })
      const afterAll = yield* store.listMessages({ threadId: "all" })
      return { single, afterSingle, all, afterAll }
    }))

    expect(result.single).toEqual({ compactedThreads: 1, deletedMessages: 1 })
    expect(result.afterSingle.map((message) => [message.role, message.text])).toEqual([
      ["system", "older context"],
      ["assistant", "text-1"],
      ["user", "text-2"]
    ])
    expect(result.afterSingle[0]?.id).toMatch(/^summary-[0-9a-f]{64}$/)
    expect(result.all).toEqual({ compactedThreads: 1, deletedMessages: 2 })
    expect(result.afterAll.map((message) => [message.role, message.text])).toEqual([
      ["system", "summary of 2"]
    ])
  })

  it("renders every summarized message as role and text for the injected summarizer", async () => {
    const rendered: Array<string> = []
    await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* append(store, "rendered", 4)
      yield* Maintenance.compact({
        threadId: "rendered",
        summarizer: {
          summarize: (input) =>
            Effect.sync(() => {
              rendered.push(input.rendered)
              return `${input.threadId} summary`
            })
        },
        makeSummaryId: (threadId, messages) => `${threadId}-${messages.length}`
      })
    }))

    expect(rendered).toEqual(["user: text-0\nassistant: text-1"])
  })
})
