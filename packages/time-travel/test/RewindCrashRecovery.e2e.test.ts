import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as EffectBoundary from "../src/EffectBoundary.ts"
import { TimeTravel } from "../src/TimeTravel.ts"
import { jjInstalled, runReal, runState, withRealFixture } from "./RealTimeTravelHarness.ts"

const childFixture = fileURLToPath(new URL("./fixtures/rewind-crash-child.ts", import.meta.url))

const checkpoint = (child: ChildProcessWithoutNullStreams): Promise<{ readonly stage: string }> =>
  new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    const timeout = setTimeout(() => reject(new Error(`crash child timed out\n${stderr}\n${stdout}`)), 30_000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
      const line = stdout.split("\n").find((candidate) => candidate.startsWith("{"))
      if (line !== undefined) {
        clearTimeout(timeout)
        resolve(JSON.parse(line) as { readonly stage: string })
      }
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", (cause) => {
      clearTimeout(timeout)
      reject(cause)
    })
    child.once("exit", (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`crash child exited before checkpoint: ${code ?? signal}\n${stderr}\n${stdout}`))
    })
  })

const killHard = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGKILL")
  await once(child, "exit")
}

describe.skipIf(!jjInstalled)("rewind crash recovery over file SQLite", () => {
  // The finite budget covers two real child processes, SIGKILL, and fresh recovery layers.
  it.effect("recovers real process deaths after audit write and archive commit", () =>
    Effect.gen(function*() {
      for (const stage of ["after-audit", "after-archive"] as const) {
        yield* withRealFixture(`flows-rewind-${stage}-`, (fixture) =>
          Effect.gen(function*() {
            const runId = `run-${stage}`
            yield* runReal(
              fixture.databaseFile,
              Effect.gen(function*() {
                const sql = yield* Effect.service(SqlClient.SqlClient)
                yield* sql`
              INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
              VALUES (${runId}, 'suspended', 0, ${runState("KilledRewind")})
            `
                yield* sql`
              INSERT INTO flows_journal_events
                (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
              VALUES (${runId}, 0, ${`${runId}-0`}, 'killed-rewind', 0, 0, 'baseline', '{}',
                      ${JSON.stringify({ lineageId: `${runId}/root` })}),
                     (${runId}, 1, ${`${runId}-1`}, 'killed-rewind', 1, 1, 'suffix', '{}',
                      ${JSON.stringify({ lineageId: `${runId}/root` })})
            `
              })
            )
            const child = spawn(process.execPath, [childFixture, fixture.databaseFile, runId, stage], {
              cwd: fixture.repository,
              env: { ...process.env, JJ_EDITOR: "true" }
            })
            try {
              expect(yield* Effect.promise(() => checkpoint(child))).toEqual({ stage })
              yield* Effect.promise(() => killHard(child))
              const recovered = yield* runReal(
                fixture.databaseFile,
                Effect.gen(function*() {
                  const timeTravel = yield* TimeTravel
                  void timeTravel
                  const sql = yield* Effect.service(SqlClient.SqlClient)
                  const audit = yield* sql<{ readonly status: string; readonly detail_json: string }>`
                SELECT status, detail_json FROM flows_time_travel_audits WHERE id = ${`${runId}-audit`}
              `
                  const live = yield* sql<{ readonly seq: number }>`
                SELECT seq FROM flows_journal_events WHERE run_id = ${runId} ORDER BY seq
              `
                  const archived = yield* sql<{ readonly seq: number }>`
                SELECT seq FROM flows_time_travel_archive WHERE run_id = ${runId} ORDER BY seq
              `
                  return { archived, audit: audit[0]!, live }
                })
              )

              expect(recovered.audit.status).toBe(stage === "after-audit" ? "failed" : "completed")
              expect(JSON.parse(recovered.audit.detail_json).phase).toBe(
                stage === "after-audit" ? "terminal_failure" : "completed"
              )
              expect(recovered.live).toEqual(stage === "after-audit" ? [{ seq: 0 }, { seq: 1 }] : [{ seq: 0 }])
              expect(recovered.archived).toEqual(stage === "after-audit" ? [] : [{ seq: 1 }])
            } finally {
              yield* Effect.promise(() => killHard(child))
            }
          }))
      }
    }), { timeout: 120_000 })

  // These supplemental fixtures persist exact crash images directly so the
  // corruption variants stay independently nameable beside the SIGKILL cases.
  // The finite budget covers real jj discovery and three database lifetimes.
  it.effect("recovers audit-written and archive-committed crash images exactly once", () =>
    Effect.gen(function*() {
      yield* withRealFixture("flows-rewind-crash-", (fixture) =>
        Effect.gen(function*() {
          yield* runReal(
            fixture.databaseFile,
            Effect.gen(function*() {
              const sql = yield* Effect.service(SqlClient.SqlClient)
              for (const runId of ["after-audit", "after-archive", "intended-only"]) {
                yield* sql`
              INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
              VALUES (${runId}, 'suspended', 0, ${runState("CrashRecovery")})
            `
                yield* sql`
              INSERT INTO flows_journal_events
                (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
              VALUES (${runId}, 0, ${`${runId}-0`}, 'crash', 0, 0, 'baseline',
                      ${JSON.stringify({ value: runId })},
                      ${JSON.stringify({ lineageId: `${runId}/root` })})
            `
              }
              yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
            VALUES ('after-audit', 1, 'after-audit-1', 'crash', 1, 1, 'suffix', '{}',
                    ${JSON.stringify({ lineageId: "after-audit/root" })})
          `
              yield* sql`
            INSERT INTO flows_time_travel_archive
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json, archived_at_ms)
            VALUES ('after-archive', 1, 'after-archive-1', 'crash', 1, 1, 'suffix', '{}',
                    ${JSON.stringify({ lineageId: "after-archive/root" })}, 2)
          `
              const detail = (phase: "audit_written" | "compensated", suffixCount: number) =>
                JSON.stringify({
                  version: 1,
                  phase,
                  originalStatus: "suspended",
                  suffixCount,
                  ...(suffixCount === 0 ? {} : { suffixTailSeq: 1, compensation: { handlerReceipts: [] } }),
                  warnings: [],
                  cancelledChildren: []
                })
              yield* sql`
            INSERT INTO flows_time_travel_audits
              (id, run_id, lineage_id, seq, status, detail_json)
            VALUES
              ('audit-written', 'after-audit', 'after-audit/root', 0, 'in_progress',
               ${detail("audit_written", 0)}),
              ('archive-written', 'after-archive', 'after-archive/root', 0, 'in_progress',
               ${detail("compensated", 1)})
          `
              yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
            VALUES ('intended-only', 1, 'intended-1', 'crash', 1, 1, ${EffectBoundary.eventType},
                    ${
                JSON.stringify({
                  version: 1,
                  effect: {
                    id: "unsettled-send",
                    kind: "mail/send",
                    tier: "irreversible",
                    status: "intended",
                    runId: "intended-only",
                    lineageId: "intended-only/root",
                    durableBoundary: true,
                    providerStream: false
                  }
                })
              }, ${JSON.stringify({ lineageId: "intended-only/root" })})
          `
            })
          )

          const recovered = yield* runReal(
            fixture.databaseFile,
            Effect.gen(function*() {
              // Acquiring TimeTravel is the startup recovery trigger.
              const timeTravel = yield* TimeTravel
              const refusal = yield* Effect.flip(timeTravel.rewind({
                runId: "intended-only",
                frame: { lineageId: "intended-only/root", seq: 0 }
              }))
              const projection = {
                initial: [] as Array<string>,
                reduce: (state: Array<string>, entry: { readonly payload: unknown }) => [
                  ...state,
                  String((entry.payload as { readonly value?: string }).value)
                ]
              }
              const position = {
                runId: "after-audit",
                frame: { lineageId: "after-audit/root", seq: 1 }
              } as const
              const first = yield* timeTravel.inspect(position, projection)
              const second = yield* timeTravel.inspect(position, projection)
              const sql = yield* Effect.service(SqlClient.SqlClient)
              const audits = yield* sql<{ readonly id: string; readonly status: string; readonly detail_json: string }>`
            SELECT id, status, detail_json FROM flows_time_travel_audits
            WHERE id IN ('audit-written', 'archive-written') ORDER BY id
          `
              return { audits, first, refusal, second }
            })
          )

          expect(recovered.audits.map((audit) => ({ id: audit.id, status: audit.status }))).toEqual([
            { id: "archive-written", status: "completed" },
            { id: "audit-written", status: "failed" }
          ])
          expect(recovered.audits.map((audit) => JSON.parse(audit.detail_json).phase)).toEqual([
            "completed",
            "rolled_back"
          ])
          expect(recovered.refusal.code).toBe("irreversible")
          expect(recovered.first).toEqual(["after-audit", "undefined"])
          expect(recovered.second).toEqual(recovered.first)

          const reopened = yield* runReal(
            fixture.databaseFile,
            Effect.gen(function*() {
              const sql = yield* Effect.service(SqlClient.SqlClient)
              return yield* sql<{ readonly status: string }>`
            SELECT status FROM flows_time_travel_audits
            WHERE id IN ('audit-written', 'archive-written') ORDER BY id
          `
            })
          )
          expect(reopened).toEqual([{ status: "completed" }, { status: "failed" }])
        }))
    }), { timeout: 60_000 })
})
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
