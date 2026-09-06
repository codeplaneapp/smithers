import { Flow } from "@smthrs/core"
import { ContentInput, ContentResult } from "../release-support/schema.ts"

export default Flow.make({
  description: "Analyze a release, draft changelog/blog/thread content, revise against quality gates, render previews and wait for approval before publication.",
  input: ContentInput,
  output: ContentResult,
  capabilities: ["*"],
  flows: ["smithers/ReleaseContent"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})
