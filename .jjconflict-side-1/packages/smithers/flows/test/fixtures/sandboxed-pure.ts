/**
 * An entry module with no `layer`: its one flow names no action, so the guest
 * runner has nothing to provide beside the interpreter.
 */
import { Flow } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"

/** Answers its payload back. */
export const Constant = Flow.make("flows/SandboxedFlow/fixtures/Constant", {
  payload: { value: Schema.String },
  success: Schema.String,
  body: (payload) => Node.succeed(payload.value)
})
