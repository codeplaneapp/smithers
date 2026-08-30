/**
 * The stable wire rows the gateway serves for each projection, and the pure
 * folds that compute them from control-plane facts.
 *
 * These rows are the whole read contract. Nothing here exposes a store row, a
 * database column, or an engine type: every field is either a
 * `@smthrs/control` projection value or something folded out of the ordered
 * `ControlEvent` deltas `Control.watch` publishes. Wire names are the flows
 * names — `flowId`, `createdAt`, and the `ApprovalTarget.Node` envelope — so a
 * client written against the control plane reads these rows without a
 * translation table.
 *
 * @since 1.0.0
 */
import { ControlSchema } from "@smthrs/control"
import { Schema } from "effect"
import * as Diagnosis from "./Diagnosis.ts"

/**
 * One run, everything a run card displays, and the diagnosis of what happened
 * to it.
 *
 * `flowId` carries what the old wire split across `run.workflowKey` and
 * `run.workflow`, and `createdAt` carries `run.createdAtMs`: one flows name
 * each, rather than two spellings of one fact.
 *
 * @since 1.0.0
 * @category models
 */
export const RunSummaryRow = Schema.Struct({
  runId: Schema.String,
  flowId: Schema.String,
  status: ControlSchema.RunStatus,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  planId: Schema.optional(Schema.String),
  planDigest: Schema.optional(Schema.String),
  parentRunId: Schema.optional(Schema.String),
  lineageId: Schema.optional(Schema.String),
  roundOrdinal: Schema.optional(Schema.Number),
  waitingReason: Schema.optional(Schema.String),
  steeringPending: Schema.optional(Schema.Number),
  cancellation: Schema.optional(ControlSchema.Cancellation),
  /** The model seat the run's last opened turn ran on. */
  seat: Schema.optional(Schema.String),
  turns: Schema.Number,
  calls: Schema.Number,
  callsFailed: Schema.Number,
  editsAttempted: Schema.Number,
  editsSucceeded: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  /** One line: the status plus the reason that most explains it. */
  verdict: Schema.String,
  /** The whole diagnosis card, which the old wire called `whatHappened`. */
  diagnosis: Schema.String,
  finalOutput: Schema.optional(Schema.String)
})

/**
 * One run, everything a run card displays, and its diagnosis.
 *
 * @since 1.0.0
 * @category models
 */
export type RunSummaryRow = typeof RunSummaryRow.Type

/**
 * One node of a run, as a tree view renders it.
 *
 * `label` carries what the old wire called `node.cardLabel`, and `seat`
 * carries `node.agent`: the model seat is the flows name for who ran a node.
 *
 * @since 1.0.0
 * @category models
 */
export const RunTreeRow = Schema.Struct({
  runId: Schema.String,
  nodeId: Schema.String,
  label: Schema.String,
  status: Schema.Literals(["running", "completed", "failed"]),
  seat: Schema.optional(Schema.String),
  startedAt: Schema.Number,
  endedAt: Schema.optional(Schema.Number),
  parentRunId: Schema.optional(Schema.String)
})

/**
 * One node of a run, as a tree view renders it.
 *
 * @since 1.0.0
 * @category models
 */
export type RunTreeRow = typeof RunTreeRow.Type

/**
 * One approval a run is parked on, carrying the exact payload that decides it.
 *
 * `title` carries the old `approval.requestTitle` and `request` the old
 * `approval.request`; `payload` is the `ApprovalTarget.Node` envelope a client
 * submits back unchanged, so no client reconstructs authority.
 *
 * @since 1.0.0
 * @category models
 */
export const ApprovalRow = Schema.Struct({
  runId: Schema.String,
  requestId: Schema.String,
  title: Schema.String,
  request: Schema.Json,
  payload: ControlSchema.ApprovalPayload,
  requestedAt: Schema.Number,
  status: Schema.Literals(["pending", "approved", "denied"])
})

/**
 * One approval a run is parked on.
 *
 * @since 1.0.0
 * @category models
 */
export type ApprovalRow = typeof ApprovalRow.Type

/**
 * The output one node produced.
 *
 * @since 1.0.0
 * @category models
 */
export const NodeOutputRow = Schema.Struct({
  runId: Schema.String,
  nodeId: Schema.String,
  outcome: Schema.Literals(["success", "failure"]),
  output: Schema.String,
  settledAt: Schema.Number
})

/**
 * The output one node produced.
 *
 * @since 1.0.0
 * @category models
 */
export type NodeOutputRow = typeof NodeOutputRow.Type

/**
 * One line of a run's turn-by-turn transcript.
 *
 * @since 1.0.0
 * @category models
 */
export const TranscriptRow = Schema.Struct({
  runId: Schema.String,
  sequence: Schema.Number,
  turn: Schema.Number,
  at: Schema.Number,
  kind: Schema.String,
  text: Schema.String
})

/**
 * One line of a run's turn-by-turn transcript.
 *
 * @since 1.0.0
 * @category models
 */
export type TranscriptRow = typeof TranscriptRow.Type

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const asString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

const asNumber = (value: unknown): number | undefined => typeof value === "number" ? value : undefined

const timeOf = (event: ControlSchema.ControlEvent): number => asNumber(asRecord(event.payload).at) ?? event.occurredAt

/** Copies only the optional fields a run summary actually carries. */
const optional = <A>(key: string, value: A | undefined): Record<string, A> =>
  value === undefined ? {} : { [key]: value }

/**
 * Folds one run's summary and events into the served `run-summary` row.
 *
 * @param run the control-plane run summary
 * @param events that run's ordered control events
 * @since 1.0.0
 * @category projections
 */
export const runSummary = (
  run: ControlSchema.RunSummary,
  events: ReadonlyArray<ControlSchema.ControlEvent>
): RunSummaryRow => {
  const facts = Diagnosis.digest(events)
  return {
    runId: run.runId,
    flowId: run.flowId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...optional("planId", run.planId),
    ...optional("planDigest", run.planDigest),
    ...optional("parentRunId", run.parentRunId),
    ...optional("lineageId", run.lineageId),
    ...optional("roundOrdinal", run.roundOrdinal),
    ...optional("waitingReason", run.waitingReason),
    ...optional("steeringPending", run.steering?.pending),
    ...optional("cancellation", run.cancellation),
    ...optional("seat", facts.seat),
    turns: facts.turns,
    calls: facts.calls,
    callsFailed: facts.callsFailed,
    editsAttempted: facts.editsAttempted,
    editsSucceeded: facts.editsSucceeded,
    inputTokens: facts.inputTokens,
    outputTokens: facts.outputTokens,
    verdict: Diagnosis.verdict(facts),
    diagnosis: Diagnosis.render({ runId: run.runId, ...optional("flowId", run.flowId) }, facts),
    ...optional("finalOutput", facts.finalOutput)
  }
}

/**
 * Folds one run's events into its node rows.
 *
 * A node opens on `control.agent.cell-call-started` and settles on the
 * matching `control.agent.cell-call-settled`; a node that never settled stays
 * `running`, which is how a live tree renders work in flight.
 *
 * @param run the control-plane run summary
 * @param events that run's ordered control events
 * @since 1.0.0
 * @category projections
 */
export const runTree = (
  run: ControlSchema.RunSummary,
  events: ReadonlyArray<ControlSchema.ControlEvent>
): ReadonlyArray<RunTreeRow> => {
  const rows = new Map<string, RunTreeRow>()
  let seat: string | undefined
  let ordinal = 0
  for (const event of events) {
    const payload = asRecord(event.payload)
    if (event.kind === "control.agent.turn-opened") {
      seat = asString(payload.seat) ?? seat
      continue
    }
    if (event.kind === "control.agent.cell-call-started") {
      ordinal += 1
      const nodeId = asString(payload.nodeId) ?? `call-${ordinal}`
      rows.set(nodeId, {
        runId: run.runId,
        nodeId,
        label: asString(payload.flowName) ?? nodeId,
        status: "running",
        ...optional("seat", seat),
        startedAt: timeOf(event),
        ...optional("parentRunId", run.parentRunId)
      })
      continue
    }
    if (event.kind === "control.agent.cell-call-settled") {
      const nodeId = asString(payload.nodeId) ?? `call-${ordinal}`
      const open = rows.get(nodeId)
      if (open === undefined) continue
      rows.set(nodeId, {
        ...open,
        status: asString(payload.outcome) === "failure" ? "failed" : "completed",
        endedAt: timeOf(event)
      })
    }
  }
  return [...rows.values()]
}

/**
 * Folds one run's events into its approval rows.
 *
 * A request opens a pending row carrying the submit-ready payload; the
 * matching `control.approval.approved` or `control.approval.denied` closes it
 * without discarding the request, so a decided gate stays readable.
 *
 * @param events the run's ordered control events
 * @since 1.0.0
 * @category projections
 */
export const approvals = (
  events: ReadonlyArray<ControlSchema.ControlEvent>
): ReadonlyArray<ApprovalRow> => {
  const rows = new Map<string, ApprovalRow>()
  for (const event of events) {
    const payload = asRecord(event.payload)
    if (event.kind === "control.approval.requested") {
      const requestId = asString(payload.requestId)
      const runId = asString(payload.runId) ?? event.runId
      const submitted = payload.payload
      if (requestId === undefined || runId === undefined || submitted === undefined) continue
      const question = asString(payload.question) ?? `Approval needed — ${requestId}`
      rows.set(requestId, {
        runId,
        requestId,
        title: question,
        request: payload as never,
        payload: submitted as ControlSchema.ApprovalPayload,
        requestedAt: timeOf(event),
        status: "pending"
      })
      continue
    }
    if (event.kind === "control.approval.approved" || event.kind === "control.approval.denied") {
      const decided = event.kind === "control.approval.approved" ? "approved" as const : "denied" as const
      for (const [requestId, row] of rows) {
        if (row.status === "pending") rows.set(requestId, { ...row, status: decided })
      }
    }
  }
  return [...rows.values()]
}

/**
 * Folds one run's events into its node outputs.
 *
 * @param events the run's ordered control events
 * @since 1.0.0
 * @category projections
 */
export const nodeOutput = (
  events: ReadonlyArray<ControlSchema.ControlEvent>
): ReadonlyArray<NodeOutputRow> => {
  const rows = new Map<string, NodeOutputRow>()
  let ordinal = 0
  for (const event of events) {
    const payload = asRecord(event.payload)
    if (event.kind === "control.agent.cell-call-started") {
      ordinal += 1
      continue
    }
    if (event.kind !== "control.agent.cell-call-settled") continue
    const runId = asString(payload.runId) ?? event.runId
    if (runId === undefined) continue
    const nodeId = asString(payload.nodeId) ?? `call-${ordinal}`
    const failed = asString(payload.outcome) === "failure"
    rows.set(nodeId, {
      runId,
      nodeId,
      outcome: failed ? "failure" : "success",
      output: failed
        ? asString(payload.message) ?? ""
        : asString(payload.value) ?? JSON.stringify(payload.value ?? null),
      settledAt: timeOf(event)
    })
  }
  return [...rows.values()]
}

/** Events the transcript reports verbatim rather than as agent activity. */
const transcriptKinds: ReadonlySet<string> = new Set(["control.approval.requested"])

/**
 * Folds one run's events into a turn-numbered transcript.
 *
 * @param events the run's ordered control events
 * @since 1.0.0
 * @category projections
 */
export const transcript = (
  events: ReadonlyArray<ControlSchema.ControlEvent>
): ReadonlyArray<TranscriptRow> => {
  const rows: Array<TranscriptRow> = []
  let turn = 0
  for (const event of events) {
    const payload = asRecord(event.payload)
    const runId = asString(payload.runId) ?? event.runId
    if (runId === undefined) continue
    const reported = event.kind.startsWith("control.run.") ||
      event.kind.startsWith("control.agent.") ||
      transcriptKinds.has(event.kind)
    if (!reported) continue
    if (event.kind === "control.agent.turn-opened") turn += 1
    rows.push({
      runId,
      sequence: event.sequence,
      turn,
      at: timeOf(event),
      kind: event.kind,
      text: line(event.kind, payload)
    })
  }
  return rows
}

/** One event as a single transcript line. */
const line = (kind: string, payload: Record<string, unknown>): string => {
  switch (kind) {
    case "control.agent.turn-opened":
      return `turn opened · ${asString(payload.seat) ?? ""}`
    case "control.agent.model-settled": {
      const usage = asRecord(payload.usage)
      return `model ${asNumber(usage.inputTokens) ?? 0} in / ${asNumber(usage.outputTokens) ?? 0} out`
    }
    case "control.agent.cell-call-started":
      return `call ${asString(payload.flowName) ?? "?"}`
    case "control.agent.cell-call-settled":
      return asString(payload.outcome) === "failure"
        ? `  -> FAIL ${Diagnosis.clip(asString(payload.message) ?? "", 100)}`
        : "  -> ok"
    case "control.agent.resolved":
      return `resolved ${Diagnosis.clip(asString(payload.text) ?? "", 100)}`
    case "control.approval.requested":
      return `approval requested: ${asString(payload.question) ?? ""}`
    default:
      return kind.slice("control.".length)
  }
}
