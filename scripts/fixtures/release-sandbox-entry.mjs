import { Flow } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"

export const Echo = Flow.make("release/SandboxEcho", {
  payload: { value: Schema.String },
  success: Schema.String,
  body: ({ value }) => Node.succeed(value)
})
