import { Flow } from "@smthrs/core"
import { RequestInput, RequestResult } from "../schema.ts"

export default Flow.make({
  description: "Refresh verified repository memory, plan, retain a disposable prototype, replan from its feedback, and implement native Changes with bounded owner correction.",
  input: RequestInput,
  output: RequestResult,
  capabilities: ["*"],
  flows: ["coding/RunRequest"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})
