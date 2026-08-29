import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"

interface SqliteMasterRow {
  readonly name: string
  readonly sql: string | null
  readonly type: "index" | "table"
}

interface TableInfoRow {
  readonly name: string
}

const run = <A, E>(effect: Effect.Effect<A, E, never>) => effect

const migrated = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  run(effect.pipe(Effect.provide(Migrations.layer), Effect.provide(TestDatabase.layer)))

describe("durable engine migrations", () => {
  it.effect("migrates a fresh database and reruns idempotently", () =>
    Effect.gen(function*() {
      yield* migrated(Effect.gen(function*() {
        yield* Migrations.run
        yield* Migrations.run
      }))
    }))

  it.effect("creates the expected schema without interpreter columns", () =>
    Effect.gen(function*() {
      const schema = yield* migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const master = yield* sql<
          SqliteMasterRow
        >`SELECT name, type, sql FROM sqlite_master WHERE name LIKE 'flows_%'`
        const tables = Object.fromEntries(
          yield* Effect.forEach(
            master.filter((row) => row.type === "table"),
            (row) =>
              Effect.map(
                sql<TableInfoRow>`PRAGMA table_info(${sql.literal(row.name)})`,
                (columns) => [row.name, columns.map((column) => column.name).sort()] as const
              )
          )
        )
        return { master, tables }
      }))

      expect(schema.master.filter((row) => row.type === "table").map((row) => row.name).sort()).toEqual([
        "flows_attempts",
        "flows_clock_deadlines",
        "flows_deferred_completions",
        "flows_journal_checkpoints",
        "flows_journal_events",
        "flows_migrations",
        "flows_plan_edges",
        "flows_plan_nodes",
        "flows_plans",
        "flows_runs",
        "flows_selection_suspected_edges",
        "flows_step_cache",
        "flows_step_cache_recorded"
      ])
      expect(schema.master.some((row) => row.name === "flows_journal_events_event_type_idx" && row.type === "index"))
        .toBe(true)
      expect(schema.tables).toEqual({
        flows_attempts: [
          "attempt",
          "checkpoint_json",
          "error_json",
          "finished_at_ms",
          "heartbeat_at_ms",
          "meta_json",
          "outcome_json",
          "run_id",
          "started_at_ms",
          "state",
          "step_key_digest"
        ],
        flows_clock_deadlines: [
          "clock_name",
          "completed_at_ms",
          "deferred_name",
          "due_at_ms",
          "execution_id",
          "flow_name"
        ],
        flows_deferred_completions: [
          "completed_at_ms",
          "deferred_name",
          "execution_id",
          "exit_json",
          "flow_name",
          "metadata_json"
        ],
        flows_journal_checkpoints: [
          "compacted_at_ms",
          "created_at_ms",
          "run_id",
          "seq",
          "state_json"
        ],
        flows_journal_events: [
          "emitted_at_ms",
          "event_id",
          "event_type",
          "meta_json",
          "payload_json",
          "run_id",
          "seq",
          "source_id",
          "source_seq"
        ],
        flows_migrations: ["created_at", "migration_id", "name"],
        flows_runs: [
          "cancel_requested_at_ms",
          "claim_host_id",
          "claim_nonce",
          "claim_pid",
          "claimed_at_ms",
          "created_at_ms",
          "finished_at_ms",
          "heartbeat_at_ms",
          "lineage_id",
          "owner_host_id",
          "owner_nonce",
          "owner_pid",
          "parent_run_id",
          "round_ordinal",
          "run_id",
          "started_at_ms",
          "state_json",
          "status",
          "waiting_reason",
          "waiting_token",
          "waiting_wake_at_ms"
        ],
        flows_selection_suspected_edges: [
          "affects",
          "confidence",
          "evidence_json",
          "scope",
          "valid_from_ms"
        ],
        flows_step_cache: [
          "created_at_ms",
          "key_digest",
          "meta_json",
          "recorded_event_seq",
          "recorded_run_id",
          "result_json"
        ],
        flows_step_cache_recorded: [
          "created_at_ms",
          "key_digest",
          "meta_json",
          "recorded_event_seq",
          "recorded_run_id",
          "result_json"
        ],
        flows_plans: ["base_digest", "created_at_ms", "digest", "flow", "generation", "plan_id"],
        flows_plan_nodes: ["generation", "key_digest", "kind", "node_id", "node_json", "ordinal", "plan_id"],
        flows_plan_edges: ["from_node", "plan_id", "to_node"]
      })
      expect(
        Object.values(schema.tables).flat().some((column) =>
          /agent|model|prompt|session|response|hijack|quota|resume/i.test(column)
        )
      ).toBe(false)
      const journalSql = schema.master.find((row) => row.name === "flows_journal_events")?.sql ?? ""
      const runsSql = schema.master.find((row) => row.name === "flows_runs")?.sql ?? ""
      const attemptsSql = schema.master.find((row) => row.name === "flows_attempts")?.sql ?? ""
      const cacheSql = schema.master.find((row) => row.name === "flows_step_cache")?.sql ?? ""
      const deferredsSql = schema.master.find((row) => row.name === "flows_deferred_completions")?.sql ?? ""
      const clocksSql = schema.master.find((row) => row.name === "flows_clock_deadlines")?.sql ?? ""
      expect(journalSql).toContain("PRIMARY KEY (run_id, seq)")
      expect(journalSql).toContain("UNIQUE (run_id, source_id, source_seq)")
      expect(runsSql).toContain("CHECK")
      expect(runsSql).toContain("status IN")
      expect(runsSql).toContain("status = 'running'")
      expect(runsSql).toContain("status <> 'running'")
      expect(runsSql).toContain("created_at_ms INTEGER NOT NULL")
      expect(attemptsSql).toContain("started_at_ms INTEGER NOT NULL")
      expect(attemptsSql).toContain("FOREIGN KEY (run_id) REFERENCES flows_runs (run_id)")
      expect(cacheSql).toContain("length(key_digest) > 0")
      expect(cacheSql).toContain("json_valid(result_json)")
      expect(cacheSql).toContain("json_valid(meta_json)")
      expect(cacheSql).toContain("typeof(created_at_ms) = 'integer'")
      expect(cacheSql).toContain("length(recorded_run_id) > 0")
      expect(cacheSql).toContain("typeof(recorded_event_seq) = 'integer'")
      expect(deferredsSql).toContain("completed_at_ms INTEGER NOT NULL")
      expect(deferredsSql).toContain("FOREIGN KEY (execution_id) REFERENCES flows_runs (run_id)")
      expect(clocksSql).toContain("due_at_ms INTEGER NOT NULL")
      expect(clocksSql).toContain("completed_at_ms INTEGER")
      expect(clocksSql).toContain("FOREIGN KEY (execution_id) REFERENCES flows_runs (run_id)")
      expect(deferredsSql).toContain("json_valid(exit_json)")
      expect(`${deferredsSql}${clocksSql}`).toContain("typeof(completed_at_ms) = 'integer'")
      expect(
        schema.master.some((row) => row.name === "flows_clock_deadlines_pending_idx" && row.type === "index")
      ).toBe(true)
    }))

  it.effect("rejects a half-populated owner tuple", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`INSERT INTO flows_runs (run_id, status, owner_host_id, state_json) VALUES ('run', 'running', 'host', '{}')`
      })))
      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("enforces every cache row invariant at the schema boundary", () =>
    Effect.gen(function*() {
      const outcomes = yield* migrated(Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const invalidRows = [
          "('', '{}', '{}', 0, 'run', 0)",
          "('bad-result', 'not-json', '{}', 0, 'run', 0)",
          "('bad-meta', '{}', 'not-json', 0, 'run', 0)",
          "('negative-created', '{}', '{}', -1, 'run', 0)",
          "('fractional-created', '{}', '{}', 0.5, 'run', 0)",
          "('unsafe-created', '{}', '{}', 9007199254740992, 'run', 0)",
          "('empty-run', '{}', '{}', 0, '', 0)",
          "('negative-seq', '{}', '{}', 0, 'run', -1)",
          "('fractional-seq', '{}', '{}', 0, 'run', 0.5)",
          "('unsafe-seq', '{}', '{}', 0, 'run', 9007199254740992)"
        ] as const
        return yield* Effect.forEach(invalidRows, (values) =>
          Effect.exit(sql.unsafe(
            `INSERT INTO flows_step_cache (
            key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
          ) VALUES ${values}`
          )))
      }))

      expect(outcomes.every(Exit.isFailure)).toBe(true)
    }))
})
