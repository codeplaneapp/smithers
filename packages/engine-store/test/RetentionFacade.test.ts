/**
 * `Retention.collect`, the host-facing pass `smithers gc` runs over one file.
 *
 * The operation itself — the bounded pass over the engine ladder inside one
 * `journal.transact` — is pinned in `Retention.test.ts`. What is pinned here
 * is the facade `gc` calls: a terminal run older than the threshold goes with
 * every row that names it, a live run stays, a run a live run stands above or
 * below stays over BOTH lineage relations, a table this database does not have
 * is skipped, and a dry run reports without writing.
 *
 * The requirement is rc-contract section 5.1, Retention.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import * as Retention from "../src/Retention.ts"

const migrated = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(Migrations.layer), Effect.provide(TestDatabase.layer))

const insertRun = (
  runId: string,
  status: string,
  finishedAtMs: number | null,
  parentRunId?: string
) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const owner = status === "running"
      ? { owner_host_id: "host", owner_pid: 1, owner_nonce: "nonce", heartbeat_at_ms: 1 }
      : { owner_host_id: null, owner_pid: null, owner_nonce: null, heartbeat_at_ms: null }
    yield* sql`INSERT INTO flows_runs ${
      sql.insert({
        run_id: runId,
        status,
        created_at_ms: 1,
        started_at_ms: 1,
        finished_at_ms: finishedAtMs,
        ...owner,
        parent_run_id: parentRunId ?? null,
        state_json: "{}"
      })
    }`
  })

const insertEdge = (childId: string, parentId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE IF NOT EXISTS flows_run_parents (
      child_id TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      PRIMARY KEY (child_id, parent_id)
    )`
    yield* sql`INSERT INTO flows_run_parents ${sql.insert({ child_id: childId, parent_id: parentId })}`
  })

const insertAttempt = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO flows_attempts ${
      sql.insert({
        run_id: runId,
        step_key_digest: `digest-${runId}`,
        attempt: 0,
        state: "completed",
        started_at_ms: 1,
        meta_json: "{}"
      })
    }`
  })

const insertEvent = (runId: string, seq: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO flows_journal_events ${
      sql.insert({
        run_id: runId,
        seq,
        event_id: `${runId}-${seq}`,
        source_id: "source",
        source_seq: seq,
        emitted_at_ms: 1,
        event_type: "run.started",
        payload_json: "{}",
        meta_json: "{}"
      })
    }`
  })

const count = (table: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly total: number }>`SELECT COUNT(*) AS total FROM ${sql.literal(table)}`
    return rows[0]?.total ?? 0
  })

describe("Retention.collect", () => {
  it.effect("deletes a terminal run older than the threshold with every row that names it", () =>
    migrated(Effect.gen(function*() {
      yield* insertRun("old", "completed", 100)
      yield* insertAttempt("old")
      yield* insertEvent("old", 0)
      yield* insertRun("recent", "completed", 900)
      yield* insertAttempt("recent")

      const report = yield* Retention.collect({ olderThanMs: 500, database: ".flows/engine.db" })

      expect(report.runs).toEqual(["old"])
      expect(report.dryRun).toBe(false)
      expect(report.database).toBe(".flows/engine.db")
      expect(report.deleted["flows_runs"]).toBe(1)
      expect(report.deleted["flows_attempts"]).toBe(1)
      expect(report.deleted["flows_journal_events"]).toBe(1)
      expect(yield* count("flows_runs")).toBe(1)
      expect(yield* count("flows_attempts")).toBe(1)
      expect(yield* count("flows_journal_events")).toBe(0)
    })))

  it.effect("keeps a run that has not finished, whatever its age", () =>
    migrated(Effect.gen(function*() {
      yield* insertRun("live", "running", null)
      yield* insertRun("waiting", "suspended", null)

      const report = yield* Retention.collect({ olderThanMs: Number.MAX_SAFE_INTEGER })

      expect(report.runs).toEqual([])
      expect(report.deleted).toEqual({})
      expect(yield* count("flows_runs")).toBe(2)
    })))

  it.effect("keeps a terminal parent whose descendant is still running", () =>
    migrated(Effect.gen(function*() {
      yield* insertRun("parent", "completed", 100)
      yield* insertRun("child", "running", null, "parent")

      const report = yield* Retention.collect({ olderThanMs: 500 })

      expect(report.runs).toEqual([])
      expect(yield* count("flows_runs")).toBe(2)
    })))

  it.effect("keeps a terminal parent whose spawned child is still running", () =>
    migrated(Effect.gen(function*() {
      // A spawned child records its parent as a `flows_run_parents` edge and
      // leaves `parent_run_id` NULL. A guard that walked only the column read
      // this pair as unrelated and collected the parent out from under a live
      // child; the facade walks both relations.
      yield* insertRun("spawner", "completed", 100)
      yield* insertRun("spawned", "running", null)
      yield* insertEdge("spawned", "spawner")

      const report = yield* Retention.collect({ olderThanMs: 500 })

      expect(report.runs).toEqual([])
      expect(yield* count("flows_runs")).toBe(2)
    })))

  it.effect("keeps a settled child a parked parent can still await", () =>
    migrated(Effect.gen(function*() {
      // Upward: `agent/await` answers out of the child's run row, and a parent
      // parked on an approval can be parked for longer than the threshold
      // before it ever asks.
      yield* insertRun("parked", "suspended", null)
      yield* insertRun("settled", "completed", 100)
      yield* insertEdge("settled", "parked")

      const report = yield* Retention.collect({ olderThanMs: 500 })

      expect(report.runs).toEqual([])
      expect(yield* count("flows_runs")).toBe(2)
    })))

  it.effect("collects a terminal parent once its descendant is terminal too", () =>
    migrated(Effect.gen(function*() {
      yield* insertRun("parent", "completed", 100)
      yield* insertRun("child", "cancelled", 200, "parent")

      const report = yield* Retention.collect({ olderThanMs: 500 })

      expect([...report.runs].sort()).toEqual(["child", "parent"])
      expect(yield* count("flows_runs")).toBe(0)
    })))

  it.effect("falls back to the creation time when a terminal run recorded no finish", () =>
    migrated(Effect.gen(function*() {
      yield* insertRun("unfinished", "failed", null)

      expect((yield* Retention.collect({ olderThanMs: 2 })).runs).toEqual(["unfinished"])
    })))

  it.effect("reports without writing under a dry run", () =>
    migrated(Effect.gen(function*() {
      yield* insertRun("old", "completed", 100)
      yield* insertAttempt("old")

      const report = yield* Retention.collect({ olderThanMs: 500, dryRun: true })

      expect(report.runs).toEqual(["old"])
      expect(report.dryRun).toBe(true)
      expect(report.deleted).toEqual({})
      expect(yield* count("flows_runs")).toBe(1)
      expect(yield* count("flows_attempts")).toBe(1)
    })))

  it.effect("skips a table this database does not have", () =>
    migrated(Effect.gen(function*() {
      yield* insertRun("old", "completed", 100)

      // The time-travel and control tables are migrated by other packages and
      // are absent here; a host that composed only the engine stores must
      // still get a complete sweep of the ones it has.
      const report = yield* Retention.collect({ olderThanMs: 500 })

      expect(report.deleted["flows_time_travel_archive"]).toBeUndefined()
      expect(report.deleted["control_run_messages"]).toBeUndefined()
      expect(report.deleted["flows_runs"]).toBe(1)
    })))

  it.effect("deletes more runs than one statement may bind at once", () =>
    migrated(Effect.gen(function*() {
      yield* Effect.forEach(
        Array.from({ length: 501 }, (_, index) => `run-${index}`),
        (runId) => insertRun(runId, "completed", 100),
        { discard: true }
      )

      const report = yield* Retention.collect({ olderThanMs: 500 })

      expect(report.runs).toHaveLength(501)
      expect(report.deleted["flows_runs"]).toBe(501)
      expect(yield* count("flows_runs")).toBe(0)
    })))

  it.effect("reports nothing on a database with no run table at all", () =>
    Effect.gen(function*() {
      const report = yield* Retention.collect({ olderThanMs: 500 }).pipe(Effect.provide(TestDatabase.layer))

      expect(report.runs).toEqual([])
      expect(report.deleted).toEqual({})
    }))

  it("names the terminal statuses the contract lists", () => {
    expect(Retention.terminalStatuses).toEqual(["completed", "failed", "cancelled"])
    expect(Retention.runScopedTables.map(([table]) => table)).toContain("flows_time_travel_archive")
  })

  it("re-exports the operation rather than owning a second one", () => {
    expect(Retention.defaultLimit).toBe(1000)
    expect(typeof Retention.make).toBe("function")
    expect(Retention.Retention.key).toBe("@smthrs/engine-store/Retention")
  })
})
