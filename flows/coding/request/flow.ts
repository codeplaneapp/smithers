import { Flow } from "@smthrs/core"
import { RequestInput, RequestResult } from "../schema.ts"

export default Flow.make({
  description: "Plan a coding request from repository memory, clarify material questions, and implement native Changes with bounded owner correction.",
  input: RequestInput,
  output: RequestResult,
  capabilities: ["*"],
  flows: ["coding/RunRequest"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})
