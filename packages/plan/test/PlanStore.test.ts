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
      expect(failure).toMatchObject({ code: "constraint" })
      expect(orphans).toBe(0)
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
      expect(failures[4]).toContain("a plan only grows")
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
