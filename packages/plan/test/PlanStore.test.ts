import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import * as Plan from "../src/Plan.ts"
import * as PlanStore from "../src/PlanStore.ts"
import { withCrypto } from "./Crypto.ts"
import { compile, draft } from "./Plan.test.ts"

const stores = Layer.provideMerge(PlanStore.layer, Layer.provideMerge(Migrations.layer, TestDatabase.layer))

const withStore = <A, E>(
  use: (store: PlanStore.Service) => Effect.Effect<A, E, SqlClient.SqlClient>
) =>
  withCrypto(
    Effect.flatMap(PlanStore.PlanStore, use).pipe(Effect.provide(stores)) as Effect.Effect<A, E, never>
  )

/** The message SQLite's `RAISE(ABORT, ...)` carried, through the SqlError. */
const raised = (error: unknown): string =>
  (error as { readonly reason?: { readonly cause?: { readonly message?: string } } }).reason?.cause?.message ??
    String(error)

const samplePlan = () =>
  compile([
    draft("root", { writes: ["out"] }),
    draft("child", { inputs: [{ _tag: "Ref", from: "root", path: [] }] })
  ])

describe("PlanStore", () => {
  it.effect("records a plan and reads it back node for node", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const { read, recorded } = yield* withStore((store) =>
        Effect.gen(function*() {
          const recorded = yield* store.record(plan, 1)
          const read = yield* store.get(plan.planId)
          return { read, recorded }
        })
      )
      expect(recorded).toEqual({ _tag: "Recorded" })
      expect(Option.getOrThrow(read)).toEqual(plan)
    }))

  it.effect("is first-writer-wins: an identical re-record is not an error, a different one is a conflict", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const other = yield* withCrypto(compile([draft("root", { body: { seed: 9 } })]))
      const { conflict, same } = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.record(plan, 1)
          const same = yield* store.record(plan, 2)
          const conflict = yield* store.record({ ...other, planId: plan.planId }, 3)
          return { conflict, same }
        })
      )
      expect(same).toEqual({ _tag: "ExistingSame" })
      expect(conflict).toEqual({ _tag: "Conflict", digest: plan.digest })
    }))

  it.effect("appends an elaborated subgraph and advances the digest", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(samplePlan())
      const grown = yield* withCrypto(
        Plan.append(base, [draft("late", { inputs: [{ _tag: "Pending", from: "child" }] })])
      )
      const read = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.record(base, 1)
          yield* store.append(grown)
          return yield* store.get(base.planId)
        })
      )
      expect(Option.getOrThrow(read)).toEqual(grown)
    }))

  it.effect("refuses a divergent branch and rolls the attempted append back byte for byte", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("root")]))
      const planA = yield* withCrypto(Plan.append(base, [draft("a")]))
      const planB = yield* withCrypto(Plan.append(base, [draft("b")]))
      const planB2 = yield* withCrypto(Plan.append(planB, [
        draft("c", { inputs: [{ _tag: "Ref", from: "b", path: [] }] })
      ]))
      const { after, afterCount, before, beforeCount, failure } = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(base, 1)
          yield* store.append(planA)
          const before = yield* store.get(base.planId)
          const beforeRows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_plan_nodes`
          const failure = yield* Effect.flip(store.append(planB2))
          const after = yield* store.get(base.planId)
          const afterRows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_plan_nodes`
          return {
            after,
            afterCount: afterRows[0]!.count,
            before,
            beforeCount: beforeRows[0]!.count,
            failure
          }
        })
      )

      expect(failure).toMatchObject({
        code: "constraint",
        message: `plan ${base.planId} recorded plan's nodes diverge from the plan this append was grown from`
      })
      expect(after).toEqual(before)
      expect(afterCount).toBe(beforeCount)
    }))

  it.effect("refuses a skipped generation and rolls the attempted append back byte for byte", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("a")]))
      const generation1 = yield* withCrypto(Plan.append(base, [draft("b")]))
      const generation2 = yield* withCrypto(Plan.append(generation1, [
        draft("c", { inputs: [{ _tag: "Ref", from: "b", path: [] }] })
      ]))
      const { after, before, failure } = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.record(base, 1)
          const before = yield* store.get(base.planId)
          const failure = yield* Effect.flip(store.append(generation2))
          const after = yield* store.get(base.planId)
          return { after, before, failure }
        })
      )

      expect(failure).toMatchObject({
        code: "constraint",
        message: `plan ${base.planId} was never recorded, or generation 2 was skipped or moved under the append`
      })
      expect(after).toEqual(before)
    }))

  it.effect("stores successive append ordinals contiguously in plan order", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("a"), draft("b")]))
      const generation1 = yield* withCrypto(Plan.append(base, [draft("c"), draft("d")]))
      const generation2 = yield* withCrypto(Plan.append(generation1, [
        draft("e", { inputs: [{ _tag: "Pending", from: "d" }] })
      ]))
      const rows = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.record(base, 1)
          yield* store.append(generation1)
          yield* store.append(generation2)
          const sql = yield* SqlClient.SqlClient
          return yield* sql<{ node_id: string; ordinal: number }>`
            SELECT node_id, ordinal FROM flows_plan_nodes
            WHERE plan_id = ${base.planId}
            ORDER BY ordinal
          `
        })
      )

      expect(rows).toEqual(generation2.nodes.map((node, ordinal) => ({ node_id: node.id, ordinal })))
    }))

  it.effect("returns none for a plan that was never recorded", () =>
    Effect.gen(function*() {
      expect(yield* withStore((store) => store.get("absent"))).toEqual(Option.none())
    }))

  it.effect("refuses to append to a plan that was never recorded, and leaves no orphan rows", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(samplePlan())
      const grown = yield* withCrypto(
        Plan.append(base, [draft("late", { inputs: [{ _tag: "Pending", from: "child" }] })])
      )
      const { failure, orphans } = yield* withStore((store) =>
        Effect.gen(function*() {
          // The UPDATE matches nothing while the node inserts succeed, so
          // without the check this wrote a generation of a plan that does not
          // exist — and the append-only triggers mean those rows could never be
          // taken back out again.
          const failure = yield* Effect.flip(store.append(grown))
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql<{ n: number }>`SELECT count(*) AS n FROM flows_plan_nodes`
          return { failure, orphans: rows[0]!.n }
        })
      )
      expect(failure).toMatchObject({
        code: "constraint",
        message: `plan ${base.planId} was never recorded, or generation 1 was skipped or moved under the append`
      })
      expect(orphans).toBe(0)
    }))

  it.effect("refuses every non-generation-zero record shape with an exact invalid_plan error", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("root")]))
      const grown = yield* withCrypto(Plan.append(base, [draft("late")]))
      const other = yield* withCrypto(compile([draft("other")], "other-plan"))
      const wrongBase: Plan.Plan = { ...base, baseDigest: other.digest }
      const wrongNode: Plan.Plan = {
        ...base,
        nodes: [{ ...base.nodes[0]!, generation: 1 }]
      }
      const [grownFailure, baseFailure, nodeFailure] = yield* withStore((store) =>
        Effect.all([
          Effect.flip(store.record(grown, 1)),
          Effect.flip(store.record(wrongBase, 1)),
          Effect.flip(store.record(wrongNode, 1))
        ], { concurrency: 1 })
      )

      expect(grownFailure).toMatchObject({
        code: "invalid_plan",
        message: `plan ${base.planId} has generation 1; record requires generation 0`
      })
      expect(baseFailure).toMatchObject({
        code: "invalid_plan",
        message: `plan ${base.planId} has base digest ${other.digest}, but generation 0 digest is ${base.digest}`
      })
      expect(nodeFailure).toMatchObject({
        code: "invalid_plan",
        message: `plan ${base.planId} node root has generation 1; record requires node generation 0`
      })
    }))

  it.effect("refuses an append whose newest generation has no nodes", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(compile([draft("root")]))
      const empty: Plan.Plan = { ...base, generation: 1 }
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.record(base, 1)
          return yield* Effect.flip(store.append(empty))
        })
      )

      expect(failure).toMatchObject({
        code: "invalid_plan",
        message: `plan ${base.planId} generation 1 has no nodes to append`
      })
    }))

  it.effect("refuses a value that is not a plan", () =>
    Effect.gen(function*() {
      const failure = yield* withStore((store) =>
        Effect.flip(
          store.record(
            { planId: "", flow: "f", generation: 0, baseDigest: "x", digest: "x", nodes: [] } as unknown as Plan.Plan,
            1
          )
        )
      )
      expect(failure).toMatchObject({ code: "invalid_plan" })
    }))

  it.effect("refuses an append that re-inserts a node id the plan already holds", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const forged: Plan.Plan = {
        ...plan,
        generation: 1,
        nodes: [...plan.nodes, { ...plan.nodes[0]!, generation: 1 }]
      }
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.record(plan, 1)
          // `Plan.append` refuses this in memory; the primary key refuses it in
          // the database, so a caller that bypasses the compiler cannot rewrite
          // history either.
          return yield* Effect.flip(store.append(forged))
        })
      )
      expect(failure).toMatchObject({ code: "constraint" })
    }))

  it.effect("raises when a recorded node row is rewritten or deleted", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const failures = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(plan, 1)
          const update = yield* Effect.flip(sql`UPDATE flows_plan_nodes SET kind = 'agent'`)
          const remove = yield* Effect.flip(sql`DELETE FROM flows_plan_nodes`)
          const edge = yield* Effect.flip(sql`UPDATE flows_plan_edges SET to_node = 'x'`)
          const edgeDelete = yield* Effect.flip(sql`DELETE FROM flows_plan_edges`)
          const backwards = yield* Effect.flip(sql`UPDATE flows_plans SET generation = 0`)
          return [update, remove, edge, edgeDelete, backwards].map(raised)
        })
      )
      expect(failures.filter((message) => message.includes("append-only")).length).toBe(4)
      expect(failures[4]).toBe("a plan only grows")
    }))

  it.effect("refuses deleting a recorded plan row", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(plan, 1)
          return yield* Effect.flip(sql`DELETE FROM flows_plans WHERE plan_id = ${plan.planId}`)
        })
      )

      expect(raised(failure)).toBe("flows_plans is append-only")
    }))

  it.effect("refuses rewriting a recorded plan's flow or creation time", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const [flow, createdAt] = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(plan, 1)
          const flow = yield* Effect.flip(
            sql`UPDATE flows_plans SET flow = 'other/Flow' WHERE plan_id = ${plan.planId}`
          )
          const createdAt = yield* Effect.flip(
            sql`UPDATE flows_plans SET created_at_ms = 2 WHERE plan_id = ${plan.planId}`
          )
          return [flow, createdAt] as const
        })
      )

      expect(raised(flow)).toBe("a plan only grows")
      expect(raised(createdAt)).toBe("a plan only grows")
    }))

  it.effect("refuses two nodes with the same plan ordinal", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(plan, 1)
          return yield* Effect.flip(sql`
            INSERT INTO flows_plan_nodes (
              plan_id, node_id, generation, ordinal, kind, key_digest, node_json
            )
            SELECT plan_id, 'duplicate-ordinal', generation, ordinal, kind, key_digest, node_json
            FROM flows_plan_nodes
            WHERE plan_id = ${plan.planId} AND node_id = 'root'
          `)
        })
      )

      expect(raised(failure)).toBe(
        "UNIQUE constraint failed: flows_plan_nodes.plan_id, flows_plan_nodes.ordinal"
      )
    }))

  it.effect("reports an undecodable node row rather than returning a broken plan", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* store.record(plan, 1)
          yield* sql`DROP TRIGGER flows_plan_nodes_append_only`
          yield* sql`UPDATE flows_plan_nodes SET node_json = '{"id":"broken"}'`
          return yield* Effect.flip(store.get(plan.planId))
        })
      )
      expect(failure).toMatchObject({ code: "decode_failed", message: expect.stringContaining("flows_plan_nodes") })
    }))

  it.effect("refuses a node the encoder cannot serialize", () =>
    Effect.gen(function*() {
      const plan = yield* withCrypto(samplePlan())
      const forged: Plan.Plan = {
        ...plan,
        nodes: [{ ...plan.nodes[0]!, material: { ...plan.nodes[0]!.material, body: 1n } }]
      }
      const failure = yield* withStore((store) => Effect.flip(store.record(forged, 1)))
      expect(failure).toMatchObject({ code: "invalid_plan" })
    }))

  it.effect("maps a missing table to a persistence failure", () =>
    Effect.gen(function*() {
      const failure = yield* withStore((store) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* sql`DROP TABLE flows_plans`
          return yield* Effect.flip(store.get("anything"))
        })
      )
      expect(failure).toMatchObject({ code: "persistence_failed" })
    }))
})
