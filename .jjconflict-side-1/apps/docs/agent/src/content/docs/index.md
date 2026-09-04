---
title: "@smthrs/agent"
description: "The Smithers agent: the production agent loop composed on the durable engine, plus the two adapters that run it, AgentSession for control-plane runs and AgentAction for typed workflow steps"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/docs/README.md"
---

`@smthrs/agent` is the Smithers agent and the two ways to run it.

`Agent` is the agent: one service whose single method runs one whole cell loop
on the durable engine. A cell is the JavaScript program the model emits each
frame. It runs in a QuickJS sandbox, and its only authority is
`ctx.call(flowName, input)`, so every capability a cell reaches is an ordinary
flow settling through a durable boundary. The loop returns a framework-neutral
`Stream<AgentEvent>`: there is no callback, no event emitter, and no
host-shaped result type. A caller renders the stream, journals it, or ignores
it.

Two adapters run that loop, and neither reimplements it:

- `AgentSession` runs the agent as one durable control-plane run. The launch is
  a flow execution, the events go to the journal, and an operator steers and
  approves it. It is the production `ControlExecutor` for
  [`@smthrs/control`](https://control.smithers.sh/reference/api/).
- `AgentAction` runs the same agent as one typed step inside a larger flow,
  bounded by a declared output schema and replayed like any other action.

## Who uses this package

Workflow authors use `AgentAction` to add a model-backed step to a flow. Hosts
and control planes use `AgentSession` and `Agent` to run durable agent sessions
an operator can watch, steer, and approve.

## Install

```bash
pnpm add @smthrs/agent
```

For the full dependency picture and the import forms, see
[Installation](/installation/).

## The smallest declaration

A model-backed step is an ordinary action whose implementation ships with its
declaration:

```ts
import { AgentAction } from "@smthrs/agent"
import * as Schema from "effect/Schema"

const Research = AgentAction.make("docs/Research", {
  payload: { topic: Schema.String },
  output: Schema.Struct({ summary: Schema.String }),
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You are a research assistant."],
  prompt: ({ topic }) => `Research ${topic}.`
})
```

`Research.call({ topic })` records the same plan node any other action records,
`Research.layer` is the already-written implementation, and the declared
`output` schema is rendered into the run's teaching and enforced against its
final answer. For a runnable first success, including the composition that
executes this step with no API key, see the [Quickstart](/quickstart/).

## The package at a glance

The root entry point exports these namespaces, and each is also importable
from `@smthrs/agent/<Module>`:

| Namespace | What it is |
| --- | --- |
| `Agent` | The agent: one service whose `run` executes one whole cell loop and returns its event stream. |
| `AgentSession` | The production `ControlExecutor`: the agent as one durable control-plane run. |
| `AgentAction` | A model-backed step: an ordinary action with the agent loop as its shipped implementation. |
| `Seat`, `SeatResolver` | The declared model string and the credentialed seam that resolves it into a live model. |
| `QuotaPolicy` | Classifies a provider refusal as a wait with a deadline, so a run parks instead of failing. |
| `Budget` | Accumulates what a run spends across its model calls and refuses past the approved ceiling. |
| `EventSink` | An optional tap that receives each agent event while a step runs. |
| `StandardFlows` | The built-in capabilities as flows: filesystem, shell, tests, memory, durable wait, approval. |
| `ChildFlows`, `EngineChildren` | Detached child agents: the `agent/spawn`, `agent/send`, and `agent/await` flows plus the durable port behind them. |
| `CellPlugin` | The cell hooks of the shared plugin kernel: registry, flows, and model-request waterfalls. |
| `PromoteFlows`, `FlowStore` | Saving the script a run wrote as a discoverable flow, and the store its files land in. |
| `FlowEngineLike` | The harness engine port implemented on the durable engine from [`@smthrs/engine`](https://engine.smithers.sh/reference/api/). |
| `Checkpointed` | Runs one cell call against a pinned tree instead of the live one. |
| `WorkspaceSandbox`, `InMemoryWorkspaceSandbox` | The workspace transaction contract and its in-memory implementation. |
| `WorkspaceObservation` | Measures the workspace around a frame, so mutation accounting is a fact about the tree. |
| `MemorySnapshotRecorder` | Durable memory snapshots through the engine port. |

Every export of every namespace, with signatures and errors, is on the
[API reference](/reference/api/).

## Where to go next

- [Installation](/installation/): requirements, import forms, and the
  packages a real composition adds.
- [Quickstart](/quickstart/): run a typed model-backed step end to end with
  a scripted model.
- Guides: [model-backed steps](/guides/model-backed-steps/),
  [structured output](/guides/structured-output/),
  [quota waits and budgets](/guides/quota-and-budgets/),
  [control-plane runs](/guides/control-plane-runs/),
  [capabilities](/guides/capabilities/), [subagents](/guides/subagents/),
  [seat resolvers](/guides/seat-resolvers/),
  [workspace isolation](/guides/workspace/),
  [promoting flows](/guides/promote-flows/), and
  [testing](/guides/testing/).
- Concepts: [the agent loop](/concepts/agent-loop/),
  [seats](/concepts/seats/), [the engine port](/concepts/engine-port/),
  and [the three policies](/concepts/policies/).
- [Troubleshooting](/troubleshooting/): the typed failures this package
  reports, what causes them, and what to change.
