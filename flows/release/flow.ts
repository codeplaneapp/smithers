import { Flow } from "@smthrs/core"
import { ReleaseInput, ReleaseResult } from "../release-support/schema.ts"

export default Flow.make({
  description: "Prepare a Smithers release or validate, build, smoke-test and publish its exact npm tarballs with durable human approval.",
  input: ReleaseInput,
  output: ReleaseResult,
  capabilities: ["*"],
  flows: ["smithers/Release"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})
