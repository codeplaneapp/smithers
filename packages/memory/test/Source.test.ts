import { Cause, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Recall from "../src/Recall.ts"
import * as SnapshotRecorder from "../src/SnapshotRecorder.ts"
import * as Source from "../src/Source.ts"

const storeOf = (listNotes: () => Effect.Effect<ReadonlyArray<{ readonly text: string }>>) =>
  MemoryStore.MemoryStore.of({ listNotes } as unknown as MemoryStore.Service)

const read = (
  input: Source.Input,
  options: {
    readonly store: MemoryStore.Service
    readonly recall: Recall.Service
    readonly source?: Source.Source
    readonly recorder?: Layer.Layer<SnapshotRecorder.SnapshotRecorder>
  }
) => {
  const effect = Source.declaredText(options.source ?? Source.make(), input).pipe(
    Effect.provideService(MemoryStore.MemoryStore, options.store),
    Effect.provideService(Recall.Recall, options.recall)
  )
  return Effect.runPromise(options.recorder === undefined ? effect : Effect.provide(effect, options.recorder))
}

describe("Source", () => {
  it("returns no injection after the advisory timeout", async () => {
    const store = MemoryStore.MemoryStore.of({
      listNotes: () => Effect.never
    } as unknown as MemoryStore.Service)
    const recall = Recall.makeNoop()
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Source.declaredText(Source.make(), {
          lineageId: "lineage",
          iteration: 1,
          banks: ["bank"],
          query: "q"
        }).pipe(
          Effect.provideService(MemoryStore.MemoryStore, store),
          Effect.provideService(Recall.Recall, recall),
          Effect.forkChild({ startImmediately: true })
        )
        yield* TestClock.adjust("5 seconds")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer()))
    )
    expect(result).toMatchObject({ text: "" })
  })

  it("produces the agent's declared memory text shape and freezes a retry snapshot", async () => {
    let reads = 0
    const store = MemoryStore.MemoryStore.of({
      listNotes: () =>
        Effect.sync(() => {
          reads += 1
          return [{ namespace: "bank", text: `primer-${reads}` }]
        })
    } as unknown as MemoryStore.Service)
    const recall = Recall.make({ recall: () => Effect.succeed([]) })
    const source = Source.make()
    const input = { lineageId: "lineage", iteration: 2, banks: ["bank"], query: "q" }
    const first = await Effect.runPromise(
      Source.declaredText(source, input).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store),
        Effect.provideService(Recall.Recall, recall)
      )
    )
    const second = await Effect.runPromise(
      Source.declaredText(source, input).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store),
        Effect.provideService(Recall.Recall, recall)
      )
    )
    expect(first.text).toContain("primer-1")
    expect(second).toEqual(first)
    expect(reads).toBe(1)
    expect(first).toHaveProperty("digest")
  })

  it("preserves a complete fence when applying the byte cap", async () => {
    const store = MemoryStore.MemoryStore.of({
      listNotes: () => Effect.succeed([{ namespace: "bank", text: "x".repeat(1_000) }])
    } as unknown as MemoryStore.Service)
    const result = await Effect.runPromise(
      Source.declaredText(Source.make(), {
        lineageId: "lineage",
        iteration: 3,
        banks: ["bank"],
        query: "q",
        maxBytes: 64
      }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store),
        Effect.provideService(Recall.Recall, Recall.makeNoop())
      )
    )

    expect(Source.byteLength(result.text)).toBeLessThanOrEqual(64)
    expect(result.text).toMatch(/^<flows_memory_context>/)
    expect(result.text).toMatch(/<\/flows_memory_context>$/)
  })

  it("propagates fiber interruption instead of degrading it", async () => {
    const store = MemoryStore.MemoryStore.of({
      listNotes: () => Effect.interrupt
    } as unknown as MemoryStore.Service)
    const exit = await Effect.runPromiseExit(
      Source.declaredText(Source.make(), {
        lineageId: "interrupted",
        iteration: 1,
        banks: ["bank"],
        query: "q"
      }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store),
        Effect.provideService(Recall.Recall, Recall.makeNoop())
      )
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true)
  })

  it("injects nothing when no bank holds a primer and recall returns no row", async () => {
    const declared = await read({ lineageId: "empty", iteration: 0, banks: ["bank"], query: "q" }, {
      store: storeOf(() => Effect.succeed([])),
      recall: Recall.makeNoop()
    })
    expect(declared).toEqual({ text: "", digest: "811c9dc5" })
  })

  it("renders every primer bank before the recalled rows", async () => {
    const declared = await read({
      lineageId: "rendered",
      iteration: 0,
      banks: ["flow-one"],
      primerBanks: ["global-standards", "flow-one"],
      query: "durable"
    }, {
      store: storeOf(() => Effect.succeed([{ text: "primer text" }])),
      recall: Recall.make({
        recall: () => Effect.succeed([{ bank: "flow-one", key: "runbook", text: "recalled text", score: 1 }])
      })
    })

    expect(declared.text).toBe(
      [
        "<flows_memory_context>",
        "[primer:global-standards] primer text",
        "[primer:flow-one] primer text",
        "[flow-one/runbook] recalled text",
        "</flows_memory_context>"
      ].join("\n")
    )
  })

  it("injects nothing when the fence alone exceeds the byte budget", async () => {
    const options = {
      store: storeOf(() => Effect.succeed([{ text: "primer text" }])),
      recall: Recall.makeNoop()
    }
    const tiny = await read({ lineageId: "tiny", iteration: 0, banks: ["bank"], query: "q", maxBytes: 10 }, options)
    const zero = await read({ lineageId: "zero", iteration: 0, banks: ["bank"], query: "q", maxBytes: 0 }, options)
    const negative = await read(
      { lineageId: "negative", iteration: 0, banks: ["bank"], query: "q", maxBytes: -1 },
      options
    )
    const exact = await read({
      lineageId: "exact",
      iteration: 0,
      banks: ["bank"],
      query: "q",
      maxBytes: Source.byteLength("<flows_memory_context>\n\n</flows_memory_context>")
    }, options)

    expect([tiny.text, zero.text, negative.text]).toEqual(["", "", ""])
    expect(exact.text).toBe("<flows_memory_context>\n\n</flows_memory_context>")
  })

  it("keys the frozen snapshot on the lineage and the iteration", async () => {
    let reads = 0
    const source = Source.make()
    const options = {
      source,
      store: storeOf(() =>
        Effect.sync(() => {
          reads += 1
          return [{ text: `read-${reads}` }]
        })
      ),
      recall: Recall.makeNoop()
    }
    const first = await read({ lineageId: "lineage", iteration: 0, banks: ["bank"], query: "q" }, options)
    const replay = await read({ lineageId: "lineage", iteration: 0, banks: ["bank"], query: "q" }, options)
    const next = await read({ lineageId: "lineage", iteration: 1, banks: ["bank"], query: "q" }, options)
    const other = await read({ lineageId: "other", iteration: 0, banks: ["bank"], query: "q" }, options)

    expect(replay).toEqual(first)
    expect(next.text).toContain("read-2")
    expect(other.text).toContain("read-3")
    expect(reads).toBe(3)
  })

  it("refetches for a source built after the one that froze the snapshot", async () => {
    // With no recorder composed, a second source retains the documented
    // memory-only fallback and reads current memory into its own local memo.
    let reads = 0
    const store = storeOf(() =>
      Effect.sync(() => {
        reads += 1
        return [{ text: `memory as it stood at read ${reads}` }]
      })
    )
    const input = { lineageId: "resumed", iteration: 0, banks: ["bank"], query: "q" }
    const original = Source.make()
    const first = await read(input, { source: original, store, recall: Recall.makeNoop() })
    const held = await read(input, { source: original, store, recall: Recall.makeNoop() })
    // The next process, with the same lineage and iteration.
    const resumed = await read(input, { source: Source.make(), store, recall: Recall.makeNoop() })

    expect(held).toEqual(first)
    expect(resumed).not.toEqual(first)
    expect(reads).toBe(2)
  })

  it("replays a recorded snapshot into a second source after memory changes", async () => {
    const recorded = new Map<string, string>()
    const recorder = SnapshotRecorder.layer({
      record: (identity, effect) =>
        Effect.suspend(() => {
          const key = `${identity.lineageId}\u0000${identity.iteration}`
          const snapshot = recorded.get(key)
          return snapshot === undefined
            ? effect.pipe(Effect.tap((text) => Effect.sync(() => recorded.set(key, text))))
            : Effect.succeed(snapshot)
        })
    })
    let reads = 0
    let memory = "memory before the crash"
    const store = storeOf(() =>
      Effect.sync(() => {
        reads += 1
        return [{ text: memory }]
      })
    )
    const input = { lineageId: "durable", iteration: 4, banks: ["bank"], query: "q" }
    const first = await read(input, { source: Source.make(), store, recall: Recall.makeNoop(), recorder })

    memory = "memory after the crash"
    const resumed = await read(input, { source: Source.make(), store, recall: Recall.makeNoop(), recorder })

    expect(first.text).toContain("memory before the crash")
    expect(resumed).toEqual(first)
    expect(resumed.text).not.toContain("memory after the crash")
    expect(reads).toBe(1)
  })

  it("evicts the least recently used snapshot at its finite capacity", async () => {
    let reads = 0
    const source = Source.make({ capacity: 1 })
    const options = {
      source,
      store: storeOf(() => Effect.sync(() => [{ text: `read-${++reads}` }])),
      recall: Recall.makeNoop()
    }
    await read({ lineageId: "a", iteration: 0, banks: ["bank"], query: "q" }, options)
    await read({ lineageId: "b", iteration: 0, banks: ["bank"], query: "q" }, options)
    const reloaded = await read({ lineageId: "a", iteration: 0, banks: ["bank"], query: "q" }, options)
    expect(reloaded.text).toContain("read-3")
    expect(reads).toBe(3)
  })

  it("digests identical text identically and changes the digest when the text changes", async () => {
    const options = { store: storeOf(() => Effect.succeed([{ text: "same" }])), recall: Recall.makeNoop() }
    const first = await read({ lineageId: "a", iteration: 0, banks: ["bank"], query: "q" }, options)
    const second = await read({ lineageId: "b", iteration: 0, banks: ["bank"], query: "q" }, options)
    const changed = await read({ lineageId: "c", iteration: 0, banks: ["bank"], query: "q" }, {
      ...options,
      store: storeOf(() => Effect.succeed([{ text: "edited" }]))
    })

    expect(second).toEqual(first)
    expect(changed.digest).not.toBe(first.digest)
    expect(first.digest).toMatch(/^[0-9a-f]{8}$/)
  })

  it("reads through the default source value", async () => {
    const declared = await read({ lineageId: "default-source", iteration: 0, banks: [], query: "q" }, {
      source: Source.source,
      store: storeOf(() => Effect.succeed([])),
      recall: Recall.makeNoop()
    })
    expect(declared.text).toBe("")
  })

  it("truncates to a byte budget without splitting a code point", () => {
    expect(Source.byteLength("")).toBe(0)
    expect(Source.byteLength("héllo")).toBe(6)
    expect(Source.truncate("héllo", 6)).toBe("héllo")
    expect(Source.truncate("héllo", 7)).toBe("héllo")
    expect(Source.truncate("héllo", 2)).toBe("h")
    expect(Source.truncate("héllo", 0)).toBe("")
    expect(Source.truncate("😀😀", 4)).toBe("😀")
  })
})
