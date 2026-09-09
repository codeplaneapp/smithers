import { Flow } from "@smthrs/core"
import { Schema } from "effect"
import { Plan, Result } from "./schema.ts"

export default Flow.make({
  description: "Implement a predicted linear Change plan with fast gates and asynchronous slow validation through the repository's registered flows.",
  input: Schema.Struct({ plan: Plan }),
  output: Result,
  capabilities: ["*"],
  flows: ["coding/RunPlan"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "sealed" }
})
