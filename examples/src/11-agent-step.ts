/**
 * A model-backed step with a typed output schema, chained into another one.
 *
 * This is the flows form of a two-step research-then-write workflow: the first
 * step asks a model to research a topic and hands back `{ summary, keyPoints }`,
 * the second turns that into an article. Both are model calls, and neither is
 * special topology — `docs/specs/Concepts/Unified Flow Authoring.md` says a
 * model call is an ordinary action, so `AgentAction.make` declares one exactly
 * the way `Action.make` declares any other. The difference is that the author
 * does not write `toLayer`: a model call has one implementation, it runs the
 * cell loop, and it ships with the declaration as `.layer`.
 *
 * What the author declares is the seat, the system teaching, the prompt built
 * from the step payload, and the `output` schema. That schema is enforced:
 * it is rendered into the run's system teaching as JSON Schema, and the agent's
 * final answer is decoded by it, with one correction re-prompt before the step
 * fails `StructuredOutputFailure`. A downstream step therefore reads
 * `research.summary` as a `string`, not as text somebody has to parse.
 *
 * The host half is two services. `AgentAction.Host` carries the registry a cell
 * may call into and the sandbox budget every model-backed action in the
 * composition shares; `SeatResolver` turns the declared seat string into a live
 * model, and it is the only place a credential would appear. This example
 * resolves every seat to a scripted model, which is why it runs in CI with no
 * API key. Point the resolver at a real provider route and nothing above it
 * changes.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

const ResearchResult = Schema.Struct({
  summary: Schema.String,
  keyPoints: Schema.Array(Schema.String)
})

const ArticleResult = Schema.Struct({
  article: Schema.String,
  wordCount: Schema.Number
})

/** The research step: a model call whose answer must be a `ResearchResult`. */
export const Research = AgentAction.make("examples/Research", {
  payload: { topic: Schema.String },
  output: ResearchResult,
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You are a research assistant. Provide concise, accurate summaries."],
  prompt: ({ topic }) => `Research the topic "${topic}" and report what matters about it.`
})

/** The writing step, which consumes the first step's typed fields. */
export const Write = AgentAction.make("examples/Write", {
  payload: {
    summary: Schema.String,
    keyPoints: Schema.Array(Schema.String)
  },
  output: ArticleResult,
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You are a technical writer. Write clear, engaging content."],
  prompt: ({ keyPoints, summary }) =>
    `Write a short article from this research.\n\nSummary: ${summary}\n\nKey points:\n${
      keyPoints.map((point) => `- ${point}`).join("\n")
    }`
})

/**
 * The workflow. Nothing executes at plan time: `Research.call` records one
 * node, and `Node.andThen` feeds its planned result into `Write.call`.
 */
export const SimpleWorkflow = Flow.make("examples/SimpleWorkflow", {
  payload: { topic: Schema.String },
  success: ArticleResult,
  error: AgentAction.AgentFailure,
  body: ({ topic }) =>
    Research.call({ topic }).pipe(
      Node.andThen((research) => Write.call({ summary: research.summary, keyPoints: research.keyPoints }))
    )
})

const prepared: Route.PreparedRequest = {
  routeId: "examples",
  protocolId: "examples",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

/**
 * A scripted model: it answers each call with one fenced `cell` block.
 *
 * A cell does not return its transition. It runs in a REPL realm that outlives
 * the frame and states its intent by calling: `ctx.done(output)` completes the
 * run, `ctx.park(reason, message)` waits durably, and a cell that calls neither
 * gets another frame. The host renders a structured `output` as canonical JSON,
 * which is the text the declared schema decodes. A real seat streams the same
 * events from a provider.
 */
const scripted: Model.Model = Model.make({
  stream: (request) =>
    Stream.suspend(() => {
      // The loop keeps the task in a stable system prefix and rebuilds the
      // message tail every frame, so both halves of the request have to be read
      // to see what was asked — which is what a real model does too.
      const asked = [
        ...request.system.map((part) => part.text),
        ...request.messages.flatMap((message) =>
          message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
        )
      ].join("\n")
      const answer = asked.includes("Write a short article")
        ? {
          article: "Durable workflows survive restarts because their steps are recorded, not remembered.",
          wordCount: 12
        }
        : {
          summary: "Durable workflows record every step so a restart resumes instead of repeating.",
          keyPoints: ["steps are journaled", "replay is deterministic"]
        }
      const cell = `ctx.done(${JSON.stringify(answer)})`
      return Stream.fromIterable([
        ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
        ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
        ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
        ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
      ])
    })
})

/**
 * The host: one registry and one sandbox budget, shared by every model-backed
 * action in the composition.
 */
const host = AgentAction.layerHost({
  registry: Registry.makeNoop({
    list: () => Effect.succeed([]),
    visible: () => Effect.succeed([]),
    getOption: () => Effect.succeed(Option.none())
  }),
  limits: { calls: 8 },
  capabilityEnvelope: [],
  maxFrames: 4
})

/**
 * The credentialed half, and the only seam between this deterministic run and a
 * live one: every declared seat resolves to the scripted model above. A real
 * host answers with a provider route and a real context window instead.
 */
const seats = SeatResolver.layer({
  resolve: (id) =>
    Effect.succeed(
      Seat.make({
        id,
        model: scripted,
        route: { prepare: () => Effect.succeed(prepared) },
        contextWindowTokens: 200_000
      })
    )
})

const SimpleWorkflowLayer = Layer.mergeAll(
  Research.layer,
  Write.layer,
  Interpreter.layer(SimpleWorkflow)
).pipe(
  // The agent itself is the production loop; only the host services around it
  // are scripted.
  Layer.provideMerge(Layer.mergeAll(host, seats, Agent.layer)),
  // The sandbox a cell's code runs in and the steering source it drains. Both
  // are browser-safe defaults; a host that accepts mid-run messages provides
  // its own `Steering.layer` instead.
  Layer.provideMerge(Agent.layerDefaults),
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)

/**
 * Runs the workflow. The result is `ArticleResult`-typed all the way out: no
 * caller parses model text. `orDie` runs after the layer is provided, so a
 * sandbox that fails to build is a defect here too rather than an error the
 * caller has to handle.
 */
export const main: Effect.Effect<typeof ArticleResult.Type> = SimpleWorkflow.execute(
  { topic: "durable workflows" },
  { executionId: "agent-step-1" }
).pipe(
  Effect.provide(SimpleWorkflowLayer),
  Effect.orDie
)
