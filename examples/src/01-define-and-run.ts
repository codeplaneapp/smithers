/**
 * Define a typed flow and run it on the in-memory engine.
 *
 * This is the shortest complete program in the library, and it is the two nouns
 * of `docs/specs/Concepts/Unified Flow Authoring.md` at their smallest.
 * `Action.make` declares the atom that does the work — schemas and a stable
 * tag, no code — and `toLayer` attaches the implementation separately, where
 * the code can run. `Flow.make` declares the composite, and its `body` names
 * the action rather than calling it: a body is planned, so `Greet.call`
 * records one node and executes nothing.
 *
 * `Interpreter.layer` is what turns that plan into a run, over the
 * `Action.layerImplementations` table the implementation files itself in, and
 * `FlowEngine.layerMemory` supplies an engine that keeps its state in the
 * process.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

export const Greet = Action.make("examples/Greet", {
  payload: { name: Schema.String },
  success: Schema.String
})

export const Greeting = Flow.make("examples/Greeting", {
  payload: { name: Schema.String },
  success: Schema.String,
  body: (payload) => Greet.call(payload)
})

const GreetingLayer = Layer.mergeAll(
  Greet.toLayer(({ name }) => Effect.succeed(`Hello, ${name}.`)),
  Interpreter.layer(Greeting)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  // An action dispatch is recorded under a derived step identity, so the
  // engine needs a `Crypto` even in memory. A browser program supplies its own;
  // this one is Node.
  Layer.provideMerge(NodeCrypto.layer)
)

/**
 * Runs the flow under a caller-selected execution ID. The flow declares no
 * `idempotencyKey`, so an explicit id is required.
 */
export const main: Effect.Effect<string> = Greeting.execute(
  { name: "Ada" },
  { executionId: "greeting-ada-1" }
).pipe(
  // `execute` fails typed when a payload does not satisfy the flow's schema.
  // This example constructs a statically valid payload, so a refusal here
  // would be a defect in the example, not an error a caller handles.
  Effect.orDie,
  Effect.provide(GreetingLayer)
)
