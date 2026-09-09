import { Flow } from "@smthrs/core"
import { Schema } from "effect"
import { Change, Implementation, Revision } from "../schema.ts"

export default Flow.make({
  description: "Implement one planned Change as native JJ atoms, preserving existing identities and recording exact revision evidence.",
  input: Schema.Struct({ change: Change, parent: Revision, memoryRevision: Schema.NonEmptyString }),
  output: Implementation,
  capabilities: ["*"],
  flows: ["coding/Implement"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})
