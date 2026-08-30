import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Jj from "@smthrs/jj"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import { Effect } from "effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Memory from "../src/MemoryTimeTravelStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import * as TimeTravel from "../src/TimeTravel.ts"

describe("fork", () => {
  it.effect("creates unique immutable prefix copies", () =>
    Effect.gen(function*() {
      const store = Memory.make({
        records: [
          { runId: "r", seq: 0, eventId: "a", lineageId: "r", payload: null },
          { runId: "r", seq: 2, eventId: "b", lineageId: "r", payload: null }
        ]
      })
      const before = store.state().records
      const first = yield* (store.createFork("r", { lineageId: "r", seq: 0 }))
      const second = yield* (store.createFork("r", { lineageId: "r", seq: 0 }))

      expect(first.runId).not.toBe(second.runId)
      expect(store.state().records.filter((record) => record.runId === first.runId)).toHaveLength(1)
      expect(store.state().records.filter((record) => record.runId === second.runId)).toHaveLength(1)
      expect(store.state().records.filter((record) => record.runId === "r")).toEqual(before)
    }))

  // The in-memory store advances a private counter instead of counting
  // committed edges, so it hands out a fresh id per mint. The store interface
  // documents that difference; this is what holds it to it.
  it.effect("mints a fresh child id on every call, committed or not", () =>
    Effect.gen(function*() {
      const store = Memory.make({
        records: [{ runId: "r", seq: 0, eventId: "a", lineageId: "r", payload: null }]
      })

      const first = yield* store.nextForkId("r", { lineageId: "r", seq: 0 })
      const second = yield* store.nextForkId("r", { lineageId: "r", seq: 0 })

      expect(first).not.toBe(second)
      expect(store.state().records.filter((record) => record.runId !== "r")).toEqual([])
    }))

  it.effect("copies the frame's anchors to the child, and only those", () =>
    Effect.gen(function*() {
      const store = Memory.make({
        records: [{ runId: "r", seq: 0, eventId: "a", lineageId: "r", payload: null }],
        snapshots: [
          { runId: "r", frame: { lineageId: "r", seq: 0 }, changeId: "change-0" },
          { runId: "r", frame: { lineageId: "r", seq: 2 }, changeId: "change-2" }
        ]
      })

      const fork = yield* (store.createFork("r", { lineageId: "r", seq: 0 }))

      // The anchor above the frame stays the parent's alone: the child's
      // copied prefix has no record that could explain it.
      expect(store.state().snapshots.filter((snapshot) => snapshot.runId === fork.runId)).toEqual([
        { runId: fork.runId, frame: { lineageId: "r", seq: 0 }, changeId: "change-0" }
      ])
    }))

  it.effect("refuses a fork when any ancestor is live", () =>
    Effect.gen(function*() {
      const store = Memory.make({
        records: [{ runId: "child", seq: 0, eventId: "child-0", lineageId: "child", payload: null }],
        edges: [
          { parentRunId: "root", parentSeq: 0, childRunId: "middle", kind: "child", attached: true },
          { parentRunId: "middle", parentSeq: 0, childRunId: "child", kind: "child", attached: true }
        ],
        liveRuns: new Set(["root"])
      })

      const failure = yield* (
        Effect.flip(store.createFork("child", { lineageId: "child", seq: 0 }))
      )
      expect(failure.code).toBe("live_parent")
    }))
})

/**
 * A fork's workspace is an identity, not a label.
 *
 * `docs/specs/Concepts/Time Travel.md` §Fork gives every child its own jj
 * workspace, and the store gives every child its own run id. These cases hold
 * the two identities to each other over the REAL SQLite store: the name the
 * lane is provisioned under must distinguish exactly the children the store
 * distinguishes, so a second fork of one frame cannot land in the first
 * child's lane and two parents that sanitize to the same characters cannot
 * share one.
 */
describe("fork workspace identity", () => {
  const frame = { lineageId: "main", seq: 0 } as const

  const insertParent = (sql: SqlClient.SqlClient, runId: string) =>
    sql`
      INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
      VALUES (${runId}, 'suspended', 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })})
    `

  /** The real store and journal, with jj reduced to a recorder of its lanes. */
  const runForks = <A>(
    body: (
      timeTravel: TimeTravel.Service,
      sql: SqlClient.SqlClient
    ) => Effect.Effect<A, unknown, never>
  ) =>
    Effect.gen(function*() {
      const lanes: Array<{ readonly name: string; readonly path: string }> = []
      const jj = Layer.succeed(
        Jj.Jj,
        Jj.makeNoop({
          workspaceAdd: (name, path) => Effect.sync(() => void lanes.push({ name, path })),
          workspaceForget: () => Effect.void
        })
      )
      const migrated = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
      const persistence = Layer.mergeAll(
        SqlJournal.layer({ capacity: 64, overflow: "reject" }),
        RunStore.layer,
        CacheStore.layer,
        SqlTimeTravelStore.layer,
        jj
      ).pipe(Layer.provideMerge(migrated))
      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const timeTravel = yield* TimeTravel.TimeTravel
          return yield* body(timeTravel, sql)
        }).pipe(Effect.provide(TimeTravel.TimeTravel.layer.pipe(Layer.provideMerge(persistence))))
      )
      return { lanes, result }
    })

  it.effect("gives a second fork of one frame its own workspace", () =>
    Effect.gen(function*() {
      const { lanes, result } = yield* runForks((timeTravel, sql) =>
        Effect.gen(function*() {
          yield* insertParent(sql, "parent")
          const first = yield* timeTravel.fork({ runId: "parent", frame })
          const second = yield* timeTravel.fork({ runId: "parent", frame })
          return { first, second }
        })
      )

      expect(result.first.runId).not.toBe(result.second.runId)
      expect(lanes).toHaveLength(2)
      expect(lanes[0]!.name).not.toBe(lanes[1]!.name)
      expect(lanes[0]!.path).not.toBe(lanes[1]!.path)
    }))

  it.effect("names the lane after the child run, under the operator-visible smithers prefix", () =>
    Effect.gen(function*() {
      const { lanes } = yield* runForks((timeTravel, sql) =>
        Effect.gen(function*() {
          yield* insertParent(sql, "parent")
          return yield* timeTravel.fork({ runId: "parent", frame })
        })
      )

      // `jj workspace list` shows this name to an operator, so the product
      // name owns the prefix. The rest is the child run id, sanitized, and
      // the digest that restores what sanitizing folded away.
      expect(lanes[0]!.name).toMatch(/^smithers-fork-parent-fork-0-1-[0-9a-f]{8}$/)
    }))

  it.effect("gives run ids that differ only in a sanitized character distinct workspaces", () =>
    Effect.gen(function*() {
      const { lanes, result } = yield* runForks((timeTravel, sql) =>
        Effect.gen(function*() {
          yield* insertParent(sql, "demo/a")
          yield* insertParent(sql, "demo:a")
          const slashed = yield* timeTravel.fork({ runId: "demo/a", frame })
          const colonned = yield* timeTravel.fork({ runId: "demo:a", frame })
          return { colonned, slashed }
        })
      )

      expect(result.slashed.runId).not.toBe(result.colonned.runId)
      expect(lanes).toHaveLength(2)
      expect(lanes[0]!.name).not.toBe(lanes[1]!.name)
      expect(lanes[0]!.path).not.toBe(lanes[1]!.path)
    }))
})
