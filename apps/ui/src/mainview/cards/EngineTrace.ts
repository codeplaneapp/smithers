/** Recorded native evidence, decoded through the contracts that wrote it. */
import { RunState } from "@smthrs/engine-store/RunState"
import { ResultEncoded } from "@smthrs/flow/Flow"
import * as EngineEvent from "@smthrs/journal/EngineEvent"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import { Option, Schema } from "effect"
import type { JournalRecord, SpanDetail, TraceBuilder } from "./RunTrace"

// This is the private control bridge's envelope, not another engine contract.
const Envelope = Schema.Struct({
  version: Schema.Literal(1),
  executionId: JournalEvent.RunId,
  generation: JournalEvent.NonNegativeQuantity,
  sequence: JournalEvent.Seq,
  eventId: Schema.String,
  sourceId: JournalEvent.SourceId,
  sourceSequence: JournalEvent.SourceSeq,
  emittedAtMs: JournalEvent.TimestampMs,
  eventType: Schema.NonEmptyString,
  payload: Schema.Json,
  meta: Schema.Json
})
type Envelope = typeof Envelope.Type

const decodeEnvelope = Schema.decodeUnknownOption(Envelope)
const decodeAttempt = Schema.decodeUnknownOption(EngineEvent.AttemptPayload, { onExcessProperty: "error" })
const decodeState = Schema.decodeUnknownOption(EngineEvent.StatePayload, { onExcessProperty: "error" })
const decodeMarker = Schema.decodeUnknownOption(EngineEvent.CurrentAttempt)
const decodeDecision = Schema.decodeUnknownOption(Schema.Struct({
  decision: Schema.Literals(["created", "transitioned"]),
  status: Schema.optionalKey(Schema.Literals(["pending", "running", "suspended", "completed", "failed", "cancelled"])),
  state: RunState
}))
const decodeResult = Schema.decodeUnknownOption(ResultEncoded, { onExcessProperty: "error" })

const json = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value) ?? "null"
const identity = (...parts: ReadonlyArray<string | number>) => parts.map((part) => encodeURIComponent(String(part))).join(":")
const span = (id: string, kind: TraceBuilder["kind"], label: string, at: number, detail: SpanDetail): TraceBuilder => ({
  id, kind, label, status: "recorded", startedAt: at, children: [], detail
})
const detail = (row: JournalRecord, envelope: Envelope): SpanDetail => ({
  sequence: row.sequence,
  event: envelope.eventType,
  fields: { ...envelope }
})
interface Execution {
  readonly envelope: Envelope
  readonly span: TraceBuilder
  parentId?: string
}
const decodeProjection = Schema.decodeUnknownOption(Schema.Struct({
  version: Schema.Literal(1), executionId: JournalEvent.RunId, generation: JournalEvent.NonNegativeQuantity
}))

/** Observation completion is separate from the control run's terminal verdict. */
export const engineProjectionPending = (records: ReadonlyArray<JournalRecord> = []): boolean => {
  const states = new Map<string, { generation: number; pending: boolean }>()
  for (const row of [...records].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))) {
    if (row.kind === "control.engine.projection-gap") {
      // The gap is rendered as missing evidence. Stop polling rather than
      // disguising an observation failure as an indefinitely running task.
      for (const state of states.values()) state.pending = false
      continue
    }
    if (row.kind !== "control.engine.projection-started" && row.kind !== "control.engine.projection-settled") continue
    const decoded = decodeProjection(row.payload)
    if (Option.isNone(decoded)) continue
    const { executionId, generation } = decoded.value
    const current = states.get(executionId)
    if (row.kind === "control.engine.projection-started") {
      if (current === undefined || generation > current.generation) states.set(executionId, { generation, pending: true })
    } else if (current?.generation === generation) current.pending = false
  }
  return [...states.values()].some((state) => state.pending)
}

/**
 * Generations never share attempt identity. Native timestamps describe native
 * work; the outer control sequence still determines the historical UI cursor.
 * Only recorded parent IDs can nest executions. Ambiguous parent generations
 * remain beside the root instead of guessing which historical parent owned them.
 */
export const engineTraceFromJournal = (records: ReadonlyArray<JournalRecord>): Array<TraceBuilder> => {
  const executions = new Map<string, Execution>()
  const attempts = new Map<string, TraceBuilder>()
  const notices: Array<TraceBuilder> = []
  const seen = new Set<string>()
  for (const row of records) {
    if (row.kind === "control.engine.projection-gap") {
      const notice = span(`engine-gap:${row.sequence ?? notices.length}`, "event", "Engine evidence gap", row.occurredAt ?? 0, {
        sequence: row.sequence, event: row.kind, fields: { evidence: row.payload }
      })
      notice.status = "unknown"
      notice.endedAt = notice.startedAt
      notices.push(notice)
      continue
    }
    if (row.kind !== "control.engine.event") continue
    const decoded = decodeEnvelope(row.payload)
    if (Option.isNone(decoded)) {
      const notice = span(`engine-invalid:${row.sequence ?? notices.length}`, "event", "Unreadable engine evidence", row.occurredAt ?? 0, {
        sequence: row.sequence, event: row.kind, fields: { evidence: row.payload }
      })
      notice.status = "unknown"
      notice.endedAt = notice.startedAt
      notices.push(notice)
      continue
    }
    const envelope = decoded.value
    const key = identity(envelope.executionId, envelope.generation)
    const eventKey = identity(key, envelope.sequence)
    if (seen.has(eventKey)) continue
    seen.add(eventKey)
    let execution = executions.get(key)
    if (execution === undefined) {
      execution = {
        envelope,
        span: span(`engine:${key}`, "execution", envelope.executionId, envelope.emittedAtMs, detail(row, envelope))
      }
      executions.set(key, execution)
    }
    const generic = () => {
      const event = span(`engine-event:${eventKey}`, "event", envelope.eventType, envelope.emittedAtMs, detail(row, envelope))
      event.endedAt = event.startedAt
      execution.span.children.push(event)
    }
    const attempt = (step: string, number: number) => {
      const attemptKey = identity(key, step, number)
      let current = attempts.get(attemptKey)
      if (current === undefined) {
        current = span(`engine-attempt:${attemptKey}`, "attempt", `attempt ${number} · ${step.slice(0, 12)}`, envelope.emittedAtMs, detail(row, envelope))
        attempts.set(attemptKey, current)
        execution.span.children.push(current)
      }
      return current
    }
    if (envelope.eventType === "flows.engine.attempt-started" || envelope.eventType === "flows.engine.attempt-finished") {
      const marker = decodeMarker({ eventType: envelope.eventType, payload: envelope.payload })
      if (Option.isNone(marker) || marker.value.payload.runId !== envelope.executionId) { generic(); continue }
      const current = attempt(marker.value.payload.stepKeyDigest, marker.value.payload.attempt)
      if (marker.value.eventType === "flows.engine.attempt-started") current.status = "running"
      else {
        current.status = marker.value.payload.state === "succeeded" ? "completed" : "failed"
        current.endedAt = envelope.emittedAtMs
      }
      current.detail = { ...current.detail, fields: { ...envelope } }
      continue
    }
    if (envelope.eventType === EngineEvent.attemptEventType) {
      const recorded = decodeAttempt(envelope.payload)
      if (Option.isNone(recorded) || recorded.value.executionId !== envelope.executionId) { generic(); continue }
      const { lifecycle, lineage, stepKeyDigest, attempt: number } = recorded.value
      execution.parentId = lineage.parentRunId ?? undefined
      const current = attempt(stepKeyDigest, number)
      current.startedAt = lifecycle.startedAtMs
      current.status = lifecycle.state === "succeeded" ? "completed" : lifecycle.state === "suspended" ? "waiting" : lifecycle.state
      current.detail = { ...detail(row, envelope), sequence: current.detail.sequence }
      if (lifecycle.state === "succeeded" || lifecycle.state === "failed") {
        current.endedAt = lifecycle.finishedAtMs
        current.detail = {
          ...current.detail,
          ...(lifecycle.result._tag === "Success" ? { output: json(lifecycle.result.value) } : { message: json(lifecycle.result.detail) })
        }
      }
      continue
    }
    if (envelope.eventType === EngineEvent.stateEventType) {
      const recorded = decodeState(envelope.payload)
      if (Option.isNone(recorded) || recorded.value.executionId !== envelope.executionId) { generic(); continue }
      execution.parentId = recorded.value.lineage.parentRunId ?? undefined
      if (recorded.value.event._tag !== "Execution") { generic(); continue }
      const { lifecycle } = recorded.value.event
      execution.span.detail = { ...detail(row, envelope), sequence: execution.span.detail.sequence }
      if (lifecycle.state === "completed") {
        execution.span.status = lifecycle.result._tag === "Success" ? "completed" : "failed"
        execution.span.endedAt = envelope.emittedAtMs
        execution.span.detail = {
          ...execution.span.detail,
          ...(lifecycle.result._tag === "Success" ? { output: json(lifecycle.result.value) } : { message: json(lifecycle.result.detail) })
        }
      } else execution.span.status = lifecycle.state === "suspended" ? "waiting" : "running"
      continue
    }
    if (envelope.eventType === "flows.engine.run-decision") {
      const decision = decodeDecision(envelope.payload)
      if (Option.isNone(decision)) { generic(); continue }
      const { state, status } = decision.value
      execution.span.label = state.flowName
      execution.parentId = state.parentExecutionId
      execution.span.detail = { ...detail(row, envelope), sequence: execution.span.detail.sequence, input: state.payload }
      if (decision.value.decision === "created") execution.span.status = "pending"
      else if (status === "running" || status === "pending" || status === "suspended") {
        execution.span.status = status === "suspended" ? "waiting" : status
      } else if (status !== undefined) {
        const result = decodeResult(state.result)
        if (Option.isNone(result) || result.value._tag !== "Complete" ||
          (status === "completed") !== (result.value.exit._tag === "Success")) {
          execution.span.status = "unknown"
          generic()
          continue
        }
        execution.span.status = status
        execution.span.endedAt = envelope.emittedAtMs
        execution.span.detail = {
          ...execution.span.detail,
          ...(result.value.exit._tag === "Success" ? { output: json(result.value.exit.value) } : { message: json(result.value.exit.cause) })
        }
      }
      continue
    }
    generic()
  }
  const byExecution = new Map<string, Array<Execution>>()
  for (const current of executions.values()) {
    const generations = byExecution.get(current.envelope.executionId) ?? []
    generations.push(current)
    byExecution.set(current.envelope.executionId, generations)
  }
  const roots: Array<TraceBuilder> = []
  for (const current of executions.values()) {
    const parents = current.parentId === undefined ? [] : byExecution.get(current.parentId) ?? []
    // Build only a forest. Malformed cycles remain separate evidence rows.
    const ancestors = new Set<string>([current.envelope.executionId])
    let parent = parents.length === 1 ? parents[0] : undefined
    let cursor = parent
    while (cursor !== undefined) {
      if (ancestors.has(cursor.envelope.executionId)) { parent = undefined; break }
      ancestors.add(cursor.envelope.executionId)
      const next = cursor.parentId === undefined ? [] : byExecution.get(cursor.parentId) ?? []
      cursor = next.length === 1 ? next[0] : undefined
    }
    if (parent === undefined) roots.push(current.span)
    else parent.span.children.push(current.span)
  }
  return [...roots, ...notices]
}
