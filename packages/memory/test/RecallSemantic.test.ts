import { DurableWriter } from "@smthrs/database/DurableWriter"
import { Cause, Effect } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Embedding from "../src/Embedding.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Recall from "../src/Recall.ts"
import * as Semantic from "../src/RecallSemantic.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const searchRow = (overrides: Partial<MemoryStore.SearchRow>): MemoryStore.SearchRow => ({
  id: "id",
  kind: "note",
  bank: "flow-bank",
  namespace: { kind: "flow", id: "bank" },
  key: "key",
  text: "text",
  tags: [],
  updatedAtMs: 0,
  status: "accepted",
  ...overrides
})

const storeOf = (rows: ReadonlyArray<MemoryStore.SearchRow>) =>
  MemoryStore.MemoryStore.of({ searchRows: () => Effect.succeed(rows) } as unknown as MemoryStore.Service)

const projection = (overrides: Partial<Semantic.Vector>): Semantic.Vector => ({
  bank: "flow-bank",
  key: "key",
  model: Semantic.defaultModel,
  contentDigest: "digest",
  dimensions: 2,
  vector: [1, 0],
  updatedAtMs: 0,
  ...overrides
})

const vectorStoreOf = (vectors: ReadonlyArray<Semantic.Vector>): Semantic.VectorStore => ({
  list: () => Effect.succeed(vectors),
  upsert: () => Effect.void
})

const queryVector = Embedding.make(() => Effect.succeed([[1, 0]]))

describe("RecallSemantic", () => {
  it("ranks by cosine and recency decay", async () => {
    const store = MemoryStore.MemoryStore.of({
      searchRows: () =>
        Effect.succeed([
          {
            id: "near",
            kind: "note",
            bank: "bank",
            namespace: { kind: "flow", id: "bank" },
            key: "near",
            text: "near",
            tags: [],
            status: "accepted",
            updatedAtMs: 1000
          },
          {
            id: "old",
            kind: "note",
            bank: "bank",
            namespace: { kind: "flow", id: "bank" },
            key: "old",
            text: "old",
            tags: [],
            status: "accepted",
            updatedAtMs: 0
          }
        ])
    } as unknown as MemoryStore.Service)
    const vectors: Semantic.Vector[] = [
      {
        bank: "bank",
        key: "near",
        model: "test",
        contentDigest: "a",
        dimensions: 2,
        vector: [1, 0],
        updatedAtMs: 1000
      },
      {
        bank: "bank",
        key: "old",
        model: "test",
        contentDigest: "b",
        dimensions: 2,
        vector: [0.99, 0.01],
        updatedAtMs: 0
      }
    ]
    const embedding = Embedding.make(() => Effect.succeed([[1, 0]]))
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        yield* TestClock.setTime(1_000)
        return yield* Semantic.recall({ banks: ["bank"], query: "q", budget: "low" }, {
          vectorStore: { list: () => Effect.succeed(vectors), upsert: () => Effect.void },
          model: "test",
          halfLifeMs: 1000
        })
      }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store),
        Effect.provideService(Embedding.Embedding, embedding),
        Effect.provide(TestClock.layer())
      )
    )
    expect(result[0]?.key).toBe("near")
  })

  it("logs projection failures without failing the committed write path", async () => {
    const embedding = Embedding.make(() => Effect.succeed([[1]]))
    const projector = Semantic.makeProjector({
      vectorStore: {
        list: () => Effect.succeed([]),
        upsert: () => Effect.fail(new (class extends Error {})()) as never
      }
    })
    await expect(Effect.runPromise(
      Semantic.projectAfterCommit(projector, {
        bank: "bank",
        key: "key",
        text: "text",
        updatedAtMs: 0
      }).pipe(Effect.provideService(Embedding.Embedding, embedding))
    )).resolves.toBeUndefined()
  })

  it("serializes same-key projections without replaying prior effects", async () => {
    let writes = 0
    const embedding = Embedding.make(() => Effect.succeed([[1]]))
    const projector = Semantic.makeProjector({
      vectorStore: {
        list: () => Effect.succeed([]),
        upsert: () =>
          Effect.sync(() => {
            writes += 1
          })
      }
    })
    const row = {
      bank: "bank",
      key: "key",
      text: "text",
      updatedAtMs: 0
    }

    await Effect.runPromise(
      Effect.all([projector(row), projector(row)], { concurrency: "unbounded" }).pipe(
        Effect.provideService(Embedding.Embedding, embedding)
      )
    )

    expect(writes).toBe(2)
  })

  it("propagates projection interruption", async () => {
    const embedding = Embedding.make(() => Effect.interrupt)
    const projector = Semantic.makeProjector({
      vectorStore: {
        list: () => Effect.succeed([]),
        upsert: () => Effect.void
      }
    })
    const exit = await Effect.runPromiseExit(
      projector({ bank: "bank", key: "key", text: "text", updatedAtMs: 0 }).pipe(
        Effect.provideService(Embedding.Embedding, embedding)
      )
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true)
  })

  it("fails with a typed embedding error when the projection does not match the query", async () => {
    const failing = (options: Semantic.Options) =>
      Effect.runPromise(
        Effect.flip(Semantic.recall({ banks: ["flow-bank"], query: "q" }, options)).pipe(
          Effect.provideService(MemoryStore.MemoryStore, storeOf([])),
          Effect.provideService(Embedding.Embedding, queryVector),
          Effect.provide(TestClock.layer())
        )
      )

    const model = await failing({ vectorStore: vectorStoreOf([projection({ model: "other" })]) })
    const storedDimensions = await failing({
      vectorStore: vectorStoreOf([projection({ dimensions: 3, vector: [1, 0] })])
    })
    const vectorLength = await failing({
      vectorStore: vectorStoreOf([projection({ dimensions: 2, vector: [1, 0, 0] })])
    })
    const zeroHalfLife = await failing({ vectorStore: vectorStoreOf([]), halfLifeMs: 0 })
    const infiniteHalfLife = await failing({
      vectorStore: vectorStoreOf([]),
      halfLifeMs: Number.POSITIVE_INFINITY
    })

    expect([model, storedDimensions, vectorLength, zeroHalfLife, infiniteHalfLife].map((error) => [
      error.code,
      error.message
    ])).toEqual([
      ["embedding_unavailable", `embedding model mismatch: expected ${Semantic.defaultModel}`],
      ["embedding_unavailable", "embedding dimensions do not match the query vector"],
      ["embedding_unavailable", "embedding dimensions do not match the query vector"],
      ["embedding_unavailable", "semantic recency configuration must be finite with a positive half-life"],
      ["embedding_unavailable", "semantic recency configuration must be finite with a positive half-life"]
    ])
  })

  it("skips unresolved, non-accepted, untagged, and orthogonal rows, then breaks ties by key", async () => {
    const store = storeOf([
      searchRow({ id: "tie-b", key: "tie-b", text: "b", tags: ["scope:project"], updatedAtMs: 5 }),
      searchRow({ id: "tie-a", key: "tie-a", text: "a", tags: ["scope:project"], updatedAtMs: 5 }),
      searchRow({ id: "pending", key: "pending", text: "p", tags: ["scope:project"], status: "pending" }),
      searchRow({ id: "untagged", key: "untagged", text: "u", tags: [] }),
      searchRow({ id: "orthogonal", key: "orthogonal", text: "o", tags: ["scope:project"] })
    ])
    const rows = await Effect.runPromise(
      Semantic.recall({
        banks: ["flow-bank"],
        query: "q",
        tagGroups: [{ tags: ["scope:project"], match: "all_strict" }]
      }, {
        vectorStore: vectorStoreOf([
          projection({ key: "tie-b", recordId: "tie-b", recordKind: "note", updatedAtMs: 5 }),
          projection({ key: "tie-a", recordId: "tie-a", recordKind: "note", updatedAtMs: 5 }),
          projection({ key: "orphan", recordId: "orphan" }),
          projection({ key: "pending", recordId: "pending" }),
          projection({ key: "untagged", recordId: "untagged" }),
          projection({ key: "orthogonal", recordId: "orthogonal", vector: [0, 1] })
        ]),
        halfLifeMs: 1000
      }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store),
        Effect.provideService(Embedding.Embedding, queryVector),
        Effect.provide(TestClock.layer())
      )
    )

    expect(rows.map((row) => [row.bank, row.key])).toEqual([
      ["flow-bank", "tie-a"],
      ["flow-bank", "tie-b"]
    ])
  })

  it("limits results by the declared budget and then by the token cap", async () => {
    const keys = Array.from({ length: 6 }, (_, index) => `row-${index}`)
    const store = storeOf(keys.map((key) => searchRow({ id: key, key, text: `text for ${key}` })))
    const options = {
      vectorStore: vectorStoreOf(
        keys.map((key, index) => projection({ key, recordId: key, vector: [1, index / 100] }))
      ),
      halfLifeMs: 1000
    }
    const recall = (input: Recall.Input) =>
      Effect.runPromise(
        Semantic.recall(input, options).pipe(
          Effect.provideService(MemoryStore.MemoryStore, store),
          Effect.provideService(Embedding.Embedding, queryVector),
          Effect.provide(TestClock.layer())
        )
      )

    const low = await recall({ banks: ["flow-bank"], query: "q", budget: "low" })
    const mid = await recall({ banks: ["flow-bank"], query: "q" })
    const high = await recall({ banks: ["flow-bank"], query: "q", budget: "high" })
    const capped = await recall({ banks: ["flow-bank"], query: "q", budget: "high", maxTokens: 120 })

    expect(Semantic.budgetLimits).toEqual({ low: 3, mid: 8, high: 20 })
    expect(low).toHaveLength(3)
    expect(mid).toHaveLength(6)
    expect(high).toHaveLength(6)
    expect(capped.length).toBeLessThan(6)
  })

  it("uses the wall clock and the default half-life when the caller declares neither", async () => {
    const store = storeOf([searchRow({ id: "fresh", key: "fresh", text: "fresh" })])
    const rows = await Effect.runPromise(
      Semantic.recall({ banks: ["flow-bank"], query: "q" }, {
        vectorStore: vectorStoreOf([
          projection({ key: "fresh", recordId: "fresh", updatedAtMs: Date.now() })
        ])
      }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store),
        Effect.provideService(Embedding.Embedding, queryVector),
        Effect.provide(TestClock.layer())
      )
    )

    expect(rows.map((row) => row.key)).toEqual(["fresh"])
    expect(rows[0]?.score).toBeGreaterThan(0.99)
  })

  it("scores cosine similarity and recency decay at their boundaries", () => {
    const withHole = JSON.parse("[null, 1]") as ReadonlyArray<number>
    expect(Semantic.cosineSimilarity([], [])).toBe(0)
    expect(Semantic.cosineSimilarity([1, 0], [1])).toBe(0)
    expect(Semantic.cosineSimilarity([0, 0], [1, 0])).toBe(0)
    expect(Semantic.cosineSimilarity([1, 0], [0, 0])).toBe(0)
    expect(Semantic.cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(Semantic.cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1)
    expect(Semantic.cosineSimilarity(withHole, [0, 1])).toBeCloseTo(1)
    expect(Semantic.cosineSimilarity([0, 1], withHole)).toBeCloseTo(1)
    expect(Semantic.recencyDecay(10, 5, 1_000)).toBe(1)
    expect(Semantic.recencyDecay(0, 0, 1_000)).toBe(1)
    expect(Semantic.recencyDecay(0, 1_000, 1_000)).toBeCloseTo(Math.exp(-1))
    expect(Semantic.defaultModel).toBe(Embedding.inProcessModel)
  })

  it("round-trips vectors through the migration-owned table and updates them on conflict", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const vectors = Semantic.makeSqlVectorStore({ sql, write: writer.write })
        yield* vectors.upsert({
          bank: "flow-one",
          key: "runbook",
          model: "test",
          contentDigest: "a",
          dimensions: 2,
          vector: [0.5, -0.25],
          updatedAtMs: 7,
          recordKind: "fact",
          recordId: "runbook"
        })
        yield* vectors.upsert({
          bank: "agent-fleet",
          key: "note",
          model: "test",
          contentDigest: "b",
          dimensions: 1,
          vector: [1],
          updatedAtMs: 8
        })
        const before = yield* vectors.list(["flow-one", "agent-fleet", "user-empty"])
        yield* vectors.upsert({
          bank: "flow-one",
          key: "runbook",
          model: "test",
          contentDigest: "c",
          dimensions: 2,
          vector: [1, 0],
          updatedAtMs: 9,
          recordKind: "fact",
          recordId: "runbook"
        })
        const after = yield* vectors.list(["flow-one"])
        return { before, after }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(result.before.map((vector) => [vector.bank, vector.key, vector.recordKind, vector.dimensions])).toEqual([
      ["flow-one", "runbook", "fact", 2],
      ["agent-fleet", "note", "note", 1]
    ])
    expect(result.before[0]?.vector).toEqual([0.5, -0.25])
    expect(result.after).toHaveLength(1)
    expect(result.after[0]).toMatchObject({ contentDigest: "c", updatedAtMs: 9 })
    expect(result.after[0]?.vector).toEqual([1, 0])
  })

  it("reports a typed store error when the vector table is unavailable", async () => {
    const failures = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const vectors = Semantic.makeSqlVectorStore({ sql, write: writer.write })
        yield* sql`DROP TABLE memory_vectors`
        return [
          yield* Effect.flip(vectors.upsert({
            bank: "flow-one",
            key: "runbook",
            model: "test",
            contentDigest: "a",
            dimensions: 1,
            vector: [1],
            updatedAtMs: 0
          })),
          yield* Effect.flip(vectors.list(["flow-one"]))
        ]
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(failures.map((error) => [error.code, error.message])).toEqual([
      ["store", "memory vector projection failed"],
      ["store", "memory vector projection failed"]
    ])
  })

  it("rejects corrupt vector dimensions and byte lengths as a typed store error", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const vectors = Semantic.makeSqlVectorStore({ sql, write: writer.write })
        yield* sql`INSERT INTO memory_vectors (
          record_kind, record_id, namespace_kind, namespace_id,
          embedding_model, content_digest, dimensions, vector_bytes, updated_at_ms
        ) VALUES ('note', 'bad', 'flow', 'one', 'test', 'digest', 2, ${new Uint8Array(4)}, 0)`
        return yield* Effect.flip(vectors.list(["flow-one"]))
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )
    expect(failure).toMatchObject({ code: "store", message: expect.stringContaining("invalid dimensions") })
  })

  it("projects a decorated fact and note write after the authoritative commit", async () => {
    const projected: Array<Parameters<ReturnType<typeof Semantic.makeProjector>>[0]> = []
    const projector: Semantic.Projector = Object.assign((row: Parameters<Semantic.Projector>[0]) =>
      Effect.sync(() => {
        projected.push(row)
      }), { activeKeys: () => 0 })
    const facts = new Map<string, MemoryStore.PutFactInput>()
    const decorated = Semantic.decorateStore(
      MemoryStore.makeNoop({
        putFact: (input) => Effect.sync(() => void facts.set(input.key, input)),
        getFact: (input) =>
          Effect.sync(() => {
            const fact = facts.get(input.key)
            return fact === undefined ? undefined : { ...fact, createdAtMs: 7, updatedAtMs: 7 }
          }),
        putNote: (input) =>
          Effect.succeed({
            namespace: input.namespace,
            id: input.id,
            text: input.text,
            tags: input.tags,
            provenance: input.provenance,
            status: input.status ?? "accepted",
            createdAtMs: 11
          })
      }),
      projector,
      Embedding.makeInProcess()
    )
    const namespace = { kind: "flow", id: "one" } as const

    const note = await Effect.runPromise(Effect.gen(function*() {
      yield* decorated.putFact({ namespace, key: "string", value: "already text", provenance: {} })
      yield* decorated.putFact({ namespace, key: "json", value: { content: "structured" }, provenance: {} })
      yield* decorated.putFact({ namespace, key: "absent", value: undefined, provenance: {} })
      yield* decorated.putFact({ namespace, key: "unserializable", value: 1n, provenance: {} })
      return yield* decorated.putNote({ namespace, id: "note", text: "note text", tags: [], provenance: {} })
    }))
    const passthrough = await Effect.runPromise(Effect.flip(decorated.listAllFacts()))

    expect(projected.map((row) => [row.recordKind, row.key, row.text])).toEqual([
      ["fact", "string", "already text"],
      ["fact", "json", "{\"content\":\"structured\"}"],
      ["fact", "absent", "undefined"],
      ["fact", "unserializable", "1"],
      ["note", "note", "note text"]
    ])
    expect(projected.every((row) => row.bank === "flow-one")).toBe(true)
    expect(projected.at(-1)?.updatedAtMs).toBe(11)
    expect(projected[0]?.updatedAtMs).toBe(7)
    expect(note.id).toBe("note")
    expect(passthrough.message).toBe("listAllFacts is unavailable")
  })

  it("names the projected model and digest a committed row", async () => {
    const upserted: Array<Semantic.Vector> = []
    const projector = Semantic.makeProjector({
      model: "test-model",
      vectorStore: {
        list: () => Effect.succeed([]),
        upsert: (vector) =>
          Effect.sync(() => {
            upserted.push(vector)
          })
      }
    })
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* projector({ bank: "flow-one", key: "k", text: "same text", updatedAtMs: 1 })
        yield* projector({ bank: "flow-one", key: "k", text: "same text", updatedAtMs: 2 })
        yield* projector({ bank: "flow-one", key: "k", text: "edited text", updatedAtMs: 3 })
      }).pipe(Effect.provideService(Embedding.Embedding, Embedding.makeInProcess()))
    )

    expect(upserted.map((vector) => vector.model)).toEqual(["test-model", "test-model", "test-model"])
    expect(upserted[0]?.contentDigest).toBe(upserted[1]?.contentDigest)
    expect(upserted[2]?.contentDigest).not.toBe(upserted[0]?.contentDigest)
    expect(upserted[0]?.dimensions).toBe(64)
    expect(projector.activeKeys()).toBe(0)
  })

  it("installs semantic recall as the recall service", async () => {
    const rows = await Effect.runPromise(
      Effect.service(Recall.Recall).pipe(
        Effect.flatMap((recall) => recall.recall({ banks: ["flow-bank"], query: "runbook" })),
        Effect.provide(Semantic.layer({
          vectorStore: vectorStoreOf([projection({ key: "runbook", recordId: "runbook", model: "test" })]),
          model: "test",
          halfLifeMs: 1_000
        })),
        Effect.provideService(
          MemoryStore.MemoryStore,
          storeOf([searchRow({ id: "runbook", key: "runbook", text: "durable recovery" })])
        ),
        Effect.provideService(Embedding.Embedding, queryVector),
        Effect.provide(TestClock.layer())
      )
    )

    expect(rows).toEqual([
      { bank: "flow-bank", key: "runbook", text: "durable recovery", score: 1, updatedAtMs: 0 }
    ])
  })
})
