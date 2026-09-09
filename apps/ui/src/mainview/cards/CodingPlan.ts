import { Option, Schema } from "effect"
import { Plan, validatePlan } from "../../../../../flows/coding/schema.ts"
import type { Card } from "../state/AppState"

/** The repository recipe owns this contract; the UI does not maintain a second plan schema. */
export const codingPlanOf = (card: Extract<Card, { kind: "run-trace" }>): Plan | undefined => {
  const decoded = Schema.decodeUnknownOption(Plan)(card.payload.input?.plan)
  if (Option.isNone(decoded)) return undefined
  try {
    validatePlan(decoded.value)
    return decoded.value
  } catch {
    return undefined
  }
}
