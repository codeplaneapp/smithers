/** The repository's prompt entry composes existing planning and correction flows. */
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Option, Schema } from "effect"
import { CorrectPlan } from "./correction.ts"
import { PreparePlan } from "./planning.ts"
import { CodingError, RequestInput, RequestResult } from "./schema.ts"
export { RequestInput } from "./schema.ts"
import { AdmitSource } from "./source-admission.ts"

export const Request = Flow.make("coding/Request", {
  payload: RequestInput, success: RequestResult, error: PreparePlan.errorSchema,
  body: input => PreparePlan.child({ prompt: input.prompt, feedback: input.feedback ?? "" }).pipe(
    Node.bindPlanned(plan => AdmitSource.call({ plan })),
    Node.bindPlanned(plan => Node.all({ plan: Node.succeed(plan), outcome: CorrectPlan.child({ plan, maxRounds: input.maxRounds ?? 3 }) }))
  )
})
const RefuseRequest = Action.make("coding/refuse-request", {
  payload: {}, success: RequestResult, error: CodingError
})
export const RunRequest = Flow.make("coding/RunRequest", {
  payload: Executable.Invocation, success: RequestResult, error: Request.errorSchema,
  body: invocation => {
    const decoded = Schema.decodeUnknownOption(RequestInput)(invocation.input)
    return Option.isSome(decoded) ? Request.child(decoded.value) : RefuseRequest.call({})
  }
})
export const requestRegistration = Layer.mergeAll(
  Interpreter.layer(Request), Interpreter.layer(RunRequest),
  RefuseRequest.toLayer(() => Effect.fail(new CodingError({ code: "invalid_plan", message: "A coding request needs a prompt and an optional correction limit of 1..8" })))
)
