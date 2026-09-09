import { Option, Schema } from "effect"
import * as Digest from "@smthrs/core/Digest"
import { CorrectionResult, Plan, RequestResult, validatePlan } from "../../../../../flows/coding/schema.ts"
import type { Card } from "../state/AppState"
import { engineExecutionEvidence, type EngineExecutionEvidence } from "./EngineTrace"
import type { JournalRecord } from "./RunTrace"

/** The repository recipe owns this contract; the UI does not maintain a second plan schema. */
const planOf = (value: unknown): Plan | undefined => {
  const decoded = Schema.decodeUnknownOption(Plan)(value)
  if (Option.isNone(decoded)) return undefined
  try {
    validatePlan(decoded.value)
    return decoded.value
  } catch {
    return undefined
  }
}

const decodeCorrection = Schema.decodeUnknownOption(CorrectionResult)
const decodeRequest = Schema.decodeUnknownOption(RequestResult)
const correctionOf = (value: unknown): typeof CorrectionResult.Type | undefined => {
  const decoded = decodeCorrection(value)
  if (Option.isNone(decoded)) return undefined
  const result = decoded.value
  if (result.rounds < 1) return undefined
  if (result.status === "blocked") return result.blocked?.executionId ? result : undefined
  return result.blocked === null && result.result?.status === result.status ? result : undefined
}

/** Derived projection only. The journal and persisted cursor remain the authority. */
export interface CodingEvidence {
  readonly plan?: Plan
  readonly outcome?: typeof CorrectionResult.Type
  readonly blockedSpanId?: string
}

export const codingEvidenceOf = (card: Extract<Card, { kind: "run-trace" }>): CodingEvidence => {
  const manual = planOf(card.payload.input?.plan)
  const cursor = card.payload.cursorSeq
  const records: ReadonlyArray<JournalRecord> = (card.payload.events ?? [])
    .filter((row) => Number.isSafeInteger(row.sequence) && Number(row.sequence) >= 0 &&
      (cursor === undefined || Number(row.sequence) <= cursor))
    .sort((left, right) => Number(left.sequence) - Number(right.sequence))
  const executions = engineExecutionEvidence(records)
  const generations = new Map<string, Array<EngineExecutionEvidence>>()
  for (const execution of executions) {
    const found = generations.get(execution.executionId) ?? []
    found.push(execution)
    generations.set(execution.executionId, found)
  }
  const current = (execution: EngineExecutionEvidence) => execution.coherent &&
    execution.generation === Math.max(...(generations.get(execution.executionId) ?? []).map((row) => row.generation))
  const belongs = (execution: EngineExecutionEvidence, rootId = card.payload.runId): boolean => {
    const visited = new Set<string>()
    let candidate: EngineExecutionEvidence | undefined = execution
    while (candidate !== undefined) {
      if (!candidate.coherent || !candidate.parentKnown || visited.has(candidate.executionId)) return false
      visited.add(candidate.executionId)
      if (candidate.executionId === rootId) return rootId !== card.payload.runId || candidate.parentExecutionId === undefined
      if (candidate.parentExecutionId === undefined) return false
      const parents: ReadonlyArray<EngineExecutionEvidence> = generations.get(candidate.parentExecutionId) ?? []
      // A child names a native parent ID, not its generation. Never infer a
      // parent generation from arrival time after a rewind.
      if (parents.length !== 1) return false
      candidate = parents[0]
    }
    return false
  }
  const completed = executions.filter((row) => current(row) && belongs(row) && row.status === "completed" && row.result !== undefined)
  const plans = completed.flatMap((execution) => {
    const request = execution.flowName === "coding/Request" ? decodeRequest(execution.result!.value) : Option.none()
    const plan = execution.flowName === "coding/PreparePlan" || execution.flowName === "coding/PrepareWithWiki"
      ? planOf(execution.result!.value)
      : Option.isSome(request) ? planOf(request.value.plan) : undefined
    return plan === undefined ? [] : [{ plan, sequence: execution.result!.sequence }]
  }).sort((left, right) => right.sequence - left.sequence)
  const newest = plans[0]
  const plan = newest === undefined ? manual : plans[1]?.sequence === newest.sequence ? undefined : newest.plan
  if (plan === undefined) return {}
  const planKey = Digest.canonical(plan)
  const outcomes = completed.flatMap((execution) => {
    const request = execution.flowName === "coding/Request" ? decodeRequest(execution.result!.value) : Option.none()
    const sourcePlan = Option.isSome(request) ? planOf(request.value.plan)
      : execution.flowName === "coding/CorrectPlan" && typeof execution.input === "object" && execution.input !== null
      ? planOf((execution.input as { readonly plan?: unknown }).plan) : undefined
    const outcome = Option.isSome(request) ? correctionOf(request.value.outcome)
      : execution.flowName === "coding/CorrectPlan" ? correctionOf(execution.result!.value) : undefined
    return sourcePlan === undefined || outcome === undefined || Digest.canonical(sourcePlan) !== planKey ||
        execution.result!.sequence < (newest?.sequence ?? 0)
      ? [] : [{ execution, outcome, sequence: execution.result!.sequence }]
  }).sort((left, right) => right.sequence - left.sequence)
  const latest = outcomes[0]
  if (latest === undefined || outcomes[1]?.sequence === latest.sequence) return { plan }
  const failed = latest.outcome.blocked === null ? [] : executions.filter((execution) =>
    execution.executionId === latest.outcome.blocked!.executionId && current(execution) &&
    execution.status === "failed" && belongs(execution, latest.execution.executionId))
  return { plan, outcome: latest.outcome, ...(failed.length === 1 ? { blockedSpanId: failed[0]!.spanId } : {}) }
}

export const codingPlanOf = (card: Extract<Card, { kind: "run-trace" }>): Plan | undefined => codingEvidenceOf(card).plan
