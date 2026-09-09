import * as JournalRecords from "../../../../../../packages/smithers/flows/engine-store/src/internal/JournalRecords.ts"
import { CODING_PLAN } from "./CodingPlan"

/** Synthetic native records made with the production journal writer. */
export const codingDecision = (sequence: number, executionId: string, flowName: string, options: {
  readonly parent?: string
  readonly status?: "running" | "completed" | "failed"
  readonly value?: unknown
  readonly input?: unknown
  readonly generation?: number
} = {}) => {
  const record = JournalRecords.runDecision({ runId: executionId, sourceId: "engine", lineageId: executionId }, {
    decision: options.status === undefined ? "created" : "transitioned",
    ...(options.status === undefined ? {} : { status: options.status }),
    state: {
      version: 1, flowName, payload: options.input ?? {},
      ...(options.parent === undefined ? {} : { parentExecutionId: options.parent }),
      ...(options.status === "completed" ? { result: { _tag: "Complete", exit: { _tag: "Success", value: options.value } } }
        : options.status === "failed" ? { result: { _tag: "Complete", exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: options.value ?? "check failed" }] } } } : {})
    }
  })
  return {
    sequence, occurredAt: sequence * 100, kind: "control.engine.event",
    payload: { version: 1, executionId, generation: options.generation ?? 0,
      sequence, eventId: `${executionId}/${options.generation ?? 0}/${sequence}`, sourceId: "engine", sourceSequence: sequence,
      emittedAtMs: sequence * 100, eventType: record.eventType, payload: record.payload, meta: {} }
  }
}

export const preparedCodingJournal = (plan = CODING_PLAN) => [
  codingDecision(1, "run-1", "agent/run"),
  codingDecision(2, "request", "coding/Request", { parent: "run-1", status: "running" }),
  codingDecision(3, "prepare", "coding/PreparePlan", { parent: "request", status: "running" }),
  codingDecision(4, "prepare", "coding/PreparePlan", { parent: "request", status: "completed", value: plan }),
  codingDecision(5, "correct", "coding/CorrectPlan", { parent: "request", status: "running", input: { plan, maxRounds: 2 } })
]

export const blockedCorrection = { status: "blocked" as const, rounds: 1, result: null,
  blocked: { executionId: "failed-round", message: "The required fast check failed." } }

export const blockedCodingJournal = () => [
  ...preparedCodingJournal(),
  codingDecision(6, "failed-round", "coding/ImplementPlan", { parent: "correct", status: "running" }),
  codingDecision(7, "failed-round", "coding/ImplementPlan", { parent: "correct", status: "failed", value: "The required fast check failed." }),
  codingDecision(8, "correct", "coding/CorrectPlan", { parent: "request", status: "completed", input: { plan: CODING_PLAN, maxRounds: 2 }, value: blockedCorrection }),
  codingDecision(9, "request", "coding/Request", { parent: "run-1", status: "completed", value: { plan: CODING_PLAN, outcome: blockedCorrection } })
]
