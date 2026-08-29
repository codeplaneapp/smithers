# Feature parity audit

## Typed workflow execution

- Parity: Yes
- Verified output: `HELLO ADA`
- Old

```tsx
/** @jsxImportSource smthrs */
import { closeSingleRunnerRuntime, createSmithers, runWorkflow } from "smthrs"
import { Effect } from "effect"
import { z } from "zod"

const { Workflow, Task, smithers, outputs, close } = createSmithers({
  input: z.object({ name: z.string() }),
  result: z.object({ message: z.string() })
}, { dbPath: ":memory:" })

let message = ""
const workflow = smithers((ctx) => <Workflow name="greeting">
  <Task id="greet" output={outputs.result}>{() => {
    message = `HELLO ${ctx.input.name.toUpperCase()}`
    return { message }
  }}</Task>
</Workflow>)

const run = await Effect.runPromise(runWorkflow(workflow, { input: { name: "Ada" } }))
if (run.status !== "finished") throw new Error(`run ${run.status}`)
console.log(message)
await closeSingleRunnerRuntime()
close()
```

- New

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const Greet = Action.make("audit/Greet", {
  payload: { name: Schema.String },
  success: Schema.String
})
const Greeting = Flow.make("audit/Greeting", {
  payload: { name: Schema.String },
  success: Schema.String,
  body: ({ name }) => Greet.call({ name })
})
const layer = Layer.mergeAll(
  Greet.toLayer(({ name }) => Effect.succeed(`HELLO ${name.toUpperCase()}`)),
  Interpreter.layer(Greeting)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)
const message = await Effect.runPromise(
  Greeting.execute({ name: "Ada" }, { executionId: "audit-greeting" }).pipe(
    Effect.orDie,
    Effect.provide(layer)
  )
)
console.log(message)
```

## Typed actions and outputs

- Parity: Yes
- Example: Typed workflow execution

## Sequence

- Parity: Yes
- Verified output: `["first","second"]`
- Old

```tsx
/** @jsxImportSource smthrs */
import { closeSingleRunnerRuntime, createSmithers, runWorkflow, Sequence } from "smthrs"
import { Effect } from "effect"
import { z } from "zod"

const { Workflow, Task, smithers, outputs, close } = createSmithers(
  { value: z.object({ value: z.string() }) },
  { dbPath: ":memory:" }
)
const order: string[] = []
const workflow = smithers(() => <Workflow name="sequence"><Sequence>
  <Task id="first" output={outputs.value}>{() => (order.push("first"), { value: "first" })}</Task>
  <Task id="second" output={outputs.value}>{() => (order.push("second"), { value: "second" })}</Task>
</Sequence></Workflow>)

const run = await Effect.runPromise(runWorkflow(workflow, { input: {} }))
if (run.status !== "finished") throw new Error(`run ${run.status}`)
console.log(JSON.stringify(order))
await closeSingleRunnerRuntime()
close()
```

- New

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const First = Action.make("audit/First", { payload: {}, success: Schema.String })
const Second = Action.make("audit/Second", {
  payload: { first: Schema.String },
  success: Schema.Array(Schema.String)
})
const SequenceFlow = Flow.make("audit/Sequence", {
  payload: {},
  success: Schema.Array(Schema.String),
  body: () => First.call({}).pipe(Node.andThen((first) => Second.call({ first })))
})
const layer = Layer.mergeAll(
  First.toLayer(() => Effect.succeed("first")),
  Second.toLayer(({ first }) => Effect.succeed([first, "second"])),
  Interpreter.layer(SequenceFlow)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)
const order = await Effect.runPromise(
  SequenceFlow.execute({}, { executionId: "audit-sequence" }).pipe(Effect.orDie, Effect.provide(layer))
)
console.log(JSON.stringify(order))
```

## Parallel

- Parity: Yes
- Verified plan: `["left","right"]`
- Old

```tsx
/** @jsxImportSource smthrs */
import { Parallel, Task } from "smthrs"
import { SmithersRenderer } from "@smthrs/react-reconciler/dom/renderer"

const graph = await new SmithersRenderer().render(<Parallel>
  <Task id="left" output="value">{() => ({ value: "left" })}</Task>
  <Task id="right" output="value">{() => ({ value: "right" })}</Task>
</Parallel>)
console.log(JSON.stringify(graph.tasks.map((task) => task.nodeId).sort()))
```

- New

```ts
import { Graph, Node } from "@smthrs/core"

const graph = Graph.build(Node.all({
  left: Node.succeed({ value: "left" }),
  right: Node.succeed({ value: "right" })
}))
const ids = Graph.nodes(graph)
  .filter((node) => node.kind === "Succeed")
  .map((node) => node.id.split(".").at(-1))
  .sort()
console.log(JSON.stringify(ids))
```

## Branch

- Parity: Yes
- Verified output: `ship`
- Old

```tsx
/** @jsxImportSource smthrs */
import { Branch, closeSingleRunnerRuntime, createSmithers, runWorkflow } from "smthrs"
import { Effect } from "effect"
import { z } from "zod"

const { Workflow, Task, smithers, outputs, close } = createSmithers(
  { result: z.object({ value: z.string() }) },
  { dbPath: ":memory:" }
)
let result = ""
const workflow = smithers(() => <Workflow name="branch"><Branch if={true}
  then={<Task id="ship" output={outputs.result}>{() => (result = "ship", { value: result })}</Task>}
  else={<Task id="stop" output={outputs.result}>{() => (result = "stop", { value: result })}</Task>}
/></Workflow>)

const run = await Effect.runPromise(runWorkflow(workflow, { input: {} }))
if (run.status !== "finished") throw new Error(`run ${run.status}`)
console.log(result)
await closeSingleRunnerRuntime()
close()
```

- New

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const Choice = Flow.make("audit/Choice", {
  payload: { approved: Schema.Boolean },
  success: Schema.String,
  body: ({ approved }) => Node.succeed(approved).pipe(Node.branch({
    if: (value) => value,
    then: () => Node.succeed("ship"),
    else: () => Node.succeed("stop")
  }))
})
const layer = Interpreter.layer(Choice).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)
const result = await Effect.runPromise(
  Choice.execute({ approved: true }, { executionId: "audit-choice" }).pipe(Effect.orDie, Effect.provide(layer))
)
console.log(result)
```

## Retries

- Parity: Yes; fixed attempt count
- Verified output: `3`
- Old

```tsx
/** @jsxImportSource smthrs */
import { closeSingleRunnerRuntime, createSmithers, runWorkflow } from "smthrs"
import { Effect } from "effect"
import { z } from "zod"

const { Workflow, Task, smithers, outputs, close } = createSmithers(
  { result: z.object({ value: z.string() }) },
  { dbPath: ":memory:" }
)
let attempts = 0
const workflow = smithers(() => <Workflow name="retry"><Task id="flaky"
  output={outputs.result} retries={2}>{() => {
    attempts += 1
    if (attempts < 3) throw new Error("retry")
    return { value: "ok" }
  }}</Task></Workflow>)

const run = await Effect.runPromise(runWorkflow(workflow, { input: {} }))
if (run.status !== "finished") throw new Error(`run ${run.status}`)
console.log(attempts)
await closeSingleRunnerRuntime()
close()
```

- New

```ts
import * as WithRetry from "@smthrs/patterns/WithRetry"
import * as Effect from "effect/Effect"

let attempts = 0
await Effect.runPromise(WithRetry.retryEffect(
  Effect.suspend(() => ++attempts < 3 ? Effect.fail("retry") : Effect.succeed("ok")),
  { attempts: 3 }
))
console.log(attempts)
```

## Panel

- Parity: Yes; plan-time pattern
- Verified plan: `3` calls
- Old

```tsx
/** @jsxImportSource smthrs */
import { Panel } from "smthrs"
import { SmithersRenderer } from "@smthrs/react-reconciler/dom/renderer"

const agent = { id: "agent", generate: async () => ({ text: "ok" }) }
const graph = await new SmithersRenderer().render(<Panel id="review"
  panelists={[{ agent, role: "security" }, { agent, role: "performance" }]}
  moderator={agent} panelistOutput="finding" moderatorOutput="verdict">Review v1</Panel>)
console.log(graph.tasks.length)
```

- New

```ts
import { Flow, Graph, Node } from "@smthrs/core"
import * as Panel from "@smthrs/patterns/Panel"
import * as Schema from "effect/Schema"

const participant = Flow.make({ input: Schema.Unknown, output: Schema.Unknown, body: Node.succeed })
const graph = Graph.build(Panel.make({
  panelists: { security: participant, performance: participant },
  moderator: participant
}), "Review v1")
console.log(Graph.nodes(graph).filter((node) => node.kind === "FlowCall").length)
```

## Debate

- Parity: Yes
- Verified output: `5` participant/judge calls
- Old

```tsx
/** @jsxImportSource smthrs */
import { closeSingleRunnerRuntime, createSmithers, Debate, runWorkflow } from "smthrs"
import { Effect } from "effect"
import { z } from "zod"

const { Workflow, smithers, outputs, close } = createSmithers({
  argument: z.object({ side: z.string() }),
  verdict: z.object({ winner: z.string() })
}, { dbPath: ":memory:" })
let calls = 0
const agent = (side: string) => ({ id: side, generate: async () => {
  calls += 1
  return { text: JSON.stringify(side === "judge" ? { winner: "pro" } : { side }) }
} })
const workflow = smithers(() => <Workflow name="debate"><Debate id="architecture"
  proposer={agent("pro")} opponent={agent("con")} judge={agent("judge")} rounds={2}
  argumentOutput={outputs.argument} verdictOutput={outputs.verdict} topic="One runtime?" />
</Workflow>)

const run = await Effect.runPromise(runWorkflow(workflow, { input: {} }))
if (run.status !== "finished") throw new Error(`run ${run.status}`)
console.log(calls)
await closeSingleRunnerRuntime()
close()
```

- New

```ts
import * as Debate from "@smthrs/patterns/Debate"
import * as Effect from "effect/Effect"

let calls = 0
await Effect.runPromise(Debate.run("One runtime?", {
  rounds: 2,
  proponent: ({ round }) => Effect.sync(() => (calls += 1, `pro-${round}`)),
  opponent: ({ round }) => Effect.sync(() => (calls += 1, `con-${round}`)),
  judge: () => Effect.sync(() => (calls += 1, { winner: "pro" }))
}))
console.log(calls)
```

## Review loop

- Parity: Yes
- Verified output: `2` review calls
- Old

```tsx
/** @jsxImportSource smthrs */
import { closeSingleRunnerRuntime, createSmithers, ReviewLoop, runWorkflow } from "smthrs"
import { Effect } from "effect"
import { z } from "zod"

const { Workflow, smithers, outputs, close } = createSmithers({
  produced: z.object({ draft: z.string() }),
  review: z.object({ approved: z.boolean() })
}, { dbPath: ":memory:" })
let reviews = 0
const producer = { id: "producer", generate: async () => ({ text: JSON.stringify({ draft: "draft" }) }) }
const reviewer = { id: "reviewer", generate: async () => ({
  text: JSON.stringify({ approved: ++reviews === 2 })
}) }
const workflow = smithers(() => <Workflow name="review"><ReviewLoop id="review"
  producer={producer} reviewer={reviewer} produceOutput={outputs.produced}
  reviewOutput={outputs.review} maxIterations={4}>Write</ReviewLoop></Workflow>)

const run = await Effect.runPromise(runWorkflow(workflow, { input: {} }))
if (run.status !== "finished") throw new Error(`run ${run.status}`)
console.log(reviews)
await closeSingleRunnerRuntime()
close()
```

- New

```ts
import * as ReviewLoop from "@smthrs/patterns/ReviewLoop"
import * as Effect from "effect/Effect"

let reviews = 0
await Effect.runPromise(ReviewLoop.run("draft", {
  maxRounds: 4,
  produce: Effect.succeed,
  review: () => Effect.sync(() => ({ approved: ++reviews === 2 })),
  revise: ({ output }) => Effect.succeed(`${output}-revised`)
}))
console.log(reviews)
```

## Gather and synthesize

- Parity: Yes; `MapReduce`
- Verified plan: `6` map/reduce calls
- Old

```tsx
/** @jsxImportSource smthrs */
import { GatherAndSynthesize } from "smthrs"
import { SmithersRenderer } from "@smthrs/react-reconciler/dom/renderer"
import { SmithersContext, SmithersCtx } from "@smthrs/react-reconciler/context"

const agent = { id: "agent", generate: async () => ({ text: "ok" }) }
const ctx = new SmithersCtx({ runId: "audit", iteration: 0, input: {}, outputs: {} })
const graph = await new SmithersRenderer().render(<SmithersContext.Provider value={ctx}>
  <GatherAndSynthesize id="sum" sources={[agent, agent, agent, agent, agent]}
    synthesizer={agent} gatherOutput="mapped" synthesisOutput="total">Double and sum</GatherAndSynthesize>
</SmithersContext.Provider>)
console.log(graph.tasks.length)
```

- New

```ts
import { Flow, Graph, Node } from "@smthrs/core"
import * as MapReduce from "@smthrs/patterns/MapReduce"
import * as Schema from "effect/Schema"

const step = Flow.make({ input: Schema.Unknown, output: Schema.Unknown, body: Node.succeed })
const graph = Graph.build(MapReduce.make({
  map: step,
  reduce: step,
  concurrency: 2,
  onEmpty: "reduce"
}), { shards: [1, 2, 3, 4, 5] })
console.log(Graph.nodes(graph).filter((node) => node.kind === "FlowCall").length)
```

## Loop and bounded recursion

- Parity: Partial
- Gap: old runtime rerender loop and new static recursion tree are not equivalent

## Child workflows

- Parity: Partial
- Gap: new `.child()` exists; cancellation and cleanup remain incomplete

## Caching

- Parity: Partial
- Old: TTL, scope, key callbacks, version invalidation
- New: sealed step-key cache; no TTL API

## Failure handling

- Parity: Partial
- New: `Node.catch`
- Gap: old `TryCatchFinally` semantics not yet audited end-to-end

## Saga compensation

- Parity: Partial
- Gap: no equivalent named pattern

## Continue as new

- Parity: Partial
- Gap: continued terminal status

## Durable timers

- Parity: Yes
- New: `Sleep.action`

## Durable waits

- Parity: Yes
- New: `WaitFor.action`

## Signals

- Parity: Yes
- New: control signal API

## Approvals

- Parity: Yes
- New: `WithApproval`

## Human tasks

- Parity: Partial
- Gap: arbitrary typed human-response helper

## Priority and concurrency

- Parity: Partial
- Gap: priority and bounded dynamic concurrency

## Quarantine and continue-on-failure

- Parity: Partial
- Gap: named quarantine policy

## Idempotency and stable step identity

- Parity: Yes

## Durable journal and events

- Parity: Yes

## Dependency deadlock detection

- Parity: Yes

## Structured-output correction

- Parity: Partial
- Gap: correction-attempt policy parity

## Quota-aware waits

- Parity: Partial
- Gap: provider quota classifier

## Provenance and capability authority

- Parity: Yes

## Artifacts and remote step cache

- Parity: Partial
- Gap: remote cache integration audit

## Child cancellation and process containment

- Parity: Partial
- Release blocker

## Run lineage

- Parity: Partial

## Live steering

- Parity: Partial

## Usage metering and quotas

- Parity: Plue-owned

## Escalation chain

- Parity: Partial
- Gap: old escalation checks/human fallback differ from new `Escalation`

## Fork fan-out

- Parity: Yes; generalized by `Node.all` and `MapReduce`

## Classify and route

- Parity: Yes; generalized by `Node.branch`

## Decision table

- Parity: Yes; generalized by `Node.branch`

## Supervisor

- Parity: No

## SuperSmithers

- Parity: No; application macro

## Optimizer pattern

- Parity: No; eval primitives exist

## Ralph

- Parity: Partial; see Loop and bounded recursion

## Check suite

- Parity: Partial; expressible with `MapReduce`

## Kanban

- Parity: No; application pattern

## Runbook

- Parity: Partial; expressible with sequence and approval

## Scan-fix-verify

- Parity: Partial; expressible with `ReviewLoop`; semantics differ

## Drift detector

- Parity: Partial; expressible with schedules and actions

## Content pipeline

- Parity: Yes; generalized by `Node.andThen`

## Merge queue

- Parity: No

## Poller

- Parity: Partial; no durable named poller

## Monitor

- Parity: No

## Sidecar

- Parity: No

## Aspects and budgets

- Parity: Partial

## Dynamic delegation and Trellis

- Parity: No

## Delegation chain

- Parity: No

## Memory Trellis

- Parity: No

## Agent memory

- Parity: Yes

## Durable engine

- Parity: Partial

## Crash recovery and resume

- Parity: Partial

## Cancellation and pause

- Parity: Partial

## Time travel

- Parity: Yes
- Old runnable example: `examples/time-travel-demo.jsx`
- New runnable example: `flows/examples/src/06-time-travel-rewind.ts`

## Workspace checkpoints

- Parity: Partial

## Local sandbox

- Parity: Yes

## Worktrees and VCS

- Parity: Partial

## Remote sandbox providers

- Parity: Partial

## SQLite storage

- Parity: Yes

## Postgres and PGlite storage

- Parity: No

## Agent adapters and pools

- Parity: Yes

## Eval suites

- Parity: Yes
- New: `Suite`, `Runner`, `Baseline`, `Regression`, `Gate`

## Scorers

- Parity: Yes

## Eval regression gates

- Parity: Yes

## Prompt optimization

- Parity: No

## OpenAPI tools

- Parity: No

## External integrations

- Parity: No; migrate onto actions, triggers, and Plue

## Schedules

- Parity: Yes

## Durable alerts

- Parity: Partial

## CLI

- Parity: Partial; compatibility intentionally out of scope

## MCP server

- Parity: Partial

## Gateway and RPC

- Parity: Partial; Plue migration required

## Product UI

- Parity: Yes after Flows UI and Plue migration

## Operator TUI

- Parity: Yes

## Live client sync

- Parity: Partial

## Electric sync proxy

- Parity: No; likely unnecessary

## Workflow-specific UIs

- Parity: No; remove unless a product requirement survives migration

## Observability

- Parity: Yes

## Hosted tenancy and billing

- Parity: Plue-owned

## Workflow packs

- Parity: Partial

## Init pack and starters

- Parity: No

## Runtime portability

- Parity: Partial

## Workflow testing

- Parity: Yes

## Fault and durability testing

- Parity: Yes

## Open code review

- Parity: No; migrate as application workflow

## Herdr supervision and hijack

- Parity: No

## Docs pipeline

- Parity: Yes after migration

## Docs-driven development

- Parity: Not a runtime feature
