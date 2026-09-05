import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import * as Plan from "../src/Plan.ts"
import * as PlanStore from "../src/PlanStore.ts"
import { withCrypto } from "./Crypto.ts"
import { compile, draft } from "./PlanFixtures.ts"

const serialized = (plan: Plan.Plan): Plan.Plan => JSON.parse(JSON.stringify(plan))
const stores = PlanStore.layer.pipe(Layer.provideMerge(Migrations.layer.pipe(Layer.provideMerge(TestDatabase.layer))))
const key = `key1_${"0".repeat(64)}`

describe("plan integrity admission", () => {
  it.effect("verifies ordinary, empty, and multi-generation plans without changing identities", () =>
    withCrypto(
      Effect.gen(function*() {
        const empty = yield* compile([])
        const base = yield* compile([draft("one", { writes: ["out"] }), draft("two", { writes: ["out"] })])
        const first = yield* Plan.append(base, [draft("three", { reads: ["out"] })])
        const second = yield* Plan.append(first, [
          draft("four", { inputs: [{ _tag: "Ref", from: "three", path: [] }] })
        ])
        const fromEmpty = yield* Plan.append(empty, [draft("first", { writes: ["out"] })])
        for (const plan of [empty, base, first, second, fromEmpty]) {
          expect(yield* Plan.verify(plan)).toBe(plan)
          const copy = serialized(plan)
          const checked = yield* Plan.verify(copy)
          expect(checked).toEqual(plan)
          expect(Object.isFrozen(checked)).toBe(true)
          if (copy.nodes.length > 0) {
            Object.assign(copy.nodes[0]!.material, { body: "changed after verification" })
            expect(checked.nodes[0]!.material.body).toEqual(plan.nodes[0]!.material.body)
          }
        }
      })
    ))

  it.effect("rejects forged keys, digests, topology, effects, material and generations", () =>
    withCrypto(
      Effect.gen(function*() {
        const base = yield* compile([draft("a"), draft("b", { inputs: [{ _tag: "Ref", from: "a", path: [] }] })])
        const node = base.nodes[0]!
        const cases: ReadonlyArray<unknown> = [
          undefined,
          null,
          {},
          { nodes: [] },
          { ...base, digest: key, baseDigest: key },
          { ...base, nodes: [{ ...node, key }, base.nodes[1]!] },
          { ...base, nodes: [{ ...node, material: { ...node.material, body: "forged" } }, base.nodes[1]!] },
          {
            ...base,
            nodes: [
              { ...node, material: { ...node.material, effects: { ...node.effects, writes: ["hidden"] } } },
              base.nodes[1]!
            ]
          },
          { ...base, nodes: [{ ...node, dependsOn: ["b"] }, base.nodes[1]!] },
          { ...base, nodes: [{ ...node, effects: { ...node.effects, writes: ["new"] } }, base.nodes[1]!] },
          { ...base, nodes: [{ ...node, priority: 10 }, base.nodes[1]!] },
          { ...base, nodes: [node, node] },
          ...[-1, 1.5, 3, Number.MAX_SAFE_INTEGER + 1].map((generation) => ({ ...base, generation })),
          { ...base, generation: 1 },
          { ...base, nodes: [{ ...node, generation: -1 }] },
          { ...base, generation: 2, nodes: [{ ...node, generation: 2 }, base.nodes[1]!] },
          { ...base, generation: 1, nodes: [{ ...node, generation: 1 }, base.nodes[1]!] },
          {
            ...base,
            generation: 1,
            nodes: [{ ...node, material: { ...node.material, inputs: [{ _tag: "Ref", from: "b", path: [] }] } }, {
              ...base.nodes[1]!,
              generation: 1
            }]
          },
          {
            ...base,
            nodes: [{ ...node, material: { ...node.material, inputs: [{ _tag: "Ref", from: "missing", path: [] }] } }]
          },
          {
            ...base,
            nodes: [
              { ...node, material: { ...node.material, inputs: [{ _tag: "Ref", from: "b", path: [] }] } },
              base.nodes[1]!
            ]
          },
          { nodes: Array.from({ length: Plan.maximumPlanNodes + 1 }, () => node) }
        ]
        for (const candidate of cases) {
          const result = yield* Effect.exit(Plan.verify(candidate))
          expect(result._tag).toBe("Failure")
        }
      })
    ))

  it.effect("refuses forged store admission without writing or misreporting ExistingSame", () =>
    withCrypto(
      Effect.gen(function*() {
        const plan = yield* compile([draft("a")])
        const store = yield* PlanStore.PlanStore
        const sql = yield* SqlClient.SqlClient
        const forged = { ...plan, digest: key, baseDigest: key } as Plan.Plan
        expect((yield* Effect.flip(store.record(forged, 0))).code).toBe("invalid_plan")
        expect((yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_plans`)[0]!.count).toBe(0)
        expect((yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_plan_nodes`)[0]!.count).toBe(0)
        expect(yield* store.record(plan, 0)).toEqual({ _tag: "Recorded" })
        const changed = {
          ...plan,
          nodes: [{ ...plan.nodes[0]!, material: { ...plan.nodes[0]!.material, body: "changed" } }]
        }
        expect((yield* Effect.flip(store.record(changed, 1))).code).toBe("invalid_plan")
        expect(Option.getOrThrow(yield* store.get(plan.planId))).toEqual(plan)
      }).pipe(Effect.provide(stores))
    ))

  it.effect("detects schema-valid stored corruption on read and duplicate admission", () =>
    withCrypto(
      Effect.gen(function*() {
        const plan = yield* compile([draft("a")])
        const store = yield* PlanStore.PlanStore
        const sql = yield* SqlClient.SqlClient
        yield* store.record(plan, 0)
        yield* sql`DROP TRIGGER flows_plan_nodes_append_only`
        const json = yield* Schema.encodeEffect(Schema.fromJsonString(Plan.PlanNode))({
          ...plan.nodes[0]!,
          key: key as Plan.PlanNode["key"]
        })
        yield* sql`UPDATE flows_plan_nodes SET node_json = ${json}`
        expect((yield* Effect.flip(store.get(plan.planId))).code).toBe("decode_failed")
        expect((yield* Effect.flip(store.record(plan, 1))).code).toBe("decode_failed")
      }).pipe(Effect.provide(stores))
    ))

  it.effect("round-trips an empty plan and rolls back rejected storage metadata", () =>
    withCrypto(
      Effect.gen(function*() {
        const empty = yield* compile([])
        const store = yield* PlanStore.PlanStore
        expect((yield* Effect.flip(store.record(empty, -1))).code).toBe("constraint")
        expect(Option.isNone(yield* store.get(empty.planId))).toBe(true)
        yield* store.record(empty, 0)
        expect(Option.getOrThrow(yield* store.get(empty.planId))).toEqual(empty)
      }).pipe(Effect.provide(stores))
    ))

  it.effect("rolls back the envelope when SQL refuses a verified node", () =>
    withCrypto(
      Effect.gen(function*() {
        const plan = yield* compile([draft("a")])
        const store = yield* PlanStore.PlanStore
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TRIGGER refuse_plan_node BEFORE INSERT ON flows_plan_nodes
        BEGIN SELECT RAISE(ABORT, 'storage constraint'); END`
        const failure = yield* Effect.flip(store.record(plan, 0))
        expect(failure.code).toBe("constraint")
        expect(Option.isNone(yield* store.get(plan.planId))).toBe(true)
        expect((yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_plan_nodes`)[0]!.count).toBe(0)
      }).pipe(Effect.provide(stores))
    ))
})
