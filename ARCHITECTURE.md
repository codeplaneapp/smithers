# Smithers Architecture

This design is optimized around three non-negotiables:

1. **Plan before execute** — `build_graph()` is the plan. Execution only consumes a frozen plan.
2. **SQLite as the system of record** — all state (plan, runs, node status, cache, events, approvals, LLM/tool transcripts) lives in SQLite.
3. **Verification + constant visibility drive everything** — every step is validated, hashed, logged, and queryable in near-real time.

---

## 1. Goals, Requirements, and Invariants

### Primary Goals

- **Deterministic planning**: `build_graph(target)` produces a **WorkflowGraph Plan** that is stable and serializable.
- **Correct dependency resolution**: dependencies are derived from type hints with explicit, debuggable rules.
- **Declarative iteration**: Ralph loops provide iteration without abandoning the DAG model.
- **Verifiable execution**:
  - Every workflow output is validated against its declared type.
  - Every cache hit is validated (schema + hash).
  - Every tool call input/output is validated.
  - Every state transition is persisted to SQLite.
- **Visibility by default**: a separate process (CLI "watch", future web UI) can show progress by querying SQLite without needing in-process hooks.
- **Testability**: workflows can be called directly, graphs can be tested without execution, and `claude()` can be mocked/replayed deterministically.

### Explicit Non-Goals (v1)

- Distributed execution across machines.
- Multi-writer remote DB with concurrency beyond SQLite best practices.
- Automatic module scanning "magic" across arbitrary imports (unless explicitly opted in).
- **Arbitrary graph cycles** — We intentionally avoid LangGraph-style state machines. Ralph loops are the controlled, declarative alternative.

### System Invariants (Verification Backbone)

These are enforced by code and assertable in tests:

- **I1**: A `WorkflowGraph` must be a DAG (cycle detection at plan time). Ralph loops are single nodes that internally iterate.
- **I2**: Each node's declared `output_type` must be validated at runtime (Pydantic `TypeAdapter`).
- **I3**: Every node run is content-addressed: `node_cache_key = H(workflow_identity + workflow_code_hash + input_hash + runtime_hash)`.
- **I4**: Every node state transition is persisted to SQLite (append-only events + current-state tables).
- **I5**: Cache entries must be schema-valid and hash-consistent or treated as corrupt/miss.
- **I6**: Approval is an explicit persisted gate; execution can pause and resume from SQLite.
- **I7**: Ralph loop iterations are individually tracked: each iteration has its own events, timing, and optional caching.

---

## 2. Architecture Overview

### System Diagram (Plan → Execute → Observe)

```mermaid
flowchart TB
  subgraph U[User Code]
    WF["@workflow async fns"]
    API[build_graph / run_graph / claude]
  end

  subgraph C[Smithers Core]
    REG["WorkflowRegistry<br/>OutputType → Workflow"]
    PLAN["GraphBuilder<br/>+ GraphVerifier"]
    G["WorkflowGraph<br/>Serializable Plan"]
    RALPH["RalphLoop<br/>Declarative Iteration"]
    EXE["ExecutionEngine<br/>Async Scheduler"]
    RT["RuntimeContext<br/>contextvars"]
    EVT["EventBus<br/>in-proc fanout"]
  end

  subgraph A[Adapters]
    STORE["SqliteStore<br/>(Cache + Runs + Events + Approvals)"]
    LLM[LLMProvider: Claude]
    TOOLS["ToolRegistry<br/>Read/Edit/Bash + custom"]
    APPROVER["ApprovalProvider<br/>CLI / webhook / polling"]
  end

  subgraph O[Visibility]
    WATCH["smithers watch<br/>tail events"]
    UI["future web UI<br/>reads SQLite"]
    REPORT["Run reports<br/>timings/costs"]
  end

  WF -->|decorator registers| REG
  API --> PLAN
  PLAN --> REG
  PLAN --> G
  PLAN -->|persist plan| STORE

  API --> EXE
  EXE --> RT
  EXE --> STORE
  EXE --> LLM
  EXE --> TOOLS
  EXE --> APPROVER
  EXE --> EVT

  EVT --> STORE

  STORE --> WATCH
  STORE --> UI
  STORE --> REPORT
```

**Design choice**: SQLite is not "just a cache." It's the **execution ledger** + cache + event log. This enables constant visibility and the "LLM can monitor / human can patch state" workflow.

---

## 3. Module Structure

```text
smithers/
  __init__.py                 # exports: workflow, require_approval, build_graph, run_graph, claude, SqliteCache
  core/
    types.py                  # shared type aliases, enums
    errors.py                 # structured exceptions
    workflow.py               # Workflow wrapper + @workflow decorator
    registry.py               # WorkflowRegistry
    graph.py                  # WorkflowGraph data structures + serialization
    builder.py                # build_graph + cycle detection + levelization
    executor.py               # run_graph + scheduler + dependency plumbing
    runtime.py                # RuntimeContext via contextvars, dependency injection
    events.py                 # Event models + sinks
    hashing.py                # canonical JSON + hashing primitives
    verification.py           # graph invariants + cache integrity checks
  llm/
    provider.py               # LLMProvider protocol
    claude.py                 # Claude implementation (tool loop, structured output)
    prompts.py                # prompt formatting, JSON schema helpers
  tools/
    base.py                   # Tool protocol + pydantic IO adapters
    registry.py               # ToolRegistry (names → Tool)
    builtins/
      read.py
      edit.py
      bash.py
  store/
    sqlite.py                 # SqliteStore impl (tables, queries, transactions)
    migrations.py             # schema init + migrations
  approvals/
    base.py                   # ApprovalProvider protocol
    cli.py                    # CLI implementation
  testing/
    fakes.py                  # FakeLLMProvider, FakeTools
    replay.py                 # record/replay from SQLite for deterministic tests
    helpers.py                # test utilities
  cli/
    main.py                   # smithers CLI entry
    commands/
      run.py
      graph.py
      watch.py
      approve.py
      inspect.py
```

---

## 4. Core Data Structures

### 4.1 Shared Types and Enums

```python
# smithers/core/types.py
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, NewType, TypeAlias

RunId = NewType("RunId", str)
NodeId = NewType("NodeId", str)
WorkflowId = NewType("WorkflowId", str)
CacheKey = NewType("CacheKey", str)

JsonValue: TypeAlias = Any  # must be JSON-serializable at persistence boundary

class NodeStatus(str, Enum):
    PENDING = "PENDING"
    READY = "READY"
    RUNNING = "RUNNING"
    CACHED = "CACHED"
    SUCCESS = "SUCCESS"
    SKIPPED = "SKIPPED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    PAUSED = "PAUSED"

class RunStatus(str, Enum):
    PLANNED = "PLANNED"
    RUNNING = "RUNNING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    PAUSED = "PAUSED"

@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 1
    backoff_seconds: float = 0.0
    backoff_multiplier: float = 1.0
    retry_on: tuple[type[BaseException], ...] = ()
```

### 4.2 Workflow Metadata and Wrapper

```python
# smithers/core/workflow.py
from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Awaitable, Callable, Generic, ParamSpec, TypeVar, get_type_hints

from pydantic import TypeAdapter

from .types import WorkflowId, RetryPolicy

P = ParamSpec("P")
R = TypeVar("R")

@dataclass(frozen=True)
class WorkflowParam:
    name: str
    annotation: object  # original type hint
    adapter: TypeAdapter  # runtime validator/serializer

@dataclass(frozen=True)
class WorkflowMeta:
    id: WorkflowId
    name: str                   # human name (qualname)
    module: str
    qualname: str
    doc: str | None
    is_async: bool
    params: tuple[WorkflowParam, ...]
    return_annotation: object
    return_adapter: TypeAdapter
    code_hash: str              # source/code digest
    retry: RetryPolicy
    requires_approval: bool
    approval_prompt: str | None
    cacheable: bool

class Workflow(Generic[P, R]):
    """
    Callable wrapper around the user function.
    - Preserves direct callability for unit tests.
    - Carries metadata for graph building & caching.
    """
    __slots__ = ("fn", "meta")

    def __init__(self, fn: Callable[P, Awaitable[R]], meta: WorkflowMeta) -> None:
        self.fn = fn
        self.meta = meta

    def __call__(self, *args: P.args, **kwargs: P.kwargs) -> Awaitable[R]:
        return self.fn(*args, **kwargs)

    def signature(self) -> inspect.Signature:
        return inspect.signature(self.fn)
```

### 4.3 Registry

```python
# smithers/core/registry.py
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .workflow import Workflow
from .errors import DuplicateProducerError, MissingProducerError

@dataclass
class WorkflowRegistry:
    # Main lookup: "what produces type T?"
    by_output: dict[object, Workflow[Any, Any]] = field(default_factory=dict)

    # Secondary: stable identity
    by_id: dict[str, Workflow[Any, Any]] = field(default_factory=dict)

    def register(self, wf: Workflow[Any, Any]) -> None:
        out = wf.meta.return_annotation
        if out in self.by_output:
            raise DuplicateProducerError(out, self.by_output[out], wf)
        self.by_output[out] = wf
        self.by_id[str(wf.meta.id)] = wf

    def producer_for(self, annotation: object) -> Workflow[Any, Any]:
        if annotation not in self.by_output:
            raise MissingProducerError(annotation)
        return self.by_output[annotation]
```

### 4.4 Graph Plan Types

```python
# smithers/core/graph.py
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .types import NodeId, WorkflowId

@dataclass(frozen=True)
class DepBinding:
    """How a workflow parameter gets its value."""
    kind: Literal["node_output", "external_input", "injected"]
    param: str
    from_node: NodeId | None = None
    input_key: str | None = None
    injected_type: str | None = None

@dataclass(frozen=True)
class GraphNode:
    node_id: NodeId
    workflow_id: WorkflowId
    workflow_name: str
    module: str
    qualname: str
    code_hash: str

    return_type_repr: str
    param_bindings: tuple[DepBinding, ...]
    deps: tuple[NodeId, ...]

    cacheable: bool
    requires_approval: bool
    approval_prompt: str | None

@dataclass(frozen=True)
class WorkflowGraph:
    """Frozen execution plan. Serializable + hashable."""
    target: NodeId
    nodes: dict[NodeId, GraphNode]
    edges: dict[NodeId, tuple[NodeId, ...]]
    levels: tuple[tuple[NodeId, ...], ...]
    plan_hash: str

    def mermaid(self) -> str:
        lines = ["graph LR"]
        for from_node, to_nodes in self.edges.items():
            for to_node in to_nodes:
                lines.append(f"    {from_node} --> {to_node}")
        return "\n".join(lines)
```

---

## 5. The `@workflow` Decorator

### Responsibilities

1. Wrap the async function in a `Workflow` object (callable).
2. Extract and freeze introspection metadata:
   - input param annotations (dependencies)
   - return annotation (product/output type)
3. Create Pydantic `TypeAdapter`s for params and return type for:
   - runtime validation
   - canonical JSON dumping for hashing/caching
4. Compute a **workflow code hash** for cache invalidation.
5. Register the workflow into a **registry**.

### What it returns

A `Workflow[P, R]` instance (callable wrapper), **not** the raw function.

After decoration:
- `type(analyze)` is `Workflow`
- `await analyze()` still works (direct call)
- Dependencies are introspected from `analyze.meta.params`
- Output type is in `analyze.meta.return_annotation`

---

## 6. Workflow Registry & Discovery

### The Core Resolution Rule

Given a workflow parameter annotation, `build_graph` resolves it:

- **Exact match**: `analysis: AnalysisOutput` requires a producer with return annotation exactly `AnalysisOutput`.
- **Optional normalization**: if param is `AnalysisOutput | None`, normalize to `AnalysisOutput` for producer resolution.
- **Injected params**: if param annotation is `RunContext` (or other internal types), treat as injected (not a dependency edge).

### Error Cases

- **Multiple workflows produce same type**: Hard error at registration time (`DuplicateProducerError`).
- **No workflow produces required type**: Plan-time error (`MissingProducerError`).
- **Circular dependency**: Plan-time error (`CycleError`).

---

## 7. The `build_graph` Algorithm

### Phases

1. **Resolve dependencies** recursively starting from target.
2. **Construct nodes and edges** (DAG).
3. **Verify invariants** (cycles, missing deps).
4. **Compute levels** (parallel strata via Kahn's algorithm).
5. **Freeze + hash plan**.

### Pseudocode

```python
def build_graph(target_workflow: Workflow, registry: WorkflowRegistry) -> WorkflowGraph:
    nodes: dict[NodeId, GraphNode] = {}
    edges: dict[NodeId, set[NodeId]] = {}
    visiting: set[NodeId] = set()  # DFS recursion stack
    visited: set[NodeId] = set()

    def dfs(wf: Workflow) -> NodeId:
        nid = NodeId(str(wf.meta.id))
        if nid in visiting:
            raise CycleError(...)
        if nid in visited:
            return nid

        visiting.add(nid)
        deps = []

        for p in wf.meta.params:
            if is_injected(p.annotation):
                continue
            producer = registry.producer_for(p.annotation)
            dep_id = dfs(producer)
            deps.append(dep_id)
            edges.setdefault(dep_id, set()).add(nid)

        nodes[nid] = GraphNode(...)
        visiting.remove(nid)
        visited.add(nid)
        return nid

    target_id = dfs(target_workflow)
    levels = compute_levels(nodes, edges)
    plan_hash = hash_canonical_json(serialize_graph(...))

    return WorkflowGraph(target=target_id, nodes=nodes, edges=edges, levels=levels, plan_hash=plan_hash)
```

---

## 8. Ralph Loops: Declarative Iteration

### Why Ralph Loops?

Agentic workflows often require iteration — "review until approved", "refine until quality threshold", "retry until success". Traditional DAGs don't support cycles, but arbitrary graph cycles (like LangGraph's state machines) introduce complexity that conflicts with Smithers' Bazel-inspired philosophy.

**Ralph loops** provide a middle ground: declarative iteration that preserves the DAG model.

### Core Concept

A Ralph loop is a **single node** in the DAG that internally iterates. From the graph's perspective, it's atomic. Internally, it runs a workflow repeatedly until a condition is met.

```python
from smithers import workflow, ralph_loop, claude

class CodeOutput(BaseModel):
    code: str
    approved: bool = False

@workflow
async def review_and_revise(code: CodeOutput) -> CodeOutput:
    """Review code, revise if needed. Each call is one iteration."""
    review = await claude(f"Review: {code.code}", output=ReviewOutput)
    if review.approved:
        return CodeOutput(code=code.code, approved=True)
    revised = await claude(f"Fix: {review.feedback}", output=CodeOutput)
    return revised

# Create a Ralph loop
review_loop = ralph_loop(
    review_and_revise,
    until=lambda result: result.approved,
    max_iterations=5,
)

# Use in a graph like any other workflow
graph = build_graph(review_loop)
```

### Key Properties

1. **DAG-preserving**: The graph remains a DAG. The loop is one node.
2. **Declarative**: No imperative control flow. Just "run this until condition".
3. **Observable**: Each iteration emits events to SQLite (`LoopIterationStarted`, `LoopIterationFinished`).
4. **Cacheable**: Individual iterations can be cached by iteration index + input hash.
5. **Nestable**: Ralph loops can contain other Ralph loops.

### Mermaid Visualization

Ralph loops are rendered with a self-referential edge:

```mermaid
graph LR
    write_code --> review_loop
    review_loop -->|"🔄 max 5"| review_loop
    review_loop --> deploy
```

### Data Structures

```python
@dataclass(frozen=True)
class RalphLoopNode(GraphNode):
    """A graph node that iterates internally."""
    inner_workflow_id: WorkflowId
    max_iterations: int
    until_condition: str  # Serialized representation for visibility

@dataclass
class LoopIteration:
    """Tracking for a single iteration within a Ralph loop."""
    loop_node_id: NodeId
    iteration: int
    input_hash: str
    output_hash: str | None
    status: NodeStatus
    started_at: datetime
    finished_at: datetime | None
```

### Execution Model

1. **Entry**: Loop node receives input from upstream dependencies.
2. **Iterate**: Execute inner workflow with current state.
3. **Check**: Evaluate `until` condition on output.
4. **Continue or Exit**: If condition false and iterations < max, loop. Else, return output.
5. **Events**: Each iteration emits `LoopIterationStarted`, `LoopIterationFinished` to SQLite.

```python
async def execute_ralph_loop(
    loop: RalphLoopNode,
    initial_input: BaseModel,
    ctx: ExecutionContext,
) -> BaseModel:
    current = initial_input
    
    for i in range(loop.max_iterations):
        await emit_event(ctx, "LoopIterationStarted", {"iteration": i})
        
        # Execute inner workflow
        result = await execute_workflow(loop.inner_workflow, current, ctx)
        
        await emit_event(ctx, "LoopIterationFinished", {"iteration": i})
        
        # Check termination condition
        if loop.until_condition(result):
            return result
        
        current = result
    
    # Max iterations reached
    return current
```

### SQLite Schema Addition

```sql
-- loop_iterations: tracking for Ralph loop iterations
create table if not exists loop_iterations (
  run_id text not null,
  loop_node_id text not null,
  iteration integer not null,
  input_hash text not null,
  output_hash text,
  status text not null,
  started_at text not null,
  finished_at text,
  primary key (run_id, loop_node_id, iteration)
);
```

### Nested Ralph Loops

Ralph loops can be nested naturally:

```python
@workflow
async def inner_refinement(doc: DocOutput) -> DocOutput:
    """Refine document until quality threshold."""
    ...

@workflow
async def outer_review(doc: DocOutput) -> DocOutput:
    """Review and refine, may call inner refinement."""
    refined = await ralph_loop(inner_refinement, until=..., max_iterations=3)(doc)
    review = await claude(f"Final review: {refined}", output=ReviewOutput)
    ...

# Outer loop contains inner loop
full_pipeline = ralph_loop(outer_review, until=..., max_iterations=5)
```

### Comparison with LangGraph

| Aspect | Ralph Loops | LangGraph |
|--------|-------------|-----------|
| Graph model | DAG (loops are atomic nodes) | Cyclic graph |
| Complexity | Simple: one primitive | Complex: state machines |
| State | External (SQLite/files) | In-memory state dict |
| Visibility | Full iteration tracking | Custom state inspection |
| Philosophy | Bazel-like declarative | Flowchart-like imperative |

---

## 9. The `run_graph` Execution Engine

### Execution Model

- Consume a frozen `WorkflowGraph`.
- Create a **Run** row in SQLite with `plan_hash`.
- Create **RunNode** rows for each node.
- Execute levels in order, with nodes in each level running concurrently via `asyncio.TaskGroup`.
- For each node:
  - Compute cache key
  - Attempt cache read
  - On miss: execute workflow function with validated inputs
  - Validate output and persist
  - Emit events to SQLite throughout

### Error Handling

Default policy (fail-fast):
- If any node in a level fails, cancel remaining nodes and all downstream nodes.
- Persist which nodes were cancelled and failure root cause.
- Raise `RunFailed` with structured details.

---

## 10. The `claude()` Function

### Responsibilities

- Prepare a model request (prompt, system rules, tool specs).
- Run a **tool-using loop**:
  - LLM responds with either final answer or tool invocations
  - Runtime executes tools, records results, feeds back to LLM
- Validate final output using Pydantic v2.
- Emit structured events to SQLite for visibility.

### Structured Output Enforcement

- Always provide the output schema in the prompt (JSON Schema via Pydantic).
- Parse final message as JSON and validate with `TypeAdapter(output_type)`.
- On validation failure: emit event, optionally run repair attempts.

---

## 11. Tools System

### Tool Registry

- `tools=["Read", "Edit", "Bash"]` are names resolved through `ToolRegistry`.
- Each tool has:
  - Input schema (Pydantic model)
  - Output schema (Pydantic model or raw text)
  - Async function implementation

### Tool Protocol

```python
class Tool(Protocol):
    name: str
    input_model: Type[BaseModel]
    output_model: Type[BaseModel] | None

    async def run(self, *, ctx: ToolContext, args: BaseModel) -> BaseModel | str: ...
```

---

## 12. Caching System

### What is Hashed?

Cache key = `H(workflow_id + code_hash + input_hash + runtime_hash)`

- **Workflow identity**: `module:qualname`
- **Code hash**: digest of source/bytecode
- **Input hash**: canonical JSON of dependency outputs
- **Runtime hash**: smithers version, LLM model name

### SQLite Schema

```sql
-- cache entries: content-addressed results
create table if not exists cache_entries (
  cache_key text primary key,
  workflow_id text not null,
  code_hash text not null,
  input_hash text not null,
  runtime_hash text not null,
  output_json text not null,
  output_hash text not null,
  created_at text not null,
  last_accessed_at text not null
);

-- runs: each plan execution
create table if not exists runs (
  run_id text primary key,
  plan_hash text not null,
  target_node_id text not null,
  status text not null,
  created_at text not null,
  finished_at text
);

-- run_nodes: current status per node within a run
create table if not exists run_nodes (
  run_id text not null,
  node_id text not null,
  workflow_id text not null,
  status text not null,
  started_at text,
  finished_at text,
  cache_key text,
  output_hash text,
  skip_reason text,
  error_json text,
  primary key (run_id, node_id)
);

-- events: append-only log for constant visibility
create table if not exists events (
  event_id integer primary key autoincrement,
  run_id text not null,
  node_id text,
  ts text not null,
  type text not null,
  payload_json text not null
);

-- approvals: gates
create table if not exists approvals (
  run_id text not null,
  node_id text not null,
  prompt text not null,
  status text not null,
  decided_by text,
  decided_at text,
  primary key (run_id, node_id)
);

-- llm_calls: tracking for visibility + cost
create table if not exists llm_calls (
  call_id integer primary key autoincrement,
  run_id text not null,
  node_id text not null,
  ts_start text not null,
  ts_end text,
  model text not null,
  input_tokens integer,
  output_tokens integer,
  cost_usd real,
  request_json text,
  response_json text
);

-- tool_calls: tracking
create table if not exists tool_calls (
  tool_call_id integer primary key autoincrement,
  run_id text not null,
  node_id text not null,
  ts_start text not null,
  ts_end text,
  tool_name text not null,
  input_json text not null,
  output_json text,
  status text not null,
  error_json text
);
```

---

## 13. Human-in-the-Loop

### `@require_approval` Decorator

Attaches metadata to the function:
- `requires_approval = True`
- `approval_prompt = "message"`

### Pause/Resume Model

**Mode A: Interactive (CLI)**
- When node is reached, prompt user in-process.
- Decision written to `approvals` table.

**Mode B: Pausable/Resumable (Headless)**
- Record approval request in SQLite.
- Mark node `PAUSED`, run `PAUSED`.
- Later: `smithers approve --run RUN --node NODE --yes`
- Then: `smithers resume --run RUN`

---

## 14. Observability & Progress

### Event-First Observability

Everything emits events persisted to SQLite immediately:

- `RunStarted`, `RunFinished`, `RunFailed`, `RunPaused`
- `NodeReady`, `NodeStarted`, `NodeFinished`, `NodeFailed`, `NodeSkipped`, `NodeCached`
- `LoopIterationStarted`, `LoopIterationFinished`, `LoopMaxIterationsReached`
- `CacheHit`, `CacheMiss`, `CacheCorrupt`
- `ApprovalRequested`, `ApprovalDecided`
- `LLMCallStarted`, `LLMCallFinished`
- `ToolCallStarted`, `ToolCallFinished`

### CLI Commands

- `smithers watch ./cache.db --run <id>` — tail events live
- `smithers inspect ./cache.db --run <id>` — print node table

---

## 15. Testing

### A. Unit Test Workflows Directly

```python
async def test_implement_unit():
    analysis = AnalysisOutput(files=["a.py"], summary="x")
    out = await implement(analysis)
    assert "a.py" in out.changed_files
```

### B. Graph-Only Tests

```python
def test_graph_shape():
    g = build_graph(deploy)
    assert [len(level) for level in g.levels] == [1, 2, 1]
```

### C. Mock `claude()`

```python
from smithers.testing import FakeLLMProvider, use_runtime

async def test_analyze_with_fake_llm():
    fake = FakeLLMProvider(responses=[{"files": ["x.py"], "summary": "ok"}])
    async with use_runtime(llm=fake):
        out = await analyze()
        assert out.files == ["x.py"]
```

### D. Record/Replay

- First run (record): real Claude + tools, store transcripts in SQLite.
- Replay mode: executor reads transcripts and replays outputs without network.

---

## 16. Sequence Diagrams

### Build Plan

```mermaid
sequenceDiagram
  participant U as User
  participant B as GraphBuilder
  participant R as WorkflowRegistry
  participant S as SqliteStore

  U->>B: build_graph(target)
  B->>R: resolve producer for param types (DFS)
  R-->>B: Workflow objects
  B->>B: cycle check + node/edge build
  B->>B: compute levels
  B->>B: compute plan_hash
  B->>S: persist plan (optional)
  B-->>U: WorkflowGraph
```

### Execute with Caching

```mermaid
sequenceDiagram
  participant U as User
  participant E as ExecutionEngine
  participant S as SqliteStore
  participant W as Workflow
  participant L as ClaudeProvider

  U->>E: run_graph(graph, cache=SqliteStore)
  E->>S: create_run(plan_hash), seed run_nodes
  loop each level
    par each node in level
      E->>S: compute cache_key + cache_get
      alt cache hit
        S-->>E: output_json
        E->>E: validate output
        E->>S: set status CACHED
      else cache miss
        E->>S: set status RUNNING
        E->>W: await wf(dep_outputs...)
        W->>L: await claude(...)
        L-->>W: structured output
        W-->>E: return output
        E->>S: cache_put + SUCCESS
      end
    end
  end
  E-->>U: target output
```

### Approval Gate

```mermaid
sequenceDiagram
  participant E as ExecutionEngine
  participant S as SqliteStore
  participant A as ApprovalProvider
  participant CLI as smithers approve

  E->>S: ApprovalRequested event
  alt interactive
    E->>A: prompt user
    A-->>E: approved/denied
    E->>S: record decision
  else headless pause
    E->>S: set node PAUSED, run PAUSED
    CLI->>S: set approvals APPROVED
    E->>S: resume run
  end
```

### Ralph Loop Execution

```mermaid
sequenceDiagram
  participant E as ExecutionEngine
  participant L as RalphLoop
  participant W as InnerWorkflow
  participant S as SqliteStore

  E->>L: execute(initial_input)
  loop until condition or max_iterations
    L->>S: LoopIterationStarted {iteration: N}
    L->>W: await workflow(current_input)
    W-->>L: output
    L->>S: LoopIterationFinished {iteration: N}
    L->>L: check until(output)
    alt condition met
      L-->>E: return output
    else continue
      L->>L: current = output
    end
  end
  L->>S: LoopMaxIterationsReached (if applicable)
  L-->>E: return final output
```

---

## 17. Full System Diagram

```mermaid
flowchart LR
  subgraph PlanPhase["Plan Phase: build_graph()"]
    A["@workflow wrappers"] --> R["Registry<br/>OutputType→Workflow"]
    RL["ralph_loop()"] --> R
    R --> P["GraphBuilder + Verifier<br/>cycles/missing/ambiguous"]
    P --> G["WorkflowGraph Plan<br/>nodes/edges/levels/plan_hash"]
  end

  subgraph Store["SQLite: System of Record"]
    CE[("cache_entries")]
    RU[("runs")]
    RN[("run_nodes")]
    LI[("loop_iterations")]
    EV[("events")]
    AP[("approvals")]
    LC[("llm_calls")]
    TC[("tool_calls")]
  end

  subgraph ExecPhase["Execution Phase: run_graph(plan)"]
    G --> E["ExecutionEngine<br/>TaskGroup per level"]
    E -->|cache_get/put| CE
    E -->|create_run/update status| RU
    E --> RN
    E --> LI
    E --> EV
    E --> AP
    E --> LC
    E --> TC
    E --> LLM["Claude Provider<br/>tool loop + JSON schema"]
    E --> TOOL["ToolRegistry<br/>Read/Edit/Bash"]
    E --> APPROVE["ApprovalProvider<br/>CLI/pause-resume"]
  end

  subgraph Observe["Constant Visibility"]
    Store --> WATCH["CLI watch/inspect"]
    Store --> UI["Web UI (future)"]
    Store --> AUDIT["Auditable runs<br/>timing/cost/errors"]
  end
```
