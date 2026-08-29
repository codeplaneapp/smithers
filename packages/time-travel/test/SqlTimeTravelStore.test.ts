import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Migrations from "@smthrs/engine-store/Migrations"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"

const owner = { hostId: "host-a", pid: 1234, nonce: "nonce" } as const

describe("SqlTimeTravelStore", () => {
  it.effect("archives and truncates attached descendants in one database write", () =>
    Effect.gen(function*() {
      const result = yield* (
        Effect.gen(function*() {
          yield* Migrations.run
          const sql = yield* Effect.service(SqlClient.SqlClient)

          const store = yield* SqlTimeTravelStore.make
          for (const runId of ["parent", "child", "grandchild", "detached"]) {
            yield* sql`
            INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
            VALUES (${runId}, 'suspended', 0, '{}')
          `
          }
          // The truncation is owner-fenced: the archive only commits while
          // `flows_runs` records this owner for the run. The run table's
          // CHECK keeps owner columns on `running` rows only.
          yield* sql`
          UPDATE flows_runs
          SET status = 'running',
            owner_host_id = ${owner.hostId}, owner_pid = ${owner.pid}, owner_nonce = ${owner.nonce},
            heartbeat_at_ms = 0
          WHERE run_id = 'parent'
        `
          const journalRows = [
            { runId: "parent", seq: 0 },
            { runId: "parent", seq: 2 },
            { runId: "child", seq: 0 },
            { runId: "grandchild", seq: 0 },
            { runId: "detached", seq: 0 }
          ] as const
          for (const row of journalRows) {
            yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json)
            VALUES (
              ${row.runId},
              ${row.seq},
              ${`${row.runId}-${row.seq}`},
              ${`source-${row.runId}`},
              ${row.seq},
              0,
              'test',
              '{}',
              '{}'
            )
          `
          }
          yield* sql`
          INSERT INTO flows_time_travel_edges
            (parent_run_id, parent_seq, child_run_id, kind, attached)
          VALUES ('parent', 2, 'child', 'child', 1)
        `
          yield* sql`
          INSERT INTO flows_time_travel_edges
            (parent_run_id, parent_seq, child_run_id, kind, attached)
          VALUES ('child', 0, 'grandchild', 'continuation', 1)
        `
          yield* sql`
          INSERT INTO flows_time_travel_edges
            (parent_run_id, parent_seq, child_run_id, kind, attached)
          VALUES ('parent', 2, 'detached', 'child', 0)
        `

          const archive = yield* store.archiveAndTruncate(
            "parent",
            { lineageId: "parent/root", seq: 0 },
            [],
            owner
          )
          const remaining = yield* sql<{ readonly run_id: string; readonly seq: number }>`
          SELECT run_id, seq FROM flows_journal_events ORDER BY run_id, seq
        `
          const archived = yield* sql<{ readonly run_id: string; readonly seq: number }>`
          SELECT run_id, seq FROM flows_time_travel_archive ORDER BY run_id, seq
        `
          const edges = yield* sql<{ readonly child_run_id: string }>`
          SELECT child_run_id FROM flows_time_travel_edges ORDER BY child_run_id
        `
          return { archive, remaining, archived, edges }
        }).pipe(Effect.provide(TestDatabase.layer))
      )

      expect(result.archive.archived).toBe(3)
      expect(result.archive.orphaned.map((edge) => edge.childRunId)).toEqual(["detached"])
      expect(result.remaining).toEqual([
        { run_id: "detached", seq: 0 },
        { run_id: "parent", seq: 0 }
      ])
      expect(result.archived).toEqual([
        { run_id: "child", seq: 0 },
        { run_id: "grandchild", seq: 0 },
        { run_id: "parent", seq: 2 }
      ])
      expect(result.edges).toEqual([{ child_run_id: "detached" }])
    }))

  it.effect("rejects archiveAndTruncate from a superseded owner with fence_lost and truncates nothing", () =>
    Effect.gen(function*() {
      const result = yield* (
        Effect.gen(function*() {
          yield* Migrations.run
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const store = yield* SqlTimeTravelStore.make
          yield* sql`
          INSERT INTO flows_runs
            (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
          VALUES ('parent', 'running', 0, '{}',
                  ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0)
        `
          yield* sql`
          INSERT INTO flows_journal_events
            (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
             event_type, payload_json, meta_json)
          VALUES ('parent', 2, 'parent-2', 'source-parent', 2, 0, 'test', '{}', '{}')
        `
          // A live successor takes the run before the superseded rewinder's
          // archive commits.
          yield* sql`
          UPDATE flows_runs
          SET owner_host_id = 'host-b', owner_pid = 4321, owner_nonce = 'nonce-b'
          WHERE run_id = 'parent'
        `
          const failure = yield* Effect.flip(
            store.archiveAndTruncate("parent", { lineageId: "parent/root", seq: 0 }, [], owner)
          )
          const remaining = yield* sql<{ readonly seq: number }>`
          SELECT seq FROM flows_journal_events WHERE run_id = 'parent'
        `
          const archived = yield* sql<{ readonly seq: number }>`
          SELECT seq FROM flows_time_travel_archive WHERE run_id = 'parent'
        `
          return { failure, remaining, archived }
        }).pipe(Effect.provide(TestDatabase.layer))
      )

      expect(result.failure).toMatchObject({ code: "fence_lost" })
      expect(result.remaining).toEqual([{ seq: 2 }])
      expect(result.archived).toEqual([])
    }))
})
