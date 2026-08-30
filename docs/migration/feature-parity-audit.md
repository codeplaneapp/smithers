# Feature parity audit

## Status (2026-08-28)

Post-integration audit against the parity integration tree (flows HEAD 9230168 plus the ten parity lanes: 16 commits, 326 files, +43693/-624, exported as patches/parity-integration.diff). Counts over 95 audited features (99 tracked items; four sections carry a second item):

- Yes before this round: 33
- Yes (1.0.0-rc.0), closed by the parity lanes and verified in the integration tree: 36
- Partial after integration: 7 (Human tasks, Child cancellation and process containment, Check suite, Kanban, Runbook, Merge queue, Sidecar)
- Deferred for rc.0 under Phase 5 enforcement or scope ruling: 11 items (A16, A28b, A58b, A60b, A62, A67, A72, A73, A89a, A89b, A93). Every one is listed once on `docs/pages/release/known-limitations.md` under its Phase 5 exclusion id; A89a (Bun durable engine, X-18) and the 0.x database refusal (X-13) are enforced in `packages/database/src/node/NodeDatabase.ts`
- Pending Phase 4: 9 (CLI, MCP server, Gateway and RPC, Product UI, Electric sync proxy, Workflow-specific UIs, Init pack and starters, Open code review, Docs pipeline)
- Plue-owned: 2 (Usage metering and quotas, Hosted tenancy and billing)
- Not a runtime feature: 1 (Docs-driven development)

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

- Parity: Yes (1.0.0-rc.0)
- New: `@smthrs/patterns` `WithRetry` gains `backoff` (initialMs, factor, maxMs) and `nonRetryable` error tags, folded into declaration identity
- Evidence: packages/patterns/test/WithRetry.test.ts::spaces attempts by a capped exponential backoff
- Evidence: packages/patterns/test/WithRetry.test.ts::attempts a non-retryable failure exactly once
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

- Parity: Yes (1.0.0-rc.0)
- New: `Panel.run` (bounded concurrency, per-panelist roles, opinions keyed by name) beside `Panel.make`
- Evidence: packages/patterns/test/Panel.test.ts::holds three panelists in flight together at width three
- Evidence: packages/patterns/test/Panel.test.ts::keys opinions by panelist name whatever the completion order
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

- Parity: Yes (1.0.0-rc.0)
- New: `@smthrs/patterns` `Loop.make` and `Loop.run` (bounded until-loop with onMaxReached fail or return-last); the durable recipe is one `Flow.to` round per iteration with maxRounds
- Evidence: packages/patterns/test/Loop.test.ts::stops at the first satisfied predicate
- Evidence: packages/patterns/test/Loop.test.ts::declares exactly maxIterations bounded body and predicate calls

## Child workflows

- Parity: Yes (1.0.0-rc.0)
- New: per-child parent-exit policy (`RunState.onParentExit` cancel or detach, applied inside the parent's terminal transaction) and the durable `EngineChildren` port (spawn, await, send over Control, Crypto, FlowRuntime, RunStore)
- Evidence: packages/engine-store/test/ChildExitPolicy.test.ts::commits the parent's exit and its children's cancellation together or not at all
- Evidence: packages/agent/test/EngineChildren.test.ts::returns the child's output to a second engine over the same database file
- Note: `Children.await` polls rather than parking the calling run; the park needs a `ChildFlows.Children` contract change owned by agent-runtime

## Caching

- Parity: Yes (1.0.0-rc.0)
- New: `CacheEnvironment.withCache` and `CachePolicy` (ttlMs; scope run, flow, or shared) read by `ActionPersistence` with journaled admission verdicts; `CacheStore` `maxAgeMs` and `sweepExpired`; `WithCache` folds ttl, scope, and version into declaration identity
- Evidence: packages/engine-store/test/CacheTtl.test.ts::serves the recorded result inside the bound without dispatching again
- Evidence: packages/engine-store/test/CacheTtl.test.ts::shares a shared-scoped result across runs
- Note: the engine honors the `@smthrs/flow` action form today; core `WithCache.make` declarations reach the engine through the Phase 4 core-runtime bridge

## Failure handling

- Parity: Yes (1.0.0-rc.0)
- New: `@smthrs/patterns` `TryCatchFinally` (filtered catch, finalizer on both arms, finalizer_failed error code) beside `Node.catch`
- Evidence: packages/patterns/test/TryCatchFinally.test.ts::recovers a matching failure and still runs the finalizer
- Evidence: packages/patterns/test/TryCatchFinally.test.ts::fails finalizer_failed when the finalizer fails after a successful body

## Saga compensation

- Parity: Yes (1.0.0-rc.0)
- New: `@smthrs/patterns` `Saga` (LIFO compensation; policies compensate, compensate-and-fail, fail; default compensate)
- Evidence: packages/patterns/test/Saga.test.ts::compensates completed steps in reverse and settles under compensate
- Evidence: packages/patterns/test/Saga.test.ts::compensates completed steps when the forward chain is interrupted
- Note: `Saga.run` compensations are in-memory finalizers and must be idempotent; the declared `make` form is the durable one

## Continue as new

- Parity: Deferred for rc.0
- Enforcement (X-04, known limitations "Continue-as-new"): `RunStatus` gains no `continued` value; the trampoline (`Flow.to` with maxRounds, lineage_id, round_ordinal) is the supported mechanism, a handed-off round settles completed, and the exclusion is documented per PLAN.md Phase 5

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

- Parity: Yes (1.0.0-rc.0)
- New: `HumanTask.action` (typed ask, confirm, select, and json responses; bounded JSON Schema validation; re-ask to maxAttempts with journaled refusals; `HumanTask.answer` and `HumanTask.decode`)
- Evidence: packages/flow/test/HumanTask.test.ts::parks on one process and is answered on the next, through the same token
- Evidence: packages/engine-store/test/RacedParkResume.test.ts::fails the question with the timeout code when the deadline passes unanswered
- Evidence: packages/engine-store/test/RacedParkResume.test.ts::parks the raced attempt without settling its row, and settles on the answer

## Priority and concurrency

- Parity: Yes (1.0.0-rc.0)
- New: `Node.priority` and the core Priority annotation reach `NodeDraft.priority` and the plan scheduler; `Bounded.all` and `Bounded.run` bound fan-out with priority-first starts
- Evidence: packages/engine-store/test/PlanSchedulerPriority.test.ts::starts the higher-priority ready node first under a capacity of one
- Evidence: packages/patterns/test/Bounded.test.ts::keeps run within the concurrency bound and starts the highest priority first

## Quarantine and continue-on-failure

- Parity: Yes (1.0.0-rc.0)
- New: `Quarantine.all`, `Quarantine.run`, and `Quarantine.settle` (continue-on-failure join; halt or quarantine policy)
- Evidence: packages/patterns/test/Quarantine.test.ts::isolates a failing member and lets its siblings finish
- Evidence: packages/patterns/test/Quarantine.test.ts::interrupts siblings on the first failure under the halt policy

## Idempotency and stable step identity

- Parity: Yes

## Durable journal and events

- Parity: Yes

## Dependency deadlock detection

- Parity: Yes

## Structured-output correction

- Parity: Yes (1.0.0-rc.0)
- New: `AgentAction` `Host.defaultCorrections` with per-action override, each correction attempt a sealed durable step with journaled rejections, and a bounded `repair` slot decoded by the same schema
- Evidence: packages/agent/test/StructuredOutputPolicy.test.ts::replays the settled ask on a second engine and re-issues only the correction
- Evidence: packages/agent/test/StructuredOutputPolicy.test.ts::journals one record per rejection, naming the attempt and the schema

## Quota-aware waits

- Parity: Yes (1.0.0-rc.0)
- New: `QuotaPolicy` classifier (provider reset instant, retry-after fallback, prose parsing, wait ceiling) and the quota park in `AgentAction` (waiting reason quota with wakeAt, retry budget untouched)
- Evidence: packages/agent/test/QuotaPolicy.test.ts::parks the run under the quota reason, wakes on the deadline, and answers
- Evidence: packages/agent/test/QuotaPolicy.test.ts::resumes a parked run on a second engine without re-issuing the refusal
- Deferred for rc.0 (B-R1, the residual of X-05, known limitations "Provider quota"): the cross-process quota wake sweep (A28b); the driver's sweep wakes released and cancel-requested rows only, documented per PLAN.md Phase 5

## Provenance and capability authority

- Parity: Yes

## Artifacts and remote step cache

- Parity: Yes (1.0.0-rc.0)
- New: `RemoteArtifacts` download policy (all or minimal) honored at the dispatch seam, chunked PUT with HEAD-probe resume and whole-blob fallback, and the end-to-end shared-tier example 35
- Evidence: packages/engine-store/test/RemoteCacheProtocol.test.ts::admits a replay under minimal with no download, and materializes on the first read
- Evidence: packages/artifacts/test/RemoteArtifactsServer.test.ts::resumes an interrupted chunked upload from the prefix the server kept

## Child cancellation and process containment

- Parity: Partial
- New: `ProcessLedger` (journaled spawn, exit, and reap facts), `ContainedSpawner` (per-command process group, SIGTERM then SIGKILL after graceMs), `ProcessReaper` (ESRCH-only liveness, start-identity check before kill), `NodeHost.layerContained` and `BunHost.layerContained`, optional remote `Provider.kill`
- Evidence: packages/flows/test/NodeRuntime.test.ts::releases the run it owns when a shutdown signal arrives, and kills what it spawned
- Evidence: packages/flows/test/NodeRuntime.test.ts::kills what a run spawned when a SECOND driver over the same file interrupts it
- Evidence: packages/engine-store/test/CrossDriverCancelSettles.test.ts::interrupts the caller instead of leaving it in the suspended-retry loop

## Run lineage

- Parity: Yes (1.0.0-rc.0)
- New: control `Lineage` (origin child, fork, or continuation), `RunSummary` parentRunId, lineageId, roundOrdinal, and origin, `ListRequest` filters by parent and lineage, derived `control.run.lineage` watch events, and the time-travel continuation edge
- Evidence: packages/control/test/EngineLineage.test.ts::lists the trampoline's three rounds under one lineage with ascending ordinals
- Evidence: packages/time-travel/test/TrampolineLineage.test.ts

## Live steering

- Parity: Yes (1.0.0-rc.0)
- New: typed `SteerMessage` union (legacy bodies still decode), delivery receipts on the journal, pending counts on `RunSummary`, and wake on steer scoped to event parks
- Evidence: packages/control/test/ControlSteering.test.ts::shows a watcher the enqueue and then the delivery of the same message id
- Evidence: packages/control/test/ControlSteering.test.ts::wakes a run parked on an event and leaves an approval, timer, or quota park alone

## Usage metering and quotas

- Parity: Plue-owned

## Escalation chain

- Parity: Yes (1.0.0-rc.0)
- New: `Escalation` per-rung escalateIf with the default predicate, fallback rung, and the Reached or Exhausted result carrying the level
- Evidence: packages/patterns/test/Escalation.test.ts::stops at a rung whose escalateIf refuses even when accept would escalate
- Evidence: packages/patterns/test/Escalation.test.ts::runs the fallback only after every rung escalates

## Fork fan-out

- Parity: Yes; generalized by `Node.all` and `MapReduce`

## Classify and route

- Parity: Yes; generalized by `Node.branch`

## Decision table

- Parity: Yes; generalized by `Node.branch`

## Supervisor

- Parity: Yes (1.0.0-rc.0)
- New: `@smthrs/patterns` `Supervisor` (plan, routed workers, review, re-delegation of retriable ids, finalize)
- Evidence: packages/patterns/test/Supervisor.test.ts::re-delegates only the retriable tasks and finalizes every output
- Evidence: packages/patterns/test/Supervisor.test.ts::never runs more workers at once than the concurrency bound

## SuperSmithers

- Parity: Yes (1.0.0-rc.0)
- New: `@smthrs/patterns` `Intervene` (read, propose, gated apply, report; dryRun; `WithApproval` gate), the reusable shape behind the old macro
- Evidence: packages/patterns/test/Intervene.test.ts::never applies on a dry run and reports the proposal
- Evidence: packages/patterns/test/Intervene.test.ts::stops before apply when the approval is denied

## Optimizer pattern

- Parity: Yes (1.0.0-rc.0)
- New: `@smthrs/patterns` `Optimizer` (generate, evaluate, improve to a target score, best-so-far kept)
- Evidence: packages/patterns/test/Optimizer.test.ts::stops at the first candidate that reaches the target
- Evidence: packages/patterns/test/Optimizer.test.ts::keeps the best candidate when no target is set

## Ralph

- Parity: Yes (1.0.0-rc.0)
- New: `Loop.ralph` (body-only bounded loop that stops on a done signal)
- Evidence: packages/patterns/test/Loop.test.ts::stops ralph when the body reports done

## Check suite

- Parity: Yes (1.0.0-rc.0)
- New: `CheckSuite.make` and `CheckSuite.run` (record-keyed checks; verdict strategies all-pass, majority, any-pass; continueOnFail at run time)
- Evidence: packages/patterns/test/CheckSuite.test.ts::runs every check and lists the failed one when continueOnFail is true
- Evidence: packages/patterns/test/CheckSuite.test.ts::declares one recovery arm per check when continueOnFail is true

## Kanban

- Parity: Yes (1.0.0-rc.0)
- New: `Kanban.make` and `Kanban.run` (per-column bounded concurrency, until loop, unique item ids, failed items isolated at run time)
- Evidence: packages/patterns/test/Kanban.test.ts::drops a failed item and lets the rest finish the board
- Evidence: packages/patterns/test/Kanban.test.ts::declares one recovery arm per card so a rejected card leaves its column alone
- Note: the declaration and `run` differ in which calls happen, not only how many: a quarantined card is not dropped from the later columns in the declaration (a plan has no branch), so it travels on with its marker as `previous`, while `run` drops it and makes no call at all

## Runbook

- Parity: Yes (1.0.0-rc.0)
- New: `Runbook.make` and `Runbook.run` (risk-gated steps, elevated critical approvals, onDeny fail at declaration, onDeny fail or skip at run time)
- Evidence: packages/patterns/test/Runbook.test.ts::skips a denied step and runs the next one under onDeny skip
- Evidence: packages/patterns/test/Runbook.test.ts::refuses onDeny skip at declaration, naming run as the way to skip
- Note: `onDeny: "skip"` is a `run` option; `make` refuses it with a `PatternError` because a denial and a step failure share one error channel, so a declared skip arm would also declare that the runbook continues past a failed critical step

## Scan-fix-verify

- Parity: Yes (1.0.0-rc.0)
- New: `@smthrs/patterns` `ScanFixVerify` (per-issue fix fan-out under a concurrency bound; only an empty rescan is terminal)
- Evidence: packages/patterns/test/ScanFixVerify.test.ts::rescans after a resolved verification and ends only on a clean scan
- Evidence: packages/patterns/test/ScanFixVerify.test.ts::overlaps fixes up to the concurrency bound

## Drift detector

- Parity: Yes (1.0.0-rc.0)
- New: `@smthrs/patterns` `DriftDetector` (capture, compare, alert; polling recipe over Loop or triggers)
- Evidence: packages/patterns/test/DriftDetector.test.ts::alerts once with the comparison when the snapshot drifted
- Evidence: packages/patterns/test/DriftDetector.test.ts::skips the alert when nothing drifted
- Note: `make` declares the alert arm unconditionally because core has no branch constructor; `run` performs the real skip

## Content pipeline

- Parity: Yes; generalized by `Node.andThen`

## Merge queue

- Parity: Yes (1.0.0-rc.0)
- New: `MergeQueue.make` and `MergeQueue.run` (priority-then-declaration landing order; halt or quarantine failure policy at run time)
- Evidence: packages/patterns/test/MergeQueue.test.ts::lands members one at a time in priority then declaration order
- Evidence: packages/patterns/test/MergeQueue.test.ts::declares one recovery arm per member under the quarantine policy
- Evidence: packages/patterns/test/MergeQueue.test.ts::gives every member the default priority unless it sets its own, as an annotation

## Poller

- Parity: Yes (1.0.0-rc.0)
- New: `Poll.make` (durable named poller: one check per trampoline round, `Sleep.action` between attempts, fixed, linear, or exponential backoff, onTimeout fail or return-last, bounded checks)
- Evidence: packages/flow/test/Poll.test.ts::waits the declared schedule between attempts, then answers with what satisfied the check
- Evidence: packages/flow/test/Poll.test.ts::re-drives the round it was dropped in without re-running that round's attempt

## Monitor

- Parity: Yes (1.0.0-rc.0)
- New: control `Monitor` (pure classify plus `Monitor.run` over Control with journaled beats and default heals), composed durably with Poll in example 38
- Evidence: packages/control/test/Monitor.test.ts::resumes a stalled run once and stops when the resume moves it
- Evidence: examples/test/38-monitor-and-alert.test.ts

## Sidecar

- Parity: Yes (1.0.0-rc.0)
- New: `Sidecar.make` and `Sidecar.run` (concurrent primary and quarantined shadow, optional score and delta)
- Evidence: packages/patterns/test/Sidecar.test.ts::returns the primary value when the shadow fails
- Evidence: packages/patterns/test/Sidecar.test.ts::puts the shadow behind a catch and leaves the primary bare
- Evidence: packages/patterns/test/Sidecar.test.ts::hands the scorer the pair run hands it

## Aspects and budgets

- Parity: Yes (1.0.0-rc.0)
- New: agent `Budget` service (token and latency budgets; fail, warn, or skip-remaining; usage projected from sealed steps and folded back on restart; `Budget.layerFromEnvelope`; skip-remaining is a typed never-retried skip)
- Evidence: packages/agent/test/Budget.test.ts::counts what the run spent before the restart, folded back from the replay
- Evidence: packages/agent/test/Budget.test.ts::skips every later step's model calls under skip-remaining

## Dynamic delegation and Trellis

- Parity: Yes (1.0.0-rc.0)
- New: `@smthrs/patterns` `Trellis` (model-authored plan schema, validate against the Recursion envelope with path-naming refusals, compile, make, run with re-authoring rounds and shared fuel)
- Evidence: packages/patterns/test/Trellis.test.ts::runs the authored plan with real concurrency and charges one fuel unit per leaf
- Evidence: packages/patterns/test/Trellis.test.ts::fails fuel_exhausted before running the third leaf

## Delegation chain

- Parity: Yes (1.0.0-rc.0)
- New: `@smthrs/patterns` `DelegationChain` (refine, plan, derisk rounds, tiered execution over per-rung Escalation with WithRetry, review, settle), ported onto Escalation's Reached or Exhausted result at integration
- Evidence: packages/patterns/test/DelegationChain.test.ts::escalates a leaf that fails on the weakest tier and succeeds on the next
- Evidence: packages/patterns/test/DelegationChain.test.ts::fails with the leaf path once every tier has spent maxAttempts

## Memory Trellis

- Parity: Yes (1.0.0-rc.0)
- New: `@smthrs/memory` `WithMemory` policy annotation applied to a flow tree and `MemoryTrellis.make`; memory flows resolve the namespace, budget, and refusals from the annotation, bound through `StandardFlows.memory`
- Evidence: packages/memory/test/WithMemory.test.ts::annotates the flow and every flow it declares
- Evidence: packages/memory/test/WithMemory.test.ts::resolves a delegated leaf's recall to the trellis namespace over the real store

## Agent memory

- Parity: Yes

## Durable engine

- Parity: Yes (1.0.0-rc.0)
- New: `NodeRuntime.layerHost` (one composition: contained host, kernel HostServices with grants, default StepBoundary and WorkspaceSandbox, default lease liveness, SIGINT and SIGTERM handling with a shutdown deadline)
- Evidence: packages/flows/test/NodeRuntime.test.ts::runs a sealed host-reading action with nothing but its own options
- Evidence: packages/flows/test/NodeRuntimeSignals.integration.test.ts::releases the run it was driving and exits on its own
- Deferred for rc.0 (X-07, known limitations "Wake and supervision"): cross-process event-driven wake (A58b); `WakeBus` is in-process and a deferred completed elsewhere lands through the heartbeat poll and sweeps, documented as the polling bound per PLAN.md Phase 5

## Crash recovery and resume

- Parity: Yes (1.0.0-rc.0)
- New: `Ownership.leaseLiveness` as the default `isAlive` (lease-expired steal evidence; a fresh process reclaims a hard-killed owner with no host code) and `RestartableEngine.kill`
- Evidence: packages/engine-store/test/HardKillReclaim.test.ts::reclaims a run left running by a process that was actually SIGKILLed
- Evidence: packages/engine-store/test/HardKillReclaim.test.ts::does not steal a running run whose heartbeat is still fresh

## Cancellation and pause

- Parity: Yes (1.0.0-rc.0)
- New: attributed cancel (`RunSummary.cancellation` with requestedAt, principal, reason, and source control, engine, or cascade) with cascade attribution on children
- Evidence: packages/control/test/EngineCancellation.test.ts::reports the interrupted parent as engine-decided and its child as a cascade
- Deferred for rc.0 (X-03 and X-14, known limitations "Pause"): attributed pause (A60b); the engine has no pause verb and records no actor, so rc.0 documents `Control.pause` as explicitly unsupported per PLAN.md Phase 5

## Time travel

- Parity: Yes
- Old runnable example: `examples/time-travel-demo.jsx`
- New runnable example: `flows/examples/src/06-time-travel-rewind.ts`

## Workspace checkpoints

- Parity: Deferred for rc.0
- Enforcement (X-06 and X-19, known limitations "Checkpoints and worktree lanes"): the checkpoint, restore, revert, `replay`, and worktree-lane verbs are removed rather than approximated; time-travel fork and rewind over stored state plus `StepBoundary` are the supported scope, per PLAN.md Phase 5

## Local sandbox

- Parity: Yes

## Worktrees and VCS

- Parity: Yes (1.0.0-rc.0)
- New: `Jj.root` and `Jj.revert` as optional service members (NodeJj implementations, `jj:root` and `jj:revert` capability actions, kernel decorator forwards a backend's absence; jj children spawn through the contained spawner)
- Evidence: packages/jj/test/NodeJj.test.ts::answers the repository root from a directory inside it
- Evidence: packages/jj/test/NodeJj.test.ts::undoes one change and reports the paths it touched
- Deferred for rc.0 (X-06): scoped `withWorkspace` and worktree lanes, dropped by ruling; see Workspace checkpoints

## Remote sandbox providers

- Parity: Yes (1.0.0-rc.0)
- New: optional `Provider.kill` and `Provider.ping`, `SandboxSupervision` (probe on an interval, retire an unhealthy session, open a fresh one), and the `ProviderConformance` suite run against TestRemote and the real local-process provider
- Evidence: packages/sandbox/test/SandboxSupervision.test.ts::lets a retry policy land the failed action on a fresh session
- Evidence: packages/sandbox/test/ProviderConformance.test.ts::names a provider whose declared ping does not answer

## SQLite storage

- Parity: Yes
- Enforcement (X-13): `NodeDatabase.layer` refuses a file that has at least one table and no `flows_migrations` table, with the typed `UnsupportedDatabase` code `unsupported_database_file`, so a 0.x `smithers.db` can never gain `flows_*` tables beside its `_smithers_*` ones
- Evidence: packages/database/test/NodeDatabaseGuard.test.ts::refuses a file that has tables and no flows_migrations table
- Evidence: packages/database/test/NodeDatabaseGuard.test.ts::opens a database that carries the flows_migrations table

## Postgres and PGlite storage

- Parity: Deferred for rc.0
- Enforcement (X-01, known limitations "Databases"): rc.0 is SQLite-only; a non-SQLite client fails clearly at migration time instead of failing late, per PLAN.md Phase 5. The CLI half, `--backend` and `SMITHERS_BACKEND` exiting 1 with `unsupported_database`, is triage item W-16, held as an apply-ready diff until the Phase 4 CLI lane lands

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

- Parity: Deferred for rc.0
- Enforcement (X-09, known limitations "Triggers, evaluation, integrations, and UI"): dropped by scope ruling; `@smthrs/evals` stays private and no candidate-search API ships in rc.0

## OpenAPI tools

- Parity: Deferred for rc.0
- Enforcement (X-09, known limitations "Triggers, evaluation, integrations, and UI"): dropped by scope ruling; the `smithers openapi` verb is removed and no spec-driven flow surface ships (std keeps Fetch, HttpPost, WebFetch over the kernel HttpClient)

## External integrations

- Parity: Yes (1.0.0-rc.0)
- New: `@smthrs/integrations` ports GitHub, Linear, and Telegram onto Action, `@smthrs/triggers` Webhook and Channel, Control, and the Credential stores
- Evidence: packages/integrations/test/Actions.test.ts::posts a comment and decodes what GitHub returned
- Evidence: packages/integrations/test/Actions.test.ts::resolves the team by key and files the issue
- Evidence: packages/integrations/test/Actions.test.ts::sends a message and reports every chunk id
- Evidence: packages/integrations/test/WebhookChannel.test.ts::accepts the correctly signed delivery and starts the flow
- Evidence: packages/integrations/test/WebhookChannel.test.ts::applies a correctly signed delivery once and reports the retry as AlreadyApplied
- Evidence: packages/integrations/test/GitHubLive.test.ts (live, GITHUB_TOKEN)
- Evidence: packages/integrations/test/LinearLive.test.ts (live, LINEAR_API_KEY)
- Note: the JSX components and the old signal delivery are gone; Telegram's live suite is written and skips without TELEGRAM_BOT_TOKEN

## Schedules

- Parity: Yes

## Durable alerts

- Parity: Yes (1.0.0-rc.0)
- New: `@smthrs/notifications` `Alerts` (Policy rules keyed by condition with afterMs and severity, pure `decide` on journal time, `AlertRuntime` with coalesced admission, an injected Sink, and journaled at-least-once delivery deduplicated by alertId)
- Evidence: packages/notifications/test/Alerts.test.ts::stays quiet until the delay elapses and then admits one coalesced event
- Evidence: packages/notifications/test/Alerts.test.ts::never delivers the same alert twice, however often it ticks

## CLI

- Parity: Pending Phase 4 (cli-ops)
- Gap: the imported CLI covers plan, run, approve, deny, cancel, signal, ls, ps, status, logs, and up; the remaining old verb set ports in the Phase 4 CLI and operations lane after the core-runtime bridge, and unsupported commands must fail with an explicit migration message

## MCP server

- Parity: Pending Phase 4 (cli-ops)
- Gap: the imported tree ships no MCP tools; Control RPCs are the backend for run_workflow, get_run, list_runs, watch_run, resolve_approval, ask_human, fork_run, and rewind_run

## Gateway and RPC

- Parity: Pending Phase 4 (ui-gateway)
- Gap: the old gateway, server, protocol, and gateway-client packages retarget onto `@smthrs/control` RPCs, `@smthrs/sync`, and GatewaySchema for the Plue cutover

## Product UI

- Parity: Pending Phase 4 (ui-gateway)
- Gap: conditional on the gateway retarget (A79) and the Flows UI import (apps/ui)

## Operator TUI

- Parity: Yes

## Live client sync

- Parity: Yes
- Gap: none for rc.0. `RunCatalog.makePolling` (`packages/sync/src/RunCatalog.ts`) re-reads a durable source on `intervalMs` (default 1 s), and `@smthrs/engine-store`'s `RunCatalogRead` supplies the workspace's run set from `flows_runs`; `packages/run-store` is untouched. A follower is woken by entries committed in the serving process and by catalog announcements, and polls every `SyncServer.defaultTailIntervalMs` for what another engine process wrote; it is not an event-driven cross-process feed. Catch-up is polling because rc.0 has no cross-process event-driven wake, which stays deferred (rc-contract section 7, "Wake and supervision").

## Electric sync proxy

- Parity: Pending Phase 4 (ui-gateway)
- Gap: delete disposition; `@smthrs/sync` is the read-only replication protocol

## Workflow-specific UIs

- Parity: Pending Phase 4 (ui-gateway)
- Gap: per-app disposition of the .smithers workflow UIs and the apps/smithers* POCs; remove each unless a product requirement survives migration

## Observability

- Parity: Yes

## Hosted tenancy and billing

- Parity: Plue-owned

## Workflow packs

- Parity: Yes (1.0.0-rc.0)
- New: `@smthrs/registry` `Pack` (Manifest schema, `Pack.read`, content-addressed `Pack.digest`, `Pack.compatible` with npm caret semantics, `Registry.layerFromPacks` merging sources with local-over-installed shadowing warnings)
- Evidence: packages/registry/test/Pack.test.ts::shadows an installed flow with the local one and warns naming both packs
- Evidence: packages/registry/test/Pack.test.ts::reads a caret on a zero-major line as npm does: the minor is the pin

## Init pack and starters

- Parity: Pending Phase 4 (cli-ops)
- Gap: `smithers init` seeding over the pack manifest; the A87 pack manifest it depends on shipped in rc.0

## Runtime portability

- Parity: Deferred for rc.0
- Enforcement (X-18): the Bun durable engine stays unsupported; `NodeDatabase.layer` refuses to open a durable database when `process.versions.bun` is set, with the typed `UnsupportedDatabase` code `unsupported_runtime` (A89a, dropped by ruling); edge and serverless claims are limited to browser-bundleable APIs, with the Cloudflare and Vercel adapters experimental in the plugins repository (A89b), per PLAN.md Phase 5
- Evidence: packages/database/test/NodeDatabaseGuard.test.ts::refuses to open the durable database under Bun
- Evidence: packages/database/test/NodeDatabaseGuard.test.ts::refuses before it inspects the file, so an in-memory database is refused too

## Workflow testing

- Parity: Yes

## Fault and durability testing

- Parity: Yes

## Open code review

- Parity: Pending Phase 4 (integrations)
- Gap: apps/review and the review workflows migrate as an application flow on the new engine

## Herdr supervision and hijack

- Parity: Deferred for rc.0
- Enforcement (X-02 for hijack and X-10 for supervision, known limitations "Hijack" and "Wake and supervision"): the hijack verbs and symbols (packages/herdr, `smithers hijack`, HijackState) are removed rather than ported; flows ships no RunControl hook, per PLAN.md Phase 5

## Docs pipeline

- Parity: Pending Phase 4 (docs-examples)
- Gap: reconcile the old Mintlify docs and `pnpm docs:llms` with the imported waku site (docs/pages.gen.ts)

## Docs-driven development

- Parity: Not a runtime feature
