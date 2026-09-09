/** Repository configuration of existing flows, catalog and Effect layers. */
import { Action, Flow, Interpreter } from "@smthrs/flow"
import type { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Option, Schema } from "effect"
import { catalogLayers } from "./catalog.ts"
import { CodingError, Plan, Result } from "./schema.ts"
import { ImplementPlan, policyLayers } from "./workflow.ts"

export const InvalidInput = Action.make("coding/refuse-input", {
  payload: {}, success: Result, error: CodingError
})
export const invalidInputLayer = InvalidInput.toLayer(() => Effect.fail(new CodingError({
  code: "invalid_plan", message: "Coding input must contain a valid predicted Change plan"
})))

/** Registry delegates receive the existing Invocation envelope, not raw input. */
export const RunPlan = Flow.make("coding/RunPlan", {
  payload: Executable.Invocation,
  success: Result,
  error: CodingError,
  body: ({ input }): Node.Node<Result, CodingError,
    Node.Services<ReturnType<typeof ImplementPlan.call>> | Action.Requirement<typeof InvalidInput.name>> => {
    const decoded = Schema.decodeUnknownOption(Schema.Struct({ plan: Plan }))(input)
    return Option.isSome(decoded)
      ? ImplementPlan.call(decoded.value)
      : InvalidInput.call({})
  }
})

/** Provide the deployment's catalog, then pass this registration to its runtime. */
export const registration = Layer.mergeAll(
  catalogLayers,
  invalidInputLayer,
  policyLayers,
  Interpreter.layer(ImplementPlan),
  Interpreter.layer(RunPlan)
).pipe(Layer.provideMerge(Action.layerImplementations))
