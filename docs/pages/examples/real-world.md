---
description: "Practical Smithers Flows patterns for typed jobs, durable approvals, retries, and model-backed pipelines."
---

# Real-world workflows

These examples are small enough to understand in one sitting, but model jobs that appear in production systems. Each pattern comes from a program under `examples/src` and is exercised by `pnpm run test:examples`.

## Process a typed job

Use an `Action` for one unit of work and a `Flow` for the graph that calls it. The implementation lives in a layer, so tests and deployments can provide different implementations without changing the flow.

```ts
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const SendReceipt = Action.make("billing/SendReceipt", {
  payload: { customer: Schema.String, amount: Schema.Number },
  success: Schema.String
})

const ChargeCustomer = Flow.make("billing/ChargeCustomer", {
  payload: { customer: Schema.String, amount: Schema.Number },
  success: Schema.String,
  body: (payload) => SendReceipt.call(payload)
})

const AppLayer = Layer.mergeAll(
  SendReceipt.toLayer(({ customer, amount }) =>
    Effect.succeed(`Sent $${amount} receipt to ${customer}`)
  ),
  Interpreter.layer(ChargeCustomer)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)

const result = ChargeCustomer.execute(
  { customer: "ada@example.com", amount: 49 },
  { executionId: "charge-order-1042" }
).pipe(Effect.provide(AppLayer))
```

`AppLayer` is the complete runtime dependency graph. Compose it once, then provide it once at the program boundary. The payload and result are schema-checked, and the explicit execution ID gives the run a stable identity. See the complete tested [`01-define-and-run.ts`](https://github.com/smithersai/flows/blob/main/examples/src/01-define-and-run.ts).

## Pause for approval and survive a restart

A durable wait records that the run is suspended. Another worker can open the same SQLite store, complete the deferred value, and resume the same execution without repeating sealed work that already succeeded.

```ts
const Approval = DurableDeferred.make("deploy/approval", {
  success: Schema.String
})

const Deploy = Action.make("deploy/Release", {
  payload: { version: Schema.String },
  success: Schema.String
})

const Release = Flow.make("deploy/ReleaseFlow", {
  payload: { version: Schema.String },
  success: Schema.String,
  body: (payload) => Deploy.call(payload)
})

const deploy = ({ version }: { version: string }) =>
  Effect.gen(function* () {
    const artifact = yield* BuildArtifact // sealed and cached
    const decision = yield* DurableDeferred.await(Approval)
    return `${version}:${artifact}:${decision}`
  })

const makeAppLayer = (hostId: string) =>
  Layer.mergeAll(
    Deploy.toLayer(deploy),
    Interpreter.layer(Release)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(durableEngine("releases.sqlite", hostId))
  )

const WorkerALayer = makeAppLayer("worker-a")
const WorkerBLayer = makeAppLayer("worker-b")

// Worker A runs until Approval suspends the execution.
const suspend = Release.execute(
  { version: "2.4.0" },
  { executionId: "release-2.4.0", discard: true }
).pipe(Effect.provide(WorkerALayer))

yield* suspend

// Later, worker B uses the same database and resumes the run.
const resume = Effect.gen(function* () {
  const runtime = yield* FlowRuntime.FlowRuntime
  yield* runtime.deferredDone(Approval, {
    flowName: Release._tag,
    executionId: "release-2.4.0",
    deferredName: Approval.name,
    exit: Exit.succeed("approved")
  })

  return yield* Release.execute(
    { version: "2.4.0" },
    { executionId: "release-2.4.0" }
  )
}).pipe(Effect.provide(WorkerBLayer))

const result = yield* resume
```

The full example creates two engine layers over one real SQLite file and asserts that work before the suspension dispatches only once. See [`03-crash-and-resume.ts`](https://github.com/smithersai/flows/blob/main/examples/src/03-crash-and-resume.ts).

## Retry a flaky integration

Retry policy is inspectable data. The action reads its current durable attempt, while `Action.retry` controls redispatch.

```ts
const policy = RetryPolicy.make({
  initialMs: 100,
  factor: 2,
  maxMs: 1_000,
  maxAttempts: 4,
  nonRetryable: ["payments/CardDeclined"]
})

const Upload = Action.make({
  name: "releases/Upload",
  success: Schema.String,
  error: TemporaryFailure,
  tier: "sealed",
  execute: Effect.gen(function* () {
    const attempt = yield* Action.CurrentAttempt
    if (attempt < 3) {
      return yield* Effect.fail(
        new TemporaryFailure({ message: `attempt ${attempt} timed out` })
      )
    }
    return "uploaded"
  })
})

const result = yield* Action.retry(Upload, { times: 3 })
```

The tested program also inspects the backoff ladder and proves that a non-retryable error short-circuits it. See [`04-retry-policy.ts`](https://github.com/smithersai/flows/blob/main/examples/src/04-retry-policy.ts).

## Chain typed model-backed steps

Model calls are ordinary actions. Declaring an output schema means the next step receives typed data instead of parsing free-form model text.

```ts
const ResearchResult = Schema.Struct({
  summary: Schema.String,
  keyPoints: Schema.Array(Schema.String)
})

const Research = AgentAction.make("content/Research", {
  payload: { topic: Schema.String },
  output: ResearchResult,
  seat: "anthropic:claude-sonnet-4-5",
  system: ["Research accurately and cite the important facts."],
  prompt: ({ topic }) => `Research ${topic}.`
})

const Write = AgentAction.make("content/Write", {
  payload: {
    summary: Schema.String,
    keyPoints: Schema.Array(Schema.String)
  },
  output: Schema.Struct({ article: Schema.String }),
  seat: "anthropic:claude-sonnet-4-5",
  system: ["Write concise technical articles."],
  prompt: ({ summary, keyPoints }) =>
    `Summary: ${summary}\nPoints:\n${keyPoints.map((x) => `- ${x}`).join("\n")}`
})

const PublishArticle = Flow.make("content/PublishArticle", {
  payload: { topic: Schema.String },
  success: Schema.Struct({ article: Schema.String }),
  error: AgentAction.AgentFailure,
  body: ({ topic }) =>
    Research.call({ topic }).pipe(
      Node.andThen((research) => Write.call(research))
    )
})
```

The runnable version supplies a scripted `SeatResolver`, so CI tests the real agent loop without credentials. A production host changes only that resolver. See [`11-agent-step.ts`](https://github.com/smithersai/flows/blob/main/examples/src/11-agent-step.ts).

## Implement, review, and revise until LGTM

Use two typed agent actions and a trampoline handoff. The implementer receives the original prompt plus the previous draft and review feedback. The reviewer returns a structured verdict, so control flow never depends on matching arbitrary prose.

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const Review = Schema.Struct({
  verdict: Schema.Literals(["lgtm", "changes_requested"]),
  feedback: Schema.String
})

const Result = Schema.Struct({
  implementation: Schema.String,
  rounds: Schema.Number
})

const Implement = AgentAction.make("coding/Implement", {
  payload: {
    prompt: Schema.String,
    previousDraft: Schema.String,
    feedback: Schema.String
  },
  output: Schema.String,
  seat: "anthropic:claude-sonnet-4-5",
  system: [
    "Implement the requested change completely.",
    "When revising, address every reviewer comment. Return only the implementation."
  ],
  prompt: ({ prompt, previousDraft, feedback }) => `
Task:
${prompt}

Previous implementation:
${previousDraft || "None — this is the first pass."}

Reviewer feedback:
${feedback || "None — this is the first pass."}
`.trim()
})

const ReviewImplementation = AgentAction.make("coding/Review", {
  payload: {
    prompt: Schema.String,
    implementation: Schema.String
  },
  output: Review,
  seat: "anthropic:claude-sonnet-4-5",
  system: [
    "Review correctness, completeness, tests, security, and maintainability.",
    "Return lgtm only when the implementation is ready to ship.",
    "Otherwise return changes_requested with specific, actionable feedback."
  ],
  prompt: ({ prompt, implementation }) => `
Original task:
${prompt}

Implementation to review:
${implementation}
`.trim()
})

const Payload = Schema.Struct({
  prompt: Schema.String,
  previousDraft: Schema.String,
  feedback: Schema.String,
  round: Schema.Number
})

type ImplementUntilLgtmFlow = Flow.Flow<
  "coding/ImplementUntilLgtm",
  typeof Payload,
  typeof Result,
  typeof AgentAction.AgentFailure,
  | Action.Requirement<"coding/Implement">
  | Action.Requirement<"coding/Review">
>

const ImplementUntilLgtm: ImplementUntilLgtmFlow = Flow.make(
  "coding/ImplementUntilLgtm",
  {
    payload: {
      prompt: Schema.String,
      previousDraft: Schema.String,
      feedback: Schema.String,
      round: Schema.Number
    },
    success: Result,
    error: AgentAction.AgentFailure,
    maxRounds: 6,
    body: ({ prompt, previousDraft, feedback, round }) =>
      Implement.call({ prompt, previousDraft, feedback }).pipe(
        Node.andThen((implementation) =>
          ReviewImplementation.call({ prompt, implementation }).pipe(
            Node.map((review) => ({
              implementation,
              review,
              round,
              nextRound: round + 1
            }))
          )
        ),
        Node.branch({
          if: ({ review }) => review.verdict === "lgtm",
          then: ({ implementation, round }) =>
            Flow.done({ implementation, rounds: round }),
          else: ({ implementation, review, nextRound }) =>
            ImplementUntilLgtm.to({
              prompt,
              previousDraft: implementation,
              feedback: review.feedback,
              round: nextRound
            })
        })
      )
  }
)

const AppLayer = Layer.mergeAll(
  Implement.layer,
  ReviewImplementation.layer,
  Interpreter.layer(ImplementUntilLgtm)
).pipe(
  Layer.provideMerge(Layer.mergeAll(agentHostLayer, seatResolverLayer, Agent.layer)),
  Layer.provideMerge(Agent.layerDefaults),
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)

const program = ImplementUntilLgtm.execute(
  {
    prompt: "Add rate limiting to the login endpoint, including tests.",
    previousDraft: "",
    feedback: "",
    round: 1
  },
  { executionId: "login-rate-limit" }
).pipe(
  Effect.orDie,
  Effect.provide(AppLayer)
)
```

`agentHostLayer` supplies the tool registry and sandbox limits. `seatResolverLayer` is the one credentialed boundary that resolves each declared seat to a provider model. Both are composed into `AppLayer` before the program receives it.

Each rejected review ends the current round and persists a handoff to the same flow with the draft and feedback. A crash between rounds therefore resumes from durable state. `maxRounds: 6` is a hard safety budget: exceeding it terminates the lineage instead of allowing reviewers to disagree forever.

> In an application that edits a repository, make the implementation output a typed patch or artifact reference rather than a large source string. Give the reviewer read-only repository tools, and apply or publish the final patch only after the `lgtm` branch.

## Run the examples

```sh
pnpm install
pnpm run test:examples
```

Continue to the [runnable example catalog](/examples) for durability, time travel, sync, host adapters, browser bundling, and telemetry examples.
