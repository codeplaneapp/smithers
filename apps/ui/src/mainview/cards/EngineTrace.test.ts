import { describe, expect, test } from "bun:test"
import * as JournalRecords from "../../../../../packages/smithers/flows/engine-store/src/internal/JournalRecords.ts"
import type { JournalRecord } from "./RunTrace"
import { traceFromJournal, turnNarratives } from "./RunTrace"
import { engineProjectionPending } from "./EngineTrace"

const run = { runId: "control", flowId: "coding", status: "running" }
const lineage = (id = "native") => ({ kind: "root", runId: id, rootRunId: id, lineageId: id, round: 0, parentRunId: null })
const wrap = (sequence: number, executionId: string, eventType: string, payload: unknown, generation = 0): JournalRecord => ({
  sequence, occurredAt: 1000 + sequence,
  kind: "control.engine.event",
  payload: {
    version: 1, executionId, generation, sequence, eventId: `${executionId}/${generation}/${sequence}`,
    sourceId: "engine", sourceSequence: sequence, emittedAtMs: sequence + 100,
    eventType, payload, meta: { lineageId: executionId }
  }
})

/** Use the production writer to build current result records; no second result dialect. */
const decision = (sequence: number, executionId: string, status?: string, value?: unknown, parentExecutionId?: string, generation = 0) => {
  const record = JournalRecords.runDecision({ runId: executionId, sourceId: "engine", lineageId: executionId }, {
    decision: status === undefined ? "created" : "transitioned",
    ...(status === undefined ? {} : { status }),
    state: {
      version: 1, flowName: executionId === "native" ? "coding/RunPlan" : "coding/Check", payload: { target: "typecheck" },
      ...(parentExecutionId === undefined ? {} : { parentExecutionId }),
      ...(status === "completed" ? { result: { _tag: "Complete", exit: { _tag: "Success", value } } } : {})
    }
  })
  return wrap(sequence, executionId, record.eventType, record.payload, generation)
}

describe("recorded engine evidence in the run trace", () => {
  test("only the matching recorded projection generation settles observation", () => {
    const marker = (sequence: number, kind: string, generation: number) => ({ sequence, kind, payload: { version: 1, executionId: "native", generation } })
    const records = [marker(1, "control.engine.projection-started", 0), marker(2, "control.engine.projection-settled", 0)]
    expect(engineProjectionPending(records)).toBe(false)
    records.push(marker(3, "control.engine.projection-started", 1), marker(4, "control.engine.projection-settled", 0))
    expect(engineProjectionPending(records)).toBe(true)
    expect(engineProjectionPending([...records, { sequence: 5, kind: "control.engine.projection-gap", payload: {} }])).toBe(false)
    expect(engineProjectionPending([...records, marker(5, "control.engine.projection-settled", 1)])).toBe(false)
  })
  test("uses recorded child ancestry and real terminal result bytes without making a check verdict from native completion", () => {
    const records = [
      decision(1, "native"),
      decision(2, "opaque-child", undefined, undefined, "native"),
      wrap(3, "opaque-child", "flows.engine.attempt-started", { runId: "opaque-child", stepKeyDigest: "step", attempt: 0, tier: "sealed" }),
      wrap(4, "opaque-child", "flows.engine.attempt-finished", { runId: "opaque-child", stepKeyDigest: "step", attempt: 0, state: "succeeded", value: "not an attempt result" }),
      decision(5, "opaque-child", "completed", { passed: false, target: "typecheck" }, "native")
    ]
    const model = traceFromJournal(run, records)
    const native = model.root.children[0]!
    expect(native).toMatchObject({ kind: "execution", label: "coding/RunPlan", status: "pending", startedAt: 101 })
    expect(native.children[0]).toMatchObject({ kind: "execution", label: "coding/Check", status: "completed", detail: { output: '{"passed":false,"target":"typecheck"}' } })
    const attempt = native.children[0]!.children[0]!
    expect(attempt).toMatchObject({ kind: "attempt", status: "completed", startedAt: 103, endedAt: 104 })
    expect(attempt.detail.output).toBeUndefined()
    expect(turnNarratives(model)).toEqual([])
    // A control completion does not invent a completion for this still-open execution.
    const completed = traceFromJournal({ ...run, status: "completed" }, [...records, { sequence: 6, kind: "control.run.completed", occurredAt: 106 }])
    expect(completed.root.children[0]?.status).toBe("pending")
  })

  test("decodes v2 result and timing contracts, preserving failures and refusing live states with fabricated outputs", () => {
    const base = { version: 2, executionId: "native", lineage: lineage(), stepKeyDigest: "step", attempt: 0 }
    const records = [
      wrap(1, "native", "flows.engine.v2.attempt-lifecycle", { ...base, lifecycle: { state: "running", startedAtMs: 10 } }),
      wrap(2, "native", "flows.engine.v2.attempt-lifecycle", { ...base, lifecycle: { state: "failed", startedAtMs: 10, finishedAtMs: 30, result: { _tag: "Failure", reason: "error", detail: "typecheck failed" } } }),
      wrap(3, "native", "flows.engine.v2.attempt-lifecycle", { ...base, attempt: 1, lifecycle: { state: "running", startedAtMs: 35, result: { _tag: "Success", value: "invented" } } })
    ]
    const model = traceFromJournal(run, records)
    const attempts = model.rows.filter((row) => row.kind === "attempt")
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ status: "failed", startedAt: 10, endedAt: 30, detail: { message: "typecheck failed" } })
    expect(model.rows.every((row) => row.detail.output === undefined)).toBe(true)
    expect(model.rows.some((row) => row.kind === "event" && row.label === "flows.engine.v2.attempt-lifecycle")).toBe(true)
  })

  test("reuses native generation and attempt identity, without borrowing values across a rewind", () => {
    const event = (seq: number, generation: number, value: string) => wrap(seq, "native", "flows.engine.v2.attempt-lifecycle", {
      version: 2, executionId: "native", lineage: lineage(), stepKeyDigest: "same-step", attempt: 0,
      lifecycle: { state: "succeeded", startedAtMs: 10, finishedAtMs: 20, result: { _tag: "Success", value } }
    }, generation)
    const model = traceFromJournal(run, [event(1, 0, "old"), event(1, 0, "old"), event(2, 1, "new")])
    const attempts = model.rows.filter((row) => row.kind === "attempt")
    expect(attempts.map((row) => row.detail.output)).toEqual(["old", "new"])
    expect(new Set(attempts.map((row) => row.id)).size).toBe(2)
    expect(model.root.children).toHaveLength(2)
  })

  test("keeps gaps, foreign nested IDs and unreadable versions as evidence without making a successful result", () => {
    const records = [
      { sequence: 1, kind: "control.engine.projection-gap", occurredAt: 1, payload: { reason: "compacted", throughSequence: 6 } },
      { sequence: 2, kind: "control.engine.event", occurredAt: 2, payload: { version: 99, result: "made up" } },
      wrap(3, "native", "flows.engine.v2.state-event", { version: 2, executionId: "foreign", lineage: lineage("foreign"), event: { _tag: "Execution", lifecycle: { state: "completed", result: { _tag: "Success", value: "foreign result" } } } })
    ]
    const model = traceFromJournal(run, records)
    expect(model.rows.filter((row) => row.status === "unknown")).toHaveLength(2)
    expect(model.rows.every((row) => row.detail.output === undefined)).toBe(true)
    expect(model.rows.find((row) => row.kind === "execution")?.status).toBe("recorded")
  })

  test("does not nest under an ambiguous parent generation or recurse through cyclic evidence", () => {
    const records = [decision(1, "native"), decision(2, "native", undefined, undefined, undefined, 1), decision(3, "child", undefined, undefined, "native")]
    expect(traceFromJournal(run, records).root.children).toHaveLength(3)
    const cycle = [decision(1, "a", undefined, undefined, "b"), decision(2, "b", undefined, undefined, "a")]
    expect(traceFromJournal(run, cycle).root.children).toHaveLength(2)
  })
})

export { decision, wrap }
