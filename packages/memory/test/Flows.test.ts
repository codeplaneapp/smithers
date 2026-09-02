import * as Effects from "@smthrs/core/Effects"
import * as Flow from "@smthrs/core/Flow"
import * as Graph from "@smthrs/core/Graph"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Flows from "../src/Flows.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Recall from "../src/Recall.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

describe("Flows", () => {
  it("declares remember and recall as unsealed flows without bodies", () => {
    expect(Flows.remember.name).toBe("remember")
    expect(Flows.recall.name).toBe("recall")
    expect(Flows.remember.body).toBeUndefined()
    expect(Flows.recall.body).toBeUndefined()
    expect(Flows.remember.effects?.tier).not.toBe("sealed")
    expect(Flows.recall.effects?.tier).toBe("sealed")
  })

  it("narrows recall inside a default-tier envelope and builds a sealed caller without diagnostics", () => {
    const envelope = Effects.make({ reads: ["memory/**"], writes: [] })
    expect(Effects.narrow(envelope, Flows.recallEffects)).toEqual({ ok: true })

    const sealed = Flow.make({
      input: Flows.RecallInput,
      output: Flows.RecallOutput,
      effects: envelope,
      body: (input) => Flows.recall(input)
    })
    const diagnostics = Graph.diagnostics(Graph.build(sealed({ banks: ["bank"], query: "q" })))
    expect(diagnostics.filter((diagnostic) => diagnostic.code === "effect_tier_widening")).toEqual([])
  })

  it("exposes a bindable recall slot and concrete runtime handlers", () => {
    const binding = Flow.make({
      input: Flows.RecallInput,
      output: Flows.RecallOutput
    })
    expect(Flows.bindRecall(binding)).toBe(binding)
    expect(Flows.handlers).toMatchObject({
      remember: expect.any(Function),
      recall: expect.any(Function)
    })
  })

  it("persists a remembered fact in the bank's namespace, with and without tags", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const tagged = yield* Flows.handlers.remember({
          bank: "global-history",
          key: "release",
          text: "cut 0.1.0",
          tags: ["scope:project"]
        })
        const untagged = yield* Flows.runRemember({ bank: "project", key: "plain", text: "no tags" })
        const prefixed = yield* store.getFact({ namespace: { kind: "global", id: "history" }, key: "release" })
        const local = yield* store.getFact({ namespace: { kind: "flow", id: "project" }, key: "plain" })
        return { tagged, untagged, prefixed, local }
      }).pipe(Effect.provide(TestMemory.layer))
    )

    expect(result.tagged).toEqual({ key: "release" })
    expect(result.untagged).toEqual({ key: "plain" })
    expect(result.prefixed?.value).toEqual({ content: "cut 0.1.0" })
    expect(result.prefixed?.tags).toEqual(["scope:project"])
    expect(result.local?.value).toEqual({ content: "no tags" })
    expect(result.local?.tags).toEqual([])
  })

  it("decodes the remember tag vocabulary, uniqueness, and 16-tag boundary", () => {
    const decode = Schema.decodeUnknownSync(Flows.RememberInput)
    const input = { bank: "bank", key: "key", text: "text" }
    expect(decode({ ...input, tags: Array.from({ length: 16 }, (_, index) => `scope:${index}`) }).tags)
      .toHaveLength(16)
    for (const tags of [["vendor:value"], ["scope:"], ["scope:same", "scope:same"]]) {
      expect(() => decode({ ...input, tags })).toThrow()
    }
    expect(() => decode({ ...input, tags: Array.from({ length: 17 }, (_, index) => `scope:${index}`) })).toThrow()
  })

  it("rejects an out-of-vocabulary remember tag with the same typed error as putNote", async () => {
    const failures = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const tags = ["vendor:value"] as never
        return yield* Effect.all([
          Effect.flip(Flows.runRemember({ bank: "bank", key: "fact", text: "text", tags })),
          Effect.flip(store.putNote({
            namespace: { kind: "flow", id: "bank" },
            id: "note",
            text: "text",
            tags,
            provenance: {}
          }))
        ])
      }).pipe(Effect.provide(TestMemory.layer))
    )
    expect(failures.map((failure) => failure.code)).toEqual(["invalid_tag", "invalid_tag"])
  })

  it("passes remember TTL and supplied provenance into the durable fact row", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* Flows.runRemember(
          { bank: "bank", key: "expiring", text: "text", ttlMs: 10 },
          { runId: "run-1", nodeId: "node-1", iteration: 2 }
        )
        const current = yield* store.getFact({ namespace: "bank", key: "expiring" })
        const persisted = yield* sql<{ readonly provenance_json: string }>`SELECT provenance_json
          FROM memory_facts WHERE namespace_kind = 'flow' AND namespace_id = 'bank' AND fact_key = 'expiring'`
        yield* TestClock.adjust("10 millis")
        const expired = yield* store.getFact({ namespace: "bank", key: "expiring" })
        return { current, expired, provenanceJson: persisted[0]?.provenance_json }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase), Effect.provide(TestClock.layer()))
    )
    expect(result.current?.ttlMs).toBe(10)
    expect(JSON.parse(result.provenanceJson ?? "null")).toEqual({ runId: "run-1", nodeId: "node-1", iteration: 2 })
    expect(result.expired).toBeUndefined()
  })

  it("delegates the recall handler to the installed recall service", async () => {
    const rows = await Effect.runPromise(
      Flows.handlers.recall({ banks: ["flow-one", "flow-two"], query: "durable" }).pipe(
        Effect.provide(Recall.layer({
          recall: (input) =>
            Effect.succeed(input.banks.map((bank) => ({ bank, key: input.query, text: "row", score: 1 })))
        }))
      )
    )

    expect(rows).toEqual([
      { bank: "flow-one", key: "durable", text: "row", score: 1 },
      { bank: "flow-two", key: "durable", text: "row", score: 1 }
    ])
  })
})
