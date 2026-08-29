import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { TimeTravel } from "../src/TimeTravel.ts"
import {
  jjInstalled,
  Journal,
  parkCompensableFlow,
  parkSealedFlow,
  runRealEngine,
  withRealFixture
} from "./RealTimeTravelHarness.ts"

interface JournalRow {
  readonly event_type: string
  readonly payload_json: string
  readonly run_id: string
  readonly seq: number
}

const tailOf = (rows: ReadonlyArray<JournalRow>, runId: string): number =>
  rows.filter((row) => row.run_id === runId).at(-1)!.seq

describe.skipIf(!jjInstalled)("real file-backed rewind", () => {
  // The finite budget covers real engine execution, jj child processes, and two complete SQLite/service lifetimes.
  it.effect(
    "rewinds parked durable flows at exact tail and frame zero without touching the parent workspace",
    () =>
      Effect.gen(function*() {
        yield* withRealFixture("flows-time-travel-rewind-", (fixture) =>
          Effect.gen(function*() {
            const note = join(fixture.repository, "note.txt")
            yield* Effect.promise(() => writeFile(note, "parent-stable\n"))

            const first = yield* runRealEngine(
              fixture.databaseFile,
              "rewind-first",
              Effect.gen(function*() {
                yield* parkSealedFlow("tail-run", Effect.succeed("tail"))
                yield* parkSealedFlow("zero-run", Effect.succeed("zero"))
                const journal = yield* Journal.Journal
                yield* journal.flush
                const sql = yield* Effect.service(SqlClient.SqlClient)
                const initialRows = yield* sql<JournalRow>`
              SELECT run_id, seq, event_type, payload_json
              FROM flows_journal_events
              WHERE run_id IN ('tail-run', 'zero-run')
              ORDER BY run_id, seq
            `
                const tailSeq = tailOf(initialRows, "tail-run")
                const zeroTailSeq = tailOf(initialRows, "zero-run")
                const timeTravel = yield* TimeTravel
                const beforeTail = yield* Effect.promise(() => readFile(note, "utf8"))
                const tail = yield* timeTravel.rewind({
                  runId: "tail-run",
                  frame: { lineageId: "tail-run/root", seq: tailSeq }
                })
                const afterTail = yield* Effect.promise(() => readFile(note, "utf8"))
                const zero = yield* timeTravel.rewind({
                  runId: "zero-run",
                  frame: { lineageId: "zero-run/root", seq: 0 }
                })
                const afterZero = yield* Effect.promise(() => readFile(note, "utf8"))
                return { afterTail, afterZero, beforeTail, tail, tailSeq, zero, zeroTailSeq }
              })
            )

            expect(first.tail.archive.archived).toBe(0)
            expect(first.zero.archive.archived).toBe(first.zeroTailSeq)
            expect(first.beforeTail).toBe("parent-stable\n")
            expect(first.afterTail).toBe("parent-stable\n")
            expect(first.afterZero).toBe("parent-stable\n")
            expect(yield* Effect.promise(() => readFile(note, "utf8"))).toBe("parent-stable\n")

            const reopened = yield* runRealEngine(
              fixture.databaseFile,
              "rewind-restarted",
              Effect.gen(function*() {
                const sql = yield* Effect.service(SqlClient.SqlClient)
                const journal = yield* sql<
                  { readonly count: number; readonly maximum: number; readonly run_id: string }
                >`
              SELECT run_id, COUNT(*) AS count, MAX(seq) AS maximum
              FROM flows_journal_events
              WHERE run_id IN ('tail-run', 'zero-run')
              GROUP BY run_id ORDER BY run_id
            `
                const archive = yield* sql<{ readonly count: number; readonly run_id: string }>`
              SELECT run_id, COUNT(*) AS count
              FROM flows_time_travel_archive
              WHERE run_id IN ('tail-run', 'zero-run')
              GROUP BY run_id ORDER BY run_id
            `
                const audits = yield* sql<{ readonly run_id: string; readonly status: string }>`
              SELECT run_id, status
              FROM flows_time_travel_audits
              WHERE run_id IN ('tail-run', 'zero-run')
              ORDER BY run_id
            `
                const runs = yield* sql<{
                  readonly owner_host_id: string | null
                  readonly run_id: string
                  readonly status: string
                }>`
              SELECT run_id, status, owner_host_id
              FROM flows_runs
              WHERE run_id IN ('tail-run', 'zero-run')
              ORDER BY run_id
            `
                return { archive, audits, journal, runs }
              })
            )

            expect(reopened.journal).toEqual([
              { run_id: "tail-run", count: first.tailSeq + 1, maximum: first.tailSeq },
              { run_id: "zero-run", count: 1, maximum: 0 }
            ])
            expect(reopened.archive).toEqual([{ run_id: "zero-run", count: first.zeroTailSeq }])
            expect(reopened.audits).toEqual([
              { run_id: "tail-run", status: "completed" },
              { run_id: "zero-run", status: "completed" }
            ])
            expect(reopened.runs).toEqual([
              { run_id: "tail-run", status: "suspended", owner_host_id: null },
              { run_id: "zero-run", status: "suspended", owner_host_id: null }
            ])
          }))
      }),
    { timeout: 60_000 }
  )

  it.effect(
    "restores the real jj tree to the compensable action's anchored revision",
    () =>
      Effect.gen(function*() {
        yield* withRealFixture("flows-time-travel-tree-", (fixture) =>
          Effect.gen(function*() {
            const note = join(fixture.repository, "note.txt")
            yield* Effect.promise(() => writeFile(note, "anchored\n"))
            const result = yield* runRealEngine(
              fixture.databaseFile,
              "rewind-tree",
              Effect.gen(function*() {
                yield* parkCompensableFlow(
                  "tree-run",
                  Effect.promise(() => writeFile(note, "effect-output\n")).pipe(Effect.as("tree"))
                )
                const journal = yield* Journal.Journal
                yield* journal.flush
                const sql = yield* Effect.service(SqlClient.SqlClient)
                const rows = yield* sql<JournalRow>`
              SELECT run_id, seq, event_type, payload_json
              FROM flows_journal_events
              WHERE run_id = 'tree-run'
              ORDER BY seq
            `
                const anchor = rows.find((row) => {
                  if (row.event_type !== "flows.engine.snapshot-identified") return false
                  const payload = JSON.parse(row.payload_json) as { readonly snapshotId?: string }
                  return payload.snapshotId !== undefined
                })
                if (anchor === undefined) return yield* Effect.die(new Error("engine did not commit a jj anchor"))
                yield* Effect.promise(() => writeFile(note, "mutated-after-anchor\n"))
                const timeTravel = yield* TimeTravel
                const rewind = yield* timeTravel.rewind({
                  runId: "tree-run",
                  frame: { lineageId: "tree-run/root", seq: anchor.seq }
                })
                return { restored: yield* Effect.promise(() => readFile(note, "utf8")), rewind }
              })
            )

            expect.soft(result.rewind.assessments.some((assessment) => assessment.effect.tier === "compensable")).toBe(
              true
            )
            expect.soft(result.restored).toBe("anchored\n")
            expect.soft(yield* Effect.promise(() => readFile(note, "utf8"))).toBe("anchored\n")
          }))
      }),
    { timeout: 60_000 }
  )
})
