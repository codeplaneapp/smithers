import { Schema } from "effect"

// Archived wire declaration from 580c67600b^:packages/smithers/agent/harness/src/Cell.ts.
// Keep this independent of the current Cell module: it writes the pre-A2 fixture.
const CallFailureCode = Schema.Literals([
  "unknown_flow",
  "capability_refused",
  "truncated_write",
  "declaration_changed",
  "invalid_input",
  "unimplemented",
  "timeout",
  "run_completed",
  "checkpoint_unavailable",
  "checkpoint_exhausted",
  "checkpoint_readonly",
  "checkpoint_unsupported",
  "flow_failed"
])

export class CallResult extends Schema.Class<CallResult>("flows/harness/Cell/CallResult")({
  outcome: Schema.Literals(["success", "failure"]),
  value: Schema.Json,
  message: Schema.optional(Schema.String),
  code: Schema.optional(CallFailureCode)
}) {}

// The material carries the HarnessError code set on main, which gained
// `incompatible_journal` with journal format 2. This is the key main's
// StepKeyGolden pins for the same call.
export const key = "key1_8ab2962732794ee8d8b3bf550657b41d475fd082ec9c8c7073b1d24a8d77d4b9"

// Independent JSON oracle. This fixture contains only JSON values, no schema
// classes, undefined, non-finite numbers or other normalization cases.
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([name, child]) => `${JSON.stringify(name)}:${canonical(child)}`).join(",")
    }}`
  }
  return JSON.stringify(value)
}
