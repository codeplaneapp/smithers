import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/core"
import { Flow as DurableFlow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Schema from "effect/Schema"

const Research = Schema.Struct({
  summary: Schema.String,
  keyPoints: Schema.Array(Schema.String)
})

const Article = Schema.Struct({
  article: Schema.String,
  wordCount: Schema.Number
})

/** The research step: a model call whose answer must be a `Research`. */
export const ResearchStep = AgentAction.make("simple-workflow/Research", {
  payload: { topic: Schema.String },
  output: Research,
  seat: "anthropic:claude-sonnet-5",
  system: ["You are a research assistant. Provide concise summaries and key points."],
  prompt: ({ topic }) => `Research this topic and provide a summary with 3-5 key points: ${topic}`
})

/** The writing step, which consumes the research step's typed fields. */
export const WriteStep = AgentAction.make("simple-workflow/Write", {
  payload: {
    summary: Schema.String,
    keyPoints: Schema.Array(Schema.String)
  },
  output: Article,
  seat: "anthropic:claude-sonnet-5",
  system: ["You are a technical writer. Write clear, engaging content."],
  prompt: ({ keyPoints, summary }) =>
    `Write a short article based on this research:\n\nSummary: ${summary}\nKey Points: ${JSON.stringify(keyPoints)}`
})

/** The durable flow: the old `<Sequence>` is one `Node.andThen`. */
export const SimpleExample = DurableFlow.make("simple-workflow/SimpleExample", {
  payload: { topic: Schema.String },
  success: Article,
  error: AgentAction.AgentFailure,
  body: ({ topic }) =>
    ResearchStep.call({ topic }).pipe(
      Node.andThen((research) => WriteStep.call({ summary: research.summary, keyPoints: research.keyPoints }))
    )
})

/**
 * The descriptor the registry reads, describing the flow the engine runs.
 *
 * Discovery tokenizes `export default Flow.make(` and never evaluates it, so
 * the default export is what the control plane admits. It admits `SimpleExample`
 * and nothing else: its `input` and `output` are that flow's `payload` and
 * `success`, which is the whole binding flows can express today.
 *
 * The descriptor carries no `body`, and cannot. `@smthrs/core`'s `body` returns
 * a `@smthrs/core/Node`; `SimpleExample.call` returns a `@smthrs/plan/Node`, a
 * different type in a different package, so `body: (input) =>
 * SimpleExample.call(input)` is `TS2322` and no cast belongs in migrated
 * output. Binding the two by body is the core-runtime bridge, and this golden
 * gains the `body` line the day that bridge lands.
 */
export default Flow.make({
  description: "Researches a topic and writes a short article about it.",
  input: Schema.Struct({ topic: Schema.String }),
  output: Article,
  capabilities: [],
  effects: {
    reads: [],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  }
})
