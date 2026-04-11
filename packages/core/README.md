# @smithers/core

React-free [Effect](https://effect.website) core for Smithers workflow execution.

Most Smithers users write workflows in JSX and never touch this package directly — the React driver handles it. `@smithers/core` is for **driver authors**, **custom runtimes**, and anyone who needs workflow orchestration without React.

## How It Works

A Smithers workflow is a tree of tasks with dependencies, control flow, approvals, and loops. The core's job is to look at that tree and answer one question: **what should happen next?**

```text
                    ┌──────────────────────────────────┐
                    │         YOUR DRIVER               │
                    │  (React, CLI, test harness, etc.) │
                    └────────┬───────────▲──────────────┘
                             │           │
                    facts go down    decisions come up
                             │           │
                    ┌────────▼───────────┴──────────────┐
                    │         @smithers/core             │
                    │                                    │
                    │  HostNode tree                     │
                    │    ↓ extractGraph()                │
                    │  WorkflowGraph                    │
                    │    ↓ submitGraph()                 │
                    │  Scheduler ──→ EngineDecision      │
                    │    ↑                               │
                    │  taskCompleted() / eventReceived() │
                    └───────────────────────────────────┘
```

The driver tells the core what happened (a task finished, an approval was granted, a timer fired). The core tells the driver what to do next (execute these tasks, wait for an event, you're done). The core never executes tasks itself — it only schedules.

### The Decision Loop

Every interaction with a session follows the same pattern:

```text
        Driver                          Core
          │                               │
          │──── submitGraph(graph) ──────→│
          │                               │──→ build plan tree
          │                               │──→ schedule tasks
          │←── Execute { tasks: [a, b] } ─│
          │                               │
          │  (driver runs tasks a and b)  │
          │                               │
          │──── taskCompleted(a) ─────────→│
          │←── Execute { tasks: [c] } ────│  (c depended on a)
          │                               │
          │──── taskCompleted(b) ─────────→│
          │←── Wait { Approval } ─────────│  (d needs approval)
          │                               │
          │  (user approves)              │
          │                               │
          │──── approvalResolved(d) ──────→│
          │←── Execute { tasks: [d] } ────│
          │                               │
          │──── taskCompleted(d) ─────────→│
          │←── Finished { result } ───────│
```

There are six possible decisions:

| Decision | Meaning |
|---|---|
| `Execute` | Run these tasks now |
| `ReRender` | The tree changed — re-render and resubmit |
| `Wait` | Block until an external event (approval, timer, signal, retry backoff) |
| `ContinueAsNew` | Workflow is cycling — start a fresh run with carried-over state |
| `Finished` | All tasks complete, here's the result |
| `Failed` | Unrecoverable error |

## Realistic Example

Here's a complete driver that runs a three-task pipeline: fetch data, get human approval, then process.

```ts
import {
  extractGraph,
  makeWorkflowSession,
  runPromise,
  type HostNode,
} from "@smithers/core";

// 1. Build the workflow tree
//    (React drivers build this from JSX — here we do it by hand)
const workflow: HostNode = {
  kind: "element",
  tag: "smithers:workflow",
  props: { name: "data-pipeline" },
  rawProps: { name: "data-pipeline" },
  children: [
    {
      kind: "element",
      tag: "smithers:sequence",
      props: {},
      rawProps: {},
      children: [
        // Task 1: fetch data
        {
          kind: "element",
          tag: "smithers:task",
          props: { id: "fetch" },
          rawProps: {
            id: "fetch",
            __smithersKind: "compute",
            __smithersComputeFn: () =>
              fetch("https://api.example.com/data").then((r) => r.json()),
          },
          children: [],
        },
        // Task 2: human reviews the data before processing
        {
          kind: "element",
          tag: "smithers:task",
          props: { id: "review" },
          rawProps: {
            id: "review",
            __smithersKind: "static",
            needsApproval: true,
          },
          children: [],
        },
        // Task 3: process (only runs after approval)
        {
          kind: "element",
          tag: "smithers:task",
          props: { id: "process" },
          rawProps: {
            id: "process",
            __smithersKind: "compute",
            __smithersComputeFn: () => ({ processed: true }),
          },
          children: [],
        },
      ],
    },
  ],
};

// 2. Extract graph and create session
const graph = extractGraph(workflow);
const session = makeWorkflowSession({ runId: "run_001" });

// 3. Drive the execution loop
let decision = await runPromise(session.submitGraph(graph));

loop: while (true) {
  switch (decision._tag) {
    case "Execute":
      for (const task of decision.tasks) {
        try {
          const output = task.computeFn
            ? await task.computeFn()
            : task.staticPayload;
          decision = await runPromise(
            session.taskCompleted({
              nodeId: task.nodeId,
              iteration: task.iteration,
              output,
            }),
          );
        } catch (err) {
          decision = await runPromise(
            session.taskFailed({
              nodeId: task.nodeId,
              iteration: task.iteration,
              error: err,
            }),
          );
        }
      }
      break;

    case "Wait":
      if (decision.reason._tag === "Approval") {
        // Your driver decides how to get approval — UI, Slack, CLI prompt, etc.
        const approved = await askHumanForApproval(decision.reason.nodeId);
        decision = await runPromise(
          session.approvalResolved(decision.reason.nodeId, { approved }),
        );
      }
      break;

    case "Finished":
      console.log("Done:", decision.result);
      break loop;

    case "Failed":
      console.error("Failed:", decision.error);
      break loop;

    default:
      break loop;
  }
}
```

Compare this to what most Smithers users write (using the React driver):

```tsx
/** @jsxImportSource smithers */
export default smithers(() => (
  <Workflow name="data-pipeline">
    <Sequence>
      <Task id="fetch">{() => fetch("https://api.example.com/data").then(r => r.json())}</Task>
      <Task id="review" needsApproval>{{ reviewed: true }}</Task>
      <Task id="process">{() => ({ processed: true })}</Task>
    </Sequence>
  </Workflow>
));
```

The JSX compiles down to the same `HostNode` tree. `@smithers/core` handles everything after that.

## Install

```bash
bun add @smithers/core
```

**Peer dependency:** `effect@^3.21.0`

---

## Architecture

```text
SmithersCoreLayer
├── CorrelationContextLive     ← request-scoped tracing context
├── MetricsServiceLive         ← counters, histograms, Prometheus export
├── TracingServiceLive         ← spans and log annotations
├── SchedulerLive              ← plan tree + task scheduling (depends on metrics, tracing)
├── DurablePrimitivesLive      ← approval, event, timer, continue-as-new primitives
├── ExecutionServiceLive       ← runs computeFn / returns staticPayload
└── WorkflowSessionLive        ← the call-in API that ties it all together
```

Drivers can swap any layer. For example, replace in-memory storage with SQLite and in-memory durables with Temporal:

```ts
import { Layer } from "effect";
import { SmithersCoreLayer } from "@smithers/core/runtime";
import { SqliteStorageLive } from "./storage.ts";
import { TemporalDurablesLive } from "./temporal.ts";

const DriverLayer = Layer.mergeAll(
  SmithersCoreLayer,
  SqliteStorageLive,
  TemporalDurablesLive,
);
```

---

## Key Concepts

### WorkflowGraph

`extractGraph(hostTree)` turns a `HostNode` tree into a `WorkflowGraph`:

```ts
type WorkflowGraph = {
  xml: XmlElement | null;      // normalized tree structure (serializable, no functions)
  tasks: TaskDescriptor[];     // flat list of executable units of work
  mountedTaskIds: string[];    // "nodeId::iteration" keys for currently mounted tasks
};
```

The XML tree captures structure (sequences, parallels, loops). The task list captures what needs to run (compute functions, agent configs, approval gates). The scheduler uses both.

### WorkflowSession

One session per workflow run. The driver submits facts, the session returns decisions:

```ts
const session = makeWorkflowSession({ runId: "run_001" });

// Submit a graph → get first decision
session.submitGraph(graph)        // → EngineDecision

// Report task outcomes → get next decision
session.taskCompleted(output)     // → EngineDecision
session.taskFailed(failure)       // → EngineDecision

// Report external events → get next decision
session.approvalResolved(id, res) // → EngineDecision
session.eventReceived(name, data) // → EngineDecision
session.timerFired(id)            // → EngineDecision
session.signalReceived(name, data)// → EngineDecision

// Introspect
session.getTaskStates()           // → TaskStateMap
session.getSchedule()             // → ScheduleSnapshot | null
```

### Scheduler

The scheduler is pure — no side effects, no I/O. Given a plan tree and current task states, it returns which tasks are runnable:

```ts
const plan = buildPlanTree(graph.xml);
const result = scheduleTasks(plan, taskStates, descriptors, ralphState, retryWait, nowMs);
// result.runnable: TaskDescriptor[]  — ready to execute
// result.pendingExists: boolean      — more work remains
// result.waitingApprovalExists       — blocked on human
```

### Task States

Every task moves through a state machine:

```text
pending → in-progress → finished
                      → failed → (retry) → in-progress
       → waiting-approval → in-progress
       → waiting-event → in-progress
       → waiting-timer → in-progress
       → skipped
       → cancelled
```

---

## Import Paths

```ts
import { … } from "@smithers/core";             // everything
import { … } from "@smithers/core/graph";        // extractGraph, HostNode, WorkflowGraph, TaskDescriptor
import { … } from "@smithers/core/session";      // WorkflowSession, EngineDecision, makeWorkflowSession
import { … } from "@smithers/core/scheduler";    // buildPlanTree, scheduleTasks, PlanNode
import { … } from "@smithers/core/state";        // TaskState, TaskStateMap, buildStateKey
import { … } from "@smithers/core/persistence";  // StorageService, makeInMemoryStorageService
import { … } from "@smithers/core/observability"; // MetricsService, TracingService, CorrelationContext
import { … } from "@smithers/core/durables";      // DurablePrimitives, ApprovalResolution
import { … } from "@smithers/core/execution";     // ExecutionService
import { … } from "@smithers/core/interop";       // fromPromise, fromSync (Effect ↔ Promise helpers)
import { … } from "@smithers/core/runtime";       // SmithersCoreLayer, runPromise, runSync, runFork
import { … } from "@smithers/core/errors";        // SmithersError, EngineError, error codes
```

> For the full API reference with every export, see [`docs/README.md`](./docs/README.md).

---

## License

See the repository root for license information.
