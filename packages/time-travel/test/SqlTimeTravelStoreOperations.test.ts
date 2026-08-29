import { describe, expect, it } from "@effect/vitest"
import * as DatabaseModule from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Migrations from "@smthrs/engine-store/Migrations"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Frame from "../src/Frame.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import type * as TimeTravelStore from "../src/TimeTravelStore.ts"

const run = <A>(
  body: (
    store: TimeTravelStore.Service,
    sql: SqlClient.SqlClient
  ) => Effect.Effect<A, unknown, DatabaseModule.DurableWriter | SqlClient.SqlClient>
) =>
  Effect.gen(function*() {
    yield* Migrations.run
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const store = yield* SqlTimeTravelStore.make
    return yield* body(store, sql)
  }).pipe(Effect.provide(TestDatabase.layer)) as Effect.Effect<A, unknown>

const fileHandle = <A>(
  filename: string,
  body: (
    store: TimeTravelStore.Service,
    sql: SqlClient.SqlClient
  ) => Effect.Effect<A, unknown, DatabaseModule.DurableWriter | SqlClient.SqlClient>
) => {
  const database = Layer.provideMerge(DatabaseModule.layer(), NodeDatabase.layer({ filename }))
  return Effect.scoped(
    Effect.gen(function*() {
      yield* Migrations.run
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const store = yield* SqlTimeTravelStore.make
      return yield* body(store, sql)
    }).pipe(Effect.provide(database))
  ) as Effect.Effect<A, unknown>
}

const insertRun = (
  sql: SqlClient.SqlClient,
  runId: string,
  options: {
    readonly status?: string
    readonly stateJson?: string
    readonly claimHostId?: string | null
  } = {}
) =>
  sql`
    INSERT INTO flows_runs
      (run_id, status, created_at_ms, state_json, owner_host_id, claim_host_id, claim_pid, claim_nonce, claimed_at_ms)
    VALUES (
      ${runId},
      ${options.status ?? "suspended"},
      0,
      ${options.stateJson ?? JSON.stringify({ version: 1, flowName: "Demo", payload: {} })},
      NULL,
      ${options.claimHostId ?? null},
      ${options.claimHostId === undefined ? null : 4321},
      ${options.claimHostId === undefined ? null : "claim-nonce"},
      ${options.claimHostId === undefined ? null : 0}
    )
  `

/** The run table constrains ownership columns, so a live run must be inserted whole. */
const insertRunningRun = (sql: SqlClient.SqlClient, runId: string) =>
  sql`
    INSERT INTO flows_runs
      (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
    VALUES (${runId}, 'running', 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })},
            'host-a', 1234, 'nonce', 0)
  `

const owner = { hostId: "host-a", pid: 1234, nonce: "nonce" } as const

/** A run row whose owner columns match {@link owner}, so the archive fence passes. */
const insertOwnedRun = (sql: SqlClient.SqlClient, runId: string) =>
  sql`
    INSERT INTO flows_runs
      (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
    VALUES (${runId}, 'running', 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })},
            ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0)
  `

describe("SqlTimeTravelStore.snapshotAt", () => {
  it.effect("returns the newest snapshot at or before the frame, scoped to one lineage", () =>
    Effect.gen(function*() {
      const result = yield* run((store, sql) =>
        Effect.gen(function*() {
          for (
            const row of [
              { lineage: "main", seq: 0, changeId: "c0" },
              { lineage: "main", seq: 5, changeId: "c5" },
              { lineage: "other", seq: 7, changeId: "x7" }
            ]
          ) {
            yield* sql`
            INSERT INTO flows_time_travel_snapshots (run_id, lineage_id, seq, change_id)
            VALUES ('run', ${row.lineage}, ${row.seq}, ${row.changeId})
          `
          }
          return {
            exact: yield* store.snapshotAt("run", { lineageId: "main", seq: 5 }),
            between: yield* store.snapshotAt("run", { lineageId: "main", seq: 4 }),
            beforeAny: yield* store.snapshotAt("run", { lineageId: "main", seq: -1 }),
            otherLineage: yield* store.snapshotAt("run", { lineageId: "other", seq: 100 }),
            otherRun: yield* store.snapshotAt("missing", { lineageId: "main", seq: 100 })
          }
        })
      )

      expect(result.exact).toEqual({ runId: "run", frame: { lineageId: "main", seq: 5 }, changeId: "c5" })
      expect(result.between).toEqual({ runId: "run", frame: { lineageId: "main", seq: 0 }, changeId: "c0" })
      expect(result.beforeAny).toBeUndefined()
      expect(result.otherLineage?.changeId).toBe("x7")
      expect(result.otherRun).toBeUndefined()
    }))

  it.effect("round-trips a roughly one-megabyte state projection without truncation", () =>
    Effect.gen(function*() {
      const large = "x".repeat(1024 * 1024)
      const state = { version: 1, flowName: "Large", payload: { large } }
      const stateJson = yield* run((store, sql) =>
        Effect.gen(function*() {
          yield* sql`
          INSERT INTO flows_journal_events
            (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
          VALUES ('large', 0, 'large-0', 'large', 0, 0, 'flows.engine.run-decision',
                  ${JSON.stringify({ state })}, ${JSON.stringify({ lineageId: "large/root" })})
        `
          return yield* store.stateAt("large", { lineageId: "large/root", seq: 0 })
        })
      )

      expect(stateJson).toBe(JSON.stringify(state))
      expect(stateJson?.length).toBeGreaterThan(1024 * 1024)
    }))

  it.effect("accepts MAX_SAFE_INTEGER and rejects one-past it at the SQL boundary", () =>
    Effect.gen(function*() {
      const result = yield* run((store) =>
        Effect.gen(function*() {
          yield* store.writeAudit({
            id: "safe",
            runId: "run",
            frame: { lineageId: "main", seq: Number.MAX_SAFE_INTEGER },
            status: "in_progress"
          })
          const unsafe = yield* Effect.flip(store.writeAudit({
            id: "unsafe",
            runId: "run",
            frame: { lineageId: "main", seq: Number.MAX_SAFE_INTEGER + 1 },
            status: "in_progress"
          }))
          return { pending: yield* store.pendingAudits(), unsafe }
        })
      )

      expect(result.pending).toMatchObject([{
        id: "safe",
        frame: { lineageId: "main", seq: 9007199254740991 }
      }])
      expect(result.unsafe).toMatchObject({ code: "unknown", message: "time-travel persistence failed" })
    }))

  it("keeps Frame schema parity with the MAX_SAFE_INTEGER SQL constraint", () => {
    expect(() => Schema.decodeUnknownSync(Frame.Frame)({ lineageId: "main", seq: Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow()
  })
})

describe("SqlTimeTravelStore.descendants", () => {
  it.effect("walks attached descendants transitively and reports detached edges separately", () =>
    Effect.gen(function*() {
      const result = yield* run((store, sql) =>
        Effect.gen(function*() {
          const edges = [
            ["parent", 1, "before", "child", 1],
            ["parent", 3, "attached", "child", 1],
            ["attached", 0, "grandchild", "continuation", 1],
            ["parent", 4, "detached", "fork", 0]
          ] as const
          for (const [parentRunId, parentSeq, childRunId, kind, attached] of edges) {
            yield* sql`
            INSERT INTO flows_time_travel_edges (parent_run_id, parent_seq, child_run_id, kind, attached)
            VALUES (${parentRunId}, ${parentSeq}, ${childRunId}, ${kind}, ${attached})
          `
          }
          return yield* store.descendants("parent", { lineageId: "main", seq: 2 })
        })
      )

      expect(result.attached.map((edge) => edge.childRunId)).toEqual(["attached", "grandchild"])
      expect(result.detached.map((edge) => edge.childRunId)).toEqual(["detached"])
      expect(result.attached[0]).toEqual({
        parentRunId: "parent",
        parentSeq: 3,
        childRunId: "attached",
        kind: "child",
        attached: true
      })
    }))

  it.effect("deduplicates an attached cycle while preserving every reachable edge", () =>
    Effect.gen(function*() {
      const result = yield* run((store, sql) =>
        Effect.gen(function*() {
          for (
            const [parentRunId, childRunId] of [
              ["parent", "child"],
              ["child", "parent"]
            ] as const
          ) {
            yield* sql`
            INSERT INTO flows_time_travel_edges (parent_run_id, parent_seq, child_run_id, kind, attached)
            VALUES (${parentRunId}, 1, ${childRunId}, 'continuation', 1)
          `
          }
          return yield* store.descendants("parent", { lineageId: "main", seq: 0 })
        })
      )

      expect(result.attached.map((edge) => edge.childRunId)).toEqual(["child", "parent"])
      expect(result.detached).toEqual([])
    }))
})

describe("SqlTimeTravelStore audits", () => {
  it.effect("round-trips optional rate limit and detail payloads through pendingAudits", () =>
    Effect.gen(function*() {
      const result = yield* run((store) =>
        Effect.gen(function*() {
          yield* store.writeAudit({
            id: "audit-1",
            runId: "run",
            frame: { lineageId: "main", seq: 2 },
            status: "in_progress",
            rateLimit: { remaining: 3 },
            detail: { phase: "preflight" }
          })
          yield* store.writeAudit({
            id: "audit-2",
            runId: "run",
            frame: { lineageId: "main", seq: 9 },
            status: "completed"
          })
          return yield* store.pendingAudits()
        })
      )

      expect(result).toEqual([
        {
          id: "audit-1",
          runId: "run",
          frame: { lineageId: "main", seq: 2 },
          status: "in_progress",
          rateLimit: { remaining: 3 },
          detail: { phase: "preflight" }
        }
      ])
    }))

  it.effect("patches only the supplied fields and drops the audit out of the pending set", () =>
    Effect.gen(function*() {
      const result = yield* run((store) =>
        Effect.gen(function*() {
          yield* store.writeAudit({
            id: "audit",
            runId: "run",
            frame: { lineageId: "main", seq: 1 },
            status: "in_progress",
            rateLimit: { remaining: 1 }
          })
          yield* store.updateAudit("audit", { status: "failed" })
          const pending = yield* store.pendingAudits()
          yield* store.updateAudit("audit", { status: "in_progress", detail: { reason: "retry" } })
          const reopened = yield* store.pendingAudits()
          return { pending, reopened }
        })
      )

      expect(result.pending).toEqual([])
      expect(result.reopened).toEqual([
        {
          id: "audit",
          runId: "run",
          frame: { lineageId: "main", seq: 1 },
          status: "in_progress",
          rateLimit: { remaining: 1 },
          detail: { reason: "retry" }
        }
      ])
    }))

  it.effect("fails updateAudit for an unknown id", () =>
    Effect.gen(function*() {
      const error = yield* run((store) => Effect.flip(store.updateAudit("nope", { status: "completed" })))

      expect(error).toMatchObject({ code: "not_found", message: "audit nope was not found" })
    }))

  it.effect("keeps absent optional fields absent when an audit is updated", () =>
    Effect.gen(function*() {
      const [audit] = yield* run((store) =>
        Effect.gen(function*() {
          yield* store.writeAudit({
            id: "audit-empty",
            runId: "run",
            frame: { lineageId: "main", seq: 0 },
            status: "in_progress"
          })
          yield* store.updateAudit("audit-empty", { status: "in_progress" })
          return yield* store.pendingAudits()
        })
      )

      expect(audit).toEqual({
        id: "audit-empty",
        runId: "run",
        frame: { lineageId: "main", seq: 0 },
        status: "in_progress",
        rateLimit: undefined,
        detail: undefined
      })
    }))

  it.effect("returns a typed persistence failure for malformed persisted audit JSON", () =>
    Effect.gen(function*() {
      const failure = yield* run((store, sql) =>
        Effect.gen(function*() {
          yield* sql`PRAGMA ignore_check_constraints = ON`
          yield* sql`
          INSERT INTO flows_time_travel_audits
            (id, run_id, lineage_id, seq, status, rate_limit_json, detail_json)
          VALUES ('malformed', 'run', 'main', 0, 'in_progress', NULL, '{')
        `
          return yield* Effect.flip(store.pendingAudits())
        })
      )

      expect(failure).toMatchObject({
        code: "unknown",
        message: "time-travel persistence failed",
        cause: expect.anything()
      })
    }))

  it.effect("rejects rows outside every durable time-travel boundary", () =>
    Effect.gen(function*() {
      const outcomes = yield* run((_store, sql) => {
        const invalidStatements = [
          `INSERT INTO flows_time_travel_audits VALUES ('', 'run', 'main', 0, 'in_progress', NULL, NULL)`,
          `INSERT INTO flows_time_travel_audits VALUES ('audit-negative', 'run', 'main', -1, 'in_progress', NULL, NULL)`,
          `INSERT INTO flows_time_travel_audits VALUES ('audit-fractional', 'run', 'main', 0.5, 'in_progress', NULL, NULL)`,
          `INSERT INTO flows_time_travel_audits VALUES ('audit-unsafe', 'run', 'main', 9007199254740992, 'in_progress', NULL, NULL)`,
          `INSERT INTO flows_time_travel_audits VALUES ('audit-status', 'run', 'main', 0, 'unknown', NULL, NULL)`,
          `INSERT INTO flows_time_travel_audits VALUES ('audit-json', 'run', 'main', 0, 'in_progress', '{', NULL)`,
          `INSERT INTO flows_time_travel_receipts VALUES ('', 'audit', 'effect', '{}')`,
          `INSERT INTO flows_time_travel_receipts VALUES ('receipt-audit', '', 'effect', '{}')`,
          `INSERT INTO flows_time_travel_receipts VALUES ('receipt-effect', 'audit', '', '{}')`,
          `INSERT INTO flows_time_travel_receipts VALUES ('receipt-json', 'audit', 'effect', '{')`,
          `INSERT INTO flows_time_travel_snapshots VALUES ('', 'main', 0, 'change')`,
          `INSERT INTO flows_time_travel_snapshots VALUES ('run', '', 0, 'change')`,
          `INSERT INTO flows_time_travel_snapshots VALUES ('run', 'main', -1, 'change')`,
          `INSERT INTO flows_time_travel_snapshots VALUES ('run', 'main', 0, '')`,
          `INSERT INTO flows_time_travel_edges VALUES ('', 0, 'child', 'child', 1)`,
          `INSERT INTO flows_time_travel_edges VALUES ('parent', -1, 'child', 'child', 1)`,
          `INSERT INTO flows_time_travel_edges VALUES ('parent', 0, '', 'child', 1)`,
          `INSERT INTO flows_time_travel_edges VALUES ('parent', 0, 'child-kind', 'unknown', 1)`,
          `INSERT INTO flows_time_travel_edges VALUES ('parent', 0, 'child-attached', 'child', 2)`,
          `INSERT INTO flows_time_travel_edges VALUES ('same', 0, 'same', 'child', 1)`,
          `INSERT INTO flows_time_travel_archive VALUES ('', 0, 'event', 'source', 0, 0, 'type', '{}', '{}', 0)`,
          `INSERT INTO flows_time_travel_archive VALUES ('run', -1, 'event', 'source', 0, 0, 'type', '{}', '{}', 0)`,
          `INSERT INTO flows_time_travel_archive VALUES ('run', 0, '', 'source', 0, 0, 'type', '{}', '{}', 0)`,
          `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 'event-source', '', 0, 0, 'type', '{}', '{}', 0)`,
          `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 'event-seq', 'source', -1, 0, 'type', '{}', '{}', 0)`,
          `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 'event-emitted', 'source', 0, -1, 'type', '{}', '{}', 0)`,
          `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 'event-type', 'source', 0, 0, '', '{}', '{}', 0)`,
          `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 'event-payload', 'source', 0, 0, 'type', '{', '{}', 0)`,
          `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 'event-meta', 'source', 0, 0, 'type', '{}', '{', 0)`,
          `INSERT INTO flows_time_travel_archive VALUES ('run', 0, 'event-archived', 'source', 0, 0, 'type', '{}', '{}', -1)`
        ] as const
        return Effect.forEach(invalidStatements, (statement) => Effect.exit(sql.unsafe(statement)))
      })

      expect(outcomes.every((outcome) => outcome._tag === "Failure")).toBe(true)
    }))
})

describe("SqlTimeTravelStore construction", () => {
  it.effect("dies before exposing a store when its migration cannot run", () =>
    Effect.gen(function*() {
      const failingSql = new Proxy(
        () => Effect.fail("no database"),
        { apply: () => Effect.fail("no database") }
      ) as unknown as SqlClient.SqlClient
      const exit = yield* (
        Effect.exit(SqlTimeTravelStore.make.pipe(
          Effect.provideService(SqlClient.SqlClient, failingSql),
          Effect.provide(DatabaseModule.layerNoop)
        ))
      )

      expect(exit._tag).toBe("Failure")
    }))
})

describe("SqlTimeTravelStore persistence fault matrix", () => {
  const audit: TimeTravelStore.Audit = {
    id: "audit",
    runId: "run",
    frame: { lineageId: "main", seq: 0 },
    status: "in_progress"
  }

  for (
    const scenario of [
      {
        method: "snapshotAt",
        table: "flows_time_travel_snapshots",
        invoke: (store: TimeTravelStore.Service) => store.snapshotAt("run", audit.frame)
      },
      {
        method: "descendants",
        table: "flows_time_travel_edges",
        invoke: (store: TimeTravelStore.Service) => store.descendants("run", audit.frame)
      },
      {
        method: "writeAudit",
        table: "flows_time_travel_audits",
        invoke: (store: TimeTravelStore.Service) => store.writeAudit(audit)
      },
      {
        method: "updateAudit",
        table: "flows_time_travel_audits",
        invoke: (store: TimeTravelStore.Service) => store.updateAudit("audit", { status: "failed" })
      },
      {
        method: "pendingAudits",
        table: "flows_time_travel_audits",
        invoke: (store: TimeTravelStore.Service) => store.pendingAudits()
      },
      {
        method: "archiveAndTruncate",
        table: "flows_time_travel_edges",
        // The fence guard reads `flows_runs` before the dropped table is
        // touched, so the run must exist under the fence's owner first.
        prepare: (sql: SqlClient.SqlClient) => insertOwnedRun(sql, "run"),
        invoke: (store: TimeTravelStore.Service) => store.archiveAndTruncate("run", audit.frame, [], owner)
      },
      {
        method: "createFork",
        table: "flows_runs",
        invoke: (store: TimeTravelStore.Service) => store.createFork("run", audit.frame)
      },
      {
        method: "recordReceipt",
        table: "flows_time_travel_receipts",
        invoke: (store: TimeTravelStore.Service) =>
          store.recordReceipt({ id: "receipt", auditId: "audit", effectId: "effect", receipt: {} })
      }
    ] as const
  ) {
    it.effect(`maps a ${scenario.method} database failure to the store's typed error`, () =>
      Effect.gen(function*() {
        const failure = yield* run((store, sql) =>
          Effect.gen(function*() {
            if ("prepare" in scenario) {
              yield* scenario.prepare(sql)
            }
            yield* sql.unsafe(`DROP TABLE ${scenario.table}`)
            return yield* Effect.flip(scenario.invoke(store))
          })
        )

        expect(failure).toMatchObject({
          code: "unknown",
          message: "time-travel persistence failed",
          cause: expect.anything()
        })
      }))
  }

  it.effect("rolls journal archival back when receipt persistence fails at commit", () =>
    Effect.gen(function*() {
      const result = yield* run((store, sql) =>
        Effect.gen(function*() {
          yield* insertOwnedRun(sql, "run")
          for (const seq of [0, 2]) {
            yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json)
            VALUES ('run', ${seq}, ${`event-${seq}`}, 'source', ${seq}, 0, 'test', '{}', '{}')
          `
          }
          yield* store.recordReceipt({
            id: "duplicate",
            auditId: "audit",
            effectId: "existing",
            receipt: { existing: true }
          })

          const failure = yield* Effect.flip(
            store.archiveAndTruncate("run", { lineageId: "main", seq: 0 }, [{
              id: "duplicate",
              auditId: "audit",
              effectId: "new",
              receipt: { existing: false }
            }], owner)
          )
          const journal = yield* sql<{ readonly seq: number }>`
          SELECT seq FROM flows_journal_events WHERE run_id = 'run' ORDER BY seq
        `
          const archive = yield* sql<{ readonly seq: number }>`
          SELECT seq FROM flows_time_travel_archive WHERE run_id = 'run' ORDER BY seq
        `
          const receipts = yield* sql<{ readonly id: string; readonly effect_id: string }>`
          SELECT id, effect_id FROM flows_time_travel_receipts ORDER BY id
        `
          return { failure, journal, archive, receipts }
        })
      )

      expect(result.failure).toMatchObject({ code: "unknown", message: "time-travel persistence failed" })
      expect(result.journal).toEqual([{ seq: 0 }, { seq: 2 }])
      expect(result.archive).toEqual([])
      expect(result.receipts).toEqual([{ id: "duplicate", effect_id: "existing" }])
    }))
})

describe("SqlTimeTravelStore.recordReceipt", () => {
  it.effect("persists a receipt row that archiveAndTruncate can then append to", () =>
    Effect.gen(function*() {
      const rows = yield* run((store, sql) =>
        Effect.gen(function*() {
          yield* store.recordReceipt({ id: "r1", auditId: "audit", effectId: "effect-a", receipt: { undone: true } })
          yield* insertOwnedRun(sql, "run")
          yield* store.archiveAndTruncate("run", { lineageId: "main", seq: 0 }, [
            { id: "r2", auditId: "audit", effectId: "effect-b", receipt: { undone: false } }
          ], owner)
          return yield* sql<
            { readonly id: string; readonly effect_id: string; readonly receipt_json: string }
          >`SELECT id, effect_id, receipt_json FROM flows_time_travel_receipts ORDER BY id`
        })
      )

      expect(rows).toEqual([
        { id: "r1", effect_id: "effect-a", receipt_json: JSON.stringify({ undone: true }) },
        { id: "r2", effect_id: "effect-b", receipt_json: JSON.stringify({ undone: false }) }
      ])
    }))
})

describe("SqlTimeTravelStore derived reads", () => {
  it.effect("reads back the plan digest an anchor recorded, and skips an attempt record it cannot decode", () =>
    Effect.gen(function*() {
      const result = yield* run((store, sql) =>
        Effect.gen(function*() {
          yield* store.recordSnapshot({
            runId: "derived",
            frame: { lineageId: "derived/root", seq: 1 },
            changeId: "change-1",
            planDigest: "plan-a"
          })
          yield* sql`
          INSERT INTO flows_journal_events
            (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
          VALUES
            ('derived', 0, 'd0', 's', 0, 0, 'flows.engine.attempt-started',
             ${JSON.stringify({ stepKeyDigest: "a", attempt: 1 })}, ${JSON.stringify({ lineageId: "derived/root" })}),
            ('derived', 1, 'd1', 's', 1, 0, 'flows.engine.attempt-started',
             ${JSON.stringify({ nothing: true })}, ${JSON.stringify({ lineageId: "derived/root" })})
        `
          return {
            anchor: yield* store.snapshotAt("derived", { lineageId: "derived/root", seq: 2 }),
            attempts: yield* store.attemptsAt("derived", { lineageId: "derived/root", seq: 2 }),
            absent: yield* store.stateAt("derived", { lineageId: "derived/root", seq: 2 })
          }
        })
      )

      expect(result.anchor).toEqual({
        runId: "derived",
        frame: { lineageId: "derived/root", seq: 1 },
        changeId: "change-1",
        planDigest: "plan-a"
      })
      // The malformed record is skipped, not guessed at.
      expect(result.attempts).toEqual([{ stepKeyDigest: "a", attempt: 1 }])
      expect(result.absent).toBeUndefined()
    }))
})

describe("SqlTimeTravelStore.createFork", () => {
  it.effect("creates distinct coherent forks when two store handles race at one parent frame", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-time-travel-store-race-")))
      const filename = join(directory, "store.sqlite")
      try {
        yield* (
          fileHandle(filename, (_store, sql) =>
            Effect.gen(function*() {
              yield* insertRun(sql, "concurrent-parent")
              yield* sql`
              INSERT INTO flows_journal_events
                (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                 event_type, payload_json, meta_json)
              VALUES ('concurrent-parent', 0, 'concurrent-0', 'source', 0, 0,
                      'flows.engine.run-decision',
                      ${JSON.stringify({ state: { version: 1, flowName: "Demo", payload: {} } })},
                      ${JSON.stringify({ lineageId: "concurrent-parent/root" })})
            `
            }))
        )

        const result = yield* (
          Effect.gen(function*() {
            const readyA = yield* Deferred.make<void>()
            const readyB = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const race = (ready: Deferred.Deferred<void>) =>
              fileHandle(filename, (store) =>
                Deferred.succeed(ready, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(
                    store.createFork("concurrent-parent", { lineageId: "concurrent-parent/root", seq: 0 })
                  )
                ))
            // Each child scope constructs its own NodeDatabase, SqlClient,
            // DurableWriter, and SqlTimeTravelStore over the same file.
            const fiberA = yield* Effect.forkChild(race(readyA), { startImmediately: true })
            const fiberB = yield* Effect.forkChild(race(readyB), { startImmediately: true })
            yield* Deferred.await(readyA)
            yield* Deferred.await(readyB)
            yield* Deferred.succeed(release, undefined)
            return { first: yield* Fiber.join(fiberA), second: yield* Fiber.join(fiberB) }
          })
        )
        const edges = yield* (
          fileHandle(filename, (_store, sql) =>
            sql<{
              readonly parent_run_id: string
              readonly parent_seq: number
              readonly child_run_id: string
            }>`
            SELECT parent_run_id, parent_seq, child_run_id
            FROM flows_time_travel_edges
            WHERE parent_run_id = 'concurrent-parent'
            ORDER BY child_run_id
          `)
        )

        expect(result.first.runId).not.toBe(result.second.runId)
        expect(edges).toEqual([
          { parent_run_id: "concurrent-parent", parent_seq: 0, child_run_id: result.first.runId },
          { parent_run_id: "concurrent-parent", parent_seq: 0, child_run_id: result.second.runId }
        ].sort((left, right) => left.child_run_id.localeCompare(right.child_run_id)))
      } finally {
        yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
      }
    }))

  it.effect("derives state and attempts AT the frame, marks the fork, and numbers repeated forks", () =>
    Effect.gen(function*() {
      const result = yield* run((store, sql) =>
        Effect.gen(function*() {
          // The run row holds the run's state NOW — terminal, with a result and a
          // cancellation. The fork must not inherit any of it; it must rebuild
          // the state the frame recorded.
          yield* insertRun(sql, "parent", {
            stateJson: JSON.stringify({
              version: 1,
              flowName: "Demo",
              payload: { seed: "final" },
              result: { _tag: "Success" },
              cancellation: { interruptedAtMs: 1 }
            })
          })
          const event = (seq: number, eventType: string, payload: unknown) =>
            sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
            VALUES (
              'parent', ${seq}, ${`e${seq}`}, 'source', ${seq}, 0, ${eventType},
              ${JSON.stringify(payload)}, ${JSON.stringify({ lineageId: "main" })}
            )
          `
          yield* event(0, "flows.engine.run-decision", {
            decision: "created",
            state: { version: 1, flowName: "Demo", payload: { seed: "at-frame" } }
          })
          yield* event(1, "flows.engine.attempt-started", { stepKeyDigest: "digest", attempt: 1 })
          // Everything below the fork frame: a later state the child must not
          // inherit, and a later attempt its copied journal cannot explain.
          yield* event(2, "flows.engine.attempt-started", { stepKeyDigest: "later", attempt: 1 })
          yield* event(3, "flows.engine.run-decision", {
            decision: "transitioned",
            state: { version: 1, flowName: "Demo", payload: { seed: "final" } }
          })
          for (const digest of ["digest", "later"]) {
            yield* sql`
            INSERT INTO flows_attempts
              (run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms,
               heartbeat_at_ms, checkpoint_json, error_json, outcome_json, meta_json)
            VALUES ('parent', ${digest}, 1, 'succeeded', 0, 1, 1, NULL, NULL, '{}', '{}')
          `
          }

          const first = yield* store.createFork("parent", { lineageId: "main", seq: 1 })
          const second = yield* store.createFork("parent", { lineageId: "main", seq: 1 })
          const forkEvents = yield* sql<
            {
              readonly seq: number
              readonly event_id: string
              readonly event_type: string
              readonly payload_json: string
            }
          >`
          SELECT seq, event_id, event_type, payload_json
          FROM flows_journal_events WHERE run_id = ${first.runId} ORDER BY seq
        `
          const forkRun = yield* sql<{ readonly status: string; readonly state_json: string }>`
          SELECT status, state_json FROM flows_runs WHERE run_id = ${first.runId}
        `
          const forkAttempts = yield* sql<{ readonly step_key_digest: string }>`
          SELECT step_key_digest FROM flows_attempts WHERE run_id = ${first.runId} ORDER BY step_key_digest
        `
          const parentAttempts = yield* sql<{ readonly step_key_digest: string }>`
          SELECT step_key_digest FROM flows_attempts WHERE run_id = 'parent' ORDER BY step_key_digest
        `
          return { first, second, forkEvents, forkRun, forkAttempts, parentAttempts }
        })
      )

      expect(result.first.runId).toBe("parent:fork:1:1")
      expect(result.second.runId).toBe("parent:fork:1:2")
      expect(result.first.warnings).toEqual([])
      expect(result.first.edge).toEqual({
        parentRunId: "parent",
        parentSeq: 1,
        childRunId: "parent:fork:1:1",
        kind: "fork",
        attached: false
      })
      // The copied prefix, then the fork-created marker directly above it.
      expect(result.forkEvents.map((row) => row.seq)).toEqual([0, 1, 2])
      expect(result.forkEvents[0]!.event_id).toBe("fork:parent:fork:1:1:e0")
      expect(result.forkEvents[2]!.event_type).toBe(Frame.forkCreatedEventType)
      expect(JSON.parse(result.forkEvents[2]!.payload_json)).toEqual({
        parentRunId: "parent",
        forkJournalOffset: 1,
        childRunId: "parent:fork:1:1"
      })
      expect(result.forkRun[0]!.status).toBe("pending")
      // The state AT the frame, not the parent's current state.
      expect(JSON.parse(result.forkRun[0]!.state_json)).toEqual({
        version: 1,
        flowName: "Demo",
        payload: { seed: "at-frame" }
      })
      // Filtered to the frame: `later` started after it and is not inherited,
      // while the parent keeps both.
      expect(result.forkAttempts).toEqual([{ step_key_digest: "digest" }])
      expect(result.parentAttempts).toEqual([{ step_key_digest: "digest" }, { step_key_digest: "later" }])
    }))

  it.effect("surfaces a missing parent as a typed `not_found` failure", () =>
    Effect.gen(function*() {
      const error = yield* run((store) => Effect.flip(store.createFork("ghost", { lineageId: "main", seq: 0 })))

      expect(error).toMatchObject({ code: "not_found", message: "parent ghost was not found" })
    }))

  for (
    const scenario of [
      { name: "is running and owned", running: true },
      { name: "is only claimed by another host", running: false }
    ] as const
  ) {
    it.effect(`refuses to fork when the parent ${scenario.name}`, () =>
      Effect.gen(function*() {
        const error = yield* run((store, sql) =>
          Effect.gen(function*() {
            yield* scenario.running
              ? insertRunningRun(sql, "parent")
              : insertRun(sql, "parent", { claimHostId: "host-b" })
            return yield* Effect.flip(store.createFork("parent", { lineageId: "main", seq: 0 }))
          })
        )

        expect(error).toMatchObject({ code: "live_parent", message: "parent parent is live" })
      }))
  }

  it.effect("refuses to fork when a transitive ancestor is live", () =>
    Effect.gen(function*() {
      const error = yield* run((store, sql) =>
        Effect.gen(function*() {
          yield* insertRunningRun(sql, "grandparent")
          yield* insertRun(sql, "parent")
          yield* sql`
          INSERT INTO flows_time_travel_edges (parent_run_id, parent_seq, child_run_id, kind, attached)
          VALUES ('grandparent', 0, 'parent', 'fork', 0)
        `
          return yield* Effect.flip(store.createFork("parent", { lineageId: "main", seq: 0 }))
        })
      )

      expect(error).toMatchObject({ code: "live_parent", message: "parent grandparent is live" })
    }))

  for (
    const [name, stateJson] of [
      ["malformed JSON", "{"],
      ["null", JSON.stringify(null)],
      ["an array", JSON.stringify([])],
      ["a missing version", JSON.stringify({ flowName: "Demo", payload: {} })],
      ["a newer version", JSON.stringify({ version: 2, flowName: "Demo", payload: {} })],
      ["a non-string flow name", JSON.stringify({ version: 1, flowName: 1, payload: {} })],
      ["a missing payload", JSON.stringify({ version: 1, flowName: "Demo" })]
    ] as const
  ) {
    it.effect(`rejects ${name} as a restartable parent state`, () =>
      Effect.gen(function*() {
        const failure = yield* run((store, sql) =>
          Effect.gen(function*() {
            yield* sql`PRAGMA ignore_check_constraints = ON`
            yield* insertRun(sql, "parent", { stateJson })
            return yield* Effect.flip(store.createFork("parent", { lineageId: "main", seq: 0 }))
          })
        )

        expect(failure).toMatchObject({ code: "unknown", message: "could not materialize executable fork state" })
      }))
  }
})
