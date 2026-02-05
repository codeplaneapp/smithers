# Smithers Desktop UI Specification (Electrobun + Pi + Smithers)

This spec designs a **single-window desktop app** (with optional secondary inspector window later) that combines:

- **Conversational coding agent UI** (pi-web-ui components)
- **Smithers workflow orchestration** (run/monitor/control workflows)
- **Real‑time visualization** of workflow execution and approvals

Where the **Bun process is the source of truth** for agent + workflow runtime, persistence, and event streaming.

Notes on Smithers rewrite alignment:

- The public docs at `smithers.sh` still describe the older `smithers-orchestrator` API and component model (e.g., `<SmithersProvider>`, `<Phase>`, `<Step>`, `<Claude>`). ([Smithers][1])
- The current repo README documents the newer workflow API (`smithers(db, ...)`, `<Workflow>`, `<Task>`, `<Sequence>`, `<Parallel>`, `<Ralph>`, `<Branch>`), deterministic NodeId behavior, node states, approval flow, progress events, and built-in tools/sandboxing. ([GitHub][2])

---

## 1. Architecture Specification

### 1.1 Process model

**Decision:** Hybrid “agent/workflows in Bun, UI in webview”.

- **Bun process (main)**

  - Owns: agent loop(s), tool execution, workflow execution, persistence, event log, run registry.
  - Exposes: typed RPC request handlers for UI.
  - Pushes: streaming events (agent + workflow) to UI via RPC messages.

- **Webview (renderer)**

  - Renders chat + workflow UI.
  - Maintains only _derived UI state_ (selection, filters, layout).
  - Subscribes to streaming events and requests data as needed (frames, node details, logs).

This maps directly to Electrobun’s intended model: Bun main owns logic, webview calls Bun through RPC and receives async messages. ([Blackboard][3])

### 1.2 Core runtime services in Bun

#### A) `AgentService`

- Owns:

  - Active chat session(s)
  - pi-agent-core agent instance(s) (or a managed pool)
  - Tool registry (read/write/edit/bash + extensions)
  - Streaming message assembly

- Emits:

  - `AgentEvent` stream (message updates, tool execution start/end, run start/end)

- Persistence:

  - Writes all message and tool-call artifacts to app DB.

> pi-agent-core exposes structured agent/tool lifecycle events (e.g., tool execution start/update/end) suitable for UI streaming. ([npm][4])

#### B) `SmithersService`

- Owns:

  - Run registry (runId → runtime handle)
  - Event ingestion via `onProgress` callback
  - Approval actions (approve/deny) and run control (cancel/resume)
  - Frame/snapshot acquisition (`renderFrame`) for visualization

- Emits:

  - `SmithersProgressEvent` stream (RunStarted/Finished/Failed, NodeStarted/Finished/Failed/… ApprovalRequested, etc.) ([GitHub][2])

- Persistence:

  - Event log persisted in app DB (and optionally also in Smithers workflow DB)
  - Node/attempt state materialized for quick UI queries

Smithers provides deterministic node identity and persisted node state in SQLite. NodeId = `<Task id>` and node states include `pending`, `waiting-approval`, `in-progress`, `finished`, `failed`, `cancelled`, `skipped`. ([GitHub][2])

#### C) `WorkspaceService`

- Owns:

  - Current workspace root (folder open)
  - Workflow discovery (find `.tsx` workflows)
  - File watching (update list)
  - “safe workspace” constraints for tools (root path, traversal prevention)

#### D) `PersistenceService`

- Owns:

  - App-level SQLite DB (sessions, settings, workflow run registry, event log, frames)
  - Migrations
  - Encryption strategy for secrets (see §4.4)

### 1.3 Communication patterns

#### RPC request/response (webview → bun)

Used for:

- Loading initial state
- Running workflows
- Approving/denying nodes
- Switching sessions
- Fetching frames/logs/outputs on demand

#### RPC messages (bun → webview)

Used for:

- Streaming tokens/chunks
- Tool-call lifecycle updates
- Workflow progress events
- “toast/notification” events
- Optional: incremental frame updates

Electrobun’s `rpc` option supports exactly this split: `requests` for calls that return values; `messages` for fire-and-forget async pushes. ([Blackboard][3])

### 1.4 Typed RPC schema

Create a shared `src/shared/rpc.ts`:

```ts
import type { RPCSchema } from "electrobun"; // adjust to actual import path

export type AgentEventDTO =
  | {
      type: "agent_start";
      sessionId: string;
      runId: string;
      timestampMs: number;
    }
  | {
      type: "message_update";
      sessionId: string;
      runId: string;
      messageId: string;
      delta: string;
    }
  | {
      type: "tool_execution_start";
      sessionId: string;
      runId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: "tool_execution_end";
      sessionId: string;
      runId: string;
      toolCallId: string;
      status: "success" | "error";
      output: unknown;
    }
  | {
      type: "agent_end";
      sessionId: string;
      runId: string;
      timestampMs: number;
      status: "success" | "cancelled" | "error";
    };

export type SmithersEventDTO =
  | { type: "RunStarted"; runId: string; timestampMs: number }
  | { type: "RunFinished"; runId: string; timestampMs: number }
  | { type: "RunFailed"; runId: string; timestampMs: number; error: unknown }
  | {
      type: "NodeStarted";
      runId: string;
      nodeId: string;
      iteration?: number;
      attempt?: number;
      timestampMs: number;
    }
  | {
      type: "NodeFinished";
      runId: string;
      nodeId: string;
      iteration?: number;
      attempt?: number;
      timestampMs: number;
    }
  | {
      type: "NodeFailed";
      runId: string;
      nodeId: string;
      iteration?: number;
      attempt?: number;
      timestampMs: number;
      error: unknown;
    }
  | {
      type: "NodeSkipped";
      runId: string;
      nodeId: string;
      iteration?: number;
      timestampMs: number;
    }
  | {
      type: "NodeCancelled";
      runId: string;
      nodeId: string;
      iteration?: number;
      timestampMs: number;
    }
  | {
      type: "NodeRetrying";
      runId: string;
      nodeId: string;
      iteration?: number;
      attempt?: number;
      timestampMs: number;
    }
  | {
      type: "NodeWaitingApproval";
      runId: string;
      nodeId: string;
      iteration?: number;
      timestampMs: number;
    }
  | {
      type: "ApprovalRequested";
      runId: string;
      nodeId: string;
      iteration?: number;
      timestampMs: number;
    }
  | {
      type: "ApprovalGranted";
      runId: string;
      nodeId: string;
      iteration?: number;
      timestampMs: number;
    }
  | {
      type: "ApprovalDenied";
      runId: string;
      nodeId: string;
      iteration?: number;
      timestampMs: number;
    }
  | {
      type: "RevertStarted";
      runId: string;
      nodeId: string;
      jjPointer: string | null;
      timestampMs: number;
    }
  | {
      type: "RevertFinished";
      runId: string;
      nodeId: string;
      jjPointer: string | null;
      success: boolean;
      timestampMs: number;
    };

export type FrameSnapshotDTO = {
  runId: string;
  frameNo: number;
  timestampMs: number;
  xml?: string; // optional, can be omitted if large
  xmlHash?: string; // for cache/dedup
  graph: {
    nodes: Array<{
      id: string; // NodeId
      label: string; // usually id; allow override if present
      kind:
        | "Task"
        | "Sequence"
        | "Parallel"
        | "Branch"
        | "Ralph"
        | "Workflow"
        | "Unknown";
      state?: string; // pending, in-progress, etc
      iteration?: number;
    }>;
    edges: Array<{ from: string; to: string }>;
  };
};

export type AppRPCType = {
  bun: RPCSchema<{
    requests: {
      // workspace
      openWorkspace: { params: { path: string }; response: { ok: true } };
      getWorkspaceState: {
        params: {};
        response: { root: string | null; workflows: WorkflowRef[] };
      };

      // chat
      listChatSessions: { params: {}; response: ChatSessionSummary[] };
      createChatSession: {
        params: { title?: string };
        response: { sessionId: string };
      };
      getChatSession: {
        params: { sessionId: string };
        response: ChatSessionDTO;
      };
      sendChatMessage: {
        params: {
          sessionId: string;
          text: string;
          attachments?: AttachmentDTO[];
        };
        response: { runId: string };
      };
      abortChatRun: {
        params: { sessionId: string; runId: string };
        response: { ok: true };
      };

      // workflows
      listWorkflows: { params: { root?: string }; response: WorkflowRef[] };
      runWorkflow: {
        params: {
          workflowPath: string;
          input: unknown;
          attachToSessionId?: string;
        };
        response: { runId: string };
      };
      listRuns: {
        params: { status?: "active" | "finished" | "failed" | "all" };
        response: RunSummaryDTO[];
      };
      getRun: { params: { runId: string }; response: RunDetailDTO };
      getRunEvents: {
        params: { runId: string; afterSeq?: number };
        response: { events: SmithersEventDTO[]; lastSeq: number };
      };
      getFrame: {
        params: { runId: string; frameNo?: number };
        response: FrameSnapshotDTO;
      };
      approveNode: {
        params: {
          runId: string;
          nodeId: string;
          iteration?: number;
          note?: string;
        };
        response: { ok: true };
      };
      denyNode: {
        params: {
          runId: string;
          nodeId: string;
          iteration?: number;
          note?: string;
        };
        response: { ok: true };
      };
      cancelRun: { params: { runId: string }; response: { ok: true } };
      resumeRun: { params: { runId: string }; response: { ok: true } };

      // settings
      getSettings: { params: {}; response: SettingsDTO };
      setSettings: {
        params: { patch: Partial<SettingsDTO> };
        response: SettingsDTO;
      };
    };
    messages: {
      agentEvent: AgentEventDTO;
      workflowEvent: SmithersEventDTO & { seq: number };
      workflowFrame: FrameSnapshotDTO;
      toast: { level: "info" | "warning" | "error"; message: string };
    };
  }>;
  webview: RPCSchema<{
    requests: {
      focusRun: {
        params: { runId: string; nodeId?: string };
        response: { ok: true };
      };
      openSettings: { params: {}; response: { ok: true } };
    };
    messages: {};
  }>;
};
```

### 1.5 Persistence strategy

#### Smithers persistence

Smithers already persists:

- Node state per `(runId, nodeId)` in SQLite ([GitHub][2])
- Output rows in Drizzle tables with keys `(runId, nodeId[, iteration])` ([GitHub][2])
- Approval state stored in SQLite, and CLI supports approve/deny ([GitHub][2])

#### App persistence (new)

The desktop app adds:

- Chat sessions/messages
- Workflow run registry across workspaces
- Normalized event log and frame snapshots for visualization & replay
- UI preferences (panel state, last selected run, etc.)

### 1.6 Extension integration points

**Design goal:** allow future “panels/tools” without forking app core.

Define a Bun-side plugin API:

```ts
export type BunPlugin = {
  id: string;
  registerTools?: (ctx: ToolRegistryContext) => void;
  registerRpc?: (ctx: RpcRegistryContext) => void;
  registerDbMigrations?: (ctx: MigrationContext) => void;
  registerUiContributions?: (ctx: UiContributionContext) => void;
};
```

- Smithers integration ships as a built-in plugin.
- Future plugins can contribute:

  - New tools (agent tools)
  - New sidebar tabs (UI)
  - New message renderers (UI)
  - New run types (e.g., “build pipelines”, “CI monitors”)

---

## 2. UI/UX Specification

### 2.1 Primary layout

**Primary window layout:** chat-first, workflow panel optional/collapsible.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Menu Bar: File | Workflow | View | Settings | Help                      │
├─────────────────────────────────────────────────────────────────────────┤
│  Toolbar: [Workspace ▼] [Session ▼]                     [WF Panel ⫶]     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌───────────────────────────────────────┬───────────────────────────┐  │
│  │                                       │                           │  │
│  │               CHAT                    │      WORKFLOW SIDEBAR     │  │
│  │   (pi-web-ui ChatPanel + artifacts)   │   (collapsible)           │  │
│  │                                       │                           │  │
│  │                                       │  Tabs: Runs | Workflows   │  │
│  │                                       │  - Active runs list       │  │
│  │                                       │  - Selected run details   │  │
│  │                                       │  - Approvals              │  │
│  │                                       │  - Logs/events            │  │
│  └───────────────────────────────────────┴───────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Collapsed workflow sidebar:** a slim vertical strip with:

- “Runs” badge with count of active approvals
- “Play” (run workflow) quick action
- “History” quick action

### 2.2 Navigation model

- **Session navigation**: session dropdown (recent sessions) + “New session”.
- **Workflow navigation**:

  - Runs tab: list and filter
  - Workflows tab: scripts and “Run…” dialog

- **Deep links**:

  - Clicking a workflow card in chat focuses that run in the sidebar.
  - Clicking an approval toast opens the approval card and highlights node.

### 2.3 Key UI surfaces

#### A) Chat surface (primary)

Use pi-web-ui `ChatPanel` as the main chat UI. pi-web-ui exports `ChatPanel`, `AgentInterface`, message components, dialogs, and a message renderer registry we will use for workflow cards. ([jsDelivr][5])

Chat behaviors:

- Streaming assistant message updates (token deltas).
- Tool blocks rendered inline (read/write/edit/bash), with expandable detail.
- Artifacts panel shows generated files/HTML/SVG/MD (standard pi-web-ui behavior).

Add two Smithers-aware features:

1. **Context chips**

- Above input: `Context: Workspace ./repo` and optionally `Context: Run #abc123`.
- Clicking chip opens run inspector or clears context.

2. **Workflow mentions**

- `@workflow` triggers autocomplete with discovered workflows.
- `#run` triggers autocomplete with recent run IDs.
- Insert structured tokens into user message, e.g.:

  - `@workflow(code-review-loop.tsx) input={"directory":"./src"}`

#### B) Workflow sidebar (secondary)

**Tabs:**

1. **Runs**
2. **Workflows**

##### Runs tab

List rows show:

- status dot (running / waiting approval / failed / finished)
- workflow name
- runId short (e.g., `abc123`)
- started time + duration
- active node (if any)

Row actions:

- “Open” (select)
- “Cancel” (if running)
- “Resume” (if resumable)
- “Copy runId”

##### Workflows tab

Two modes:

- **Discovered scripts list** (from workspace scanning)
- **Favorites** pinned at top

Each workflow row:

- name (derived from file or exported workflow name if introspected)
- path
- “Run” button (opens Run dialog)

#### C) Run inspector (inside sidebar)

When a run is selected:

```
┌───────────────────────────────────────────────────────────────┐
│ Run: code-review-loop    Status: WAITING APPROVAL (1)          │
│ RunId: abc123   Started: 10:14   Elapsed: 01:22   [Cancel]     │
├───────────────────────────────────────────────────────────────┤
│ Tabs: Graph | Timeline | Logs | Outputs | Attempts             │
├───────────────────────────────────────────────────────────────┤
│ [Tab content]                                                   │
└───────────────────────────────────────────────────────────────┘
```

**Tab specs:**

1. **Graph**

- Zoom/pan + “fit to screen”
- Nodes colored by state:

  - pending: gray
  - in-progress: blue
  - finished: green
  - failed: red
  - waiting-approval: yellow
  - cancelled/skipped: muted

- Clicking a node opens **Node detail drawer** (slides from right or bottom).

2. **Timeline**

- Vertical timeline of node lifecycle events with durations.
- Group by iteration if `<Ralph>` loop used.
- Shows retries as nested attempts (attempt 0, 1, 2).

3. **Logs**

- Structured event stream (filter by type: run, node, approval, revert)
- Search box
- “Copy filtered” and “Export JSONL”

4. **Outputs**

- Read-only table browser for workflow output tables (Drizzle tables).
- For each node, show the corresponding output row(s) keyed by `(runId,nodeId[,iteration])`. ([GitHub][2])

5. **Attempts**

- Attempt table view with:

  - attempt number
  - start/end time
  - state
  - error (expandable)
  - JJ pointer (if any)
  - tool call logs summary

Smithers recommends an attempt table schema and describes retry behavior (new attempt rows, NodeRetrying emitted). ([GitHub][2])

#### D) Node detail drawer

Open when user clicks a node in Graph/Timeline.

Sections:

1. **Header**

- NodeId
- State badge
- Iteration/attempt selector
- Actions: “Ask agent”, “Copy prompt”, “Copy output”, “Approve/Deny” (if gated)

2. **Prompt**

- If node has agent prompt: show full prompt text.
- If hardcoded output: show “direct output node” label.

3. **Output preview**

- JSON tree viewer
- “Open full row” (opens in Outputs tab)

4. **Tool calls**

- List of tool calls (read/edit/write/bash/grep)
- For each: input, stdout/stderr, exit code, duration

5. **Errors**

- Error summary + stack-like view if available

### 2.4 Human-in-the-loop approvals UX

Smithers approval model:

- Tasks with `needsApproval` enter `waiting-approval` and emit `ApprovalRequested`; approval state is stored in SQLite; CLI supports approve/deny. ([GitHub][2])

UI behavior when an approval is requested:

1. **Sidebar indicator**

- Runs tab shows a badge count.
- Run row highlights “Waiting approval”.

2. **In-run approval card**
   In the run inspector, show a dedicated “Approvals” section above tabs when pending approvals exist:

```
[Approval Required]
Node: review   Iteration: 0
Summary: (preview of output or prompt)
[Approve] [Deny…] [Ask agent]
```

3. **Chat integration (if run attached to a chat session)**
   Post an assistant “workflow card” message that includes:

- runId
- nodeId
- quick approve/deny buttons
- “Explain risk” / “Ask agent” shortcut

### 2.5 Workflow visualization approach

**Decision:** Provide _three views_ (Graph, Timeline, Logs) via tabs; Graph is default.

Rationale:

- Operators want a quick “what’s stuck” (List/Timeline)
- Authors want structure and dynamic plan evolution (Graph)
- Debugging needs raw events (Logs)

**Data source:**

- Base state from progress events (RunStarted, NodeStarted, … ApprovalRequested). ([GitHub][2])
- Structure + dynamic plans via `renderFrame` snapshotting (recommended to store a frame per meaningful transition).

### 2.6 Responsive behavior

Electrobun target: desktop window sizes; still support resizing.

Breakpoints:

- **≥ 1200px**: chat + workflow sidebar split.
- **< 1200px**: workflow sidebar becomes overlay drawer (slides in from right).
- **< 900px**: run inspector uses a full-screen modal with tab bar.

### 2.7 Menu bar + shortcuts

**File**

- New Chat Session — `Cmd+N`
- Open Workspace — `Cmd+O`
- Close Workspace

**Workflow**

- Run Workflow… — `Cmd+R`
- Show Runs — `Cmd+Shift+R`
- Approvals — `Cmd+Shift+A` (jump to next approval)
- Cancel Current Run — `Cmd+.`

**View**

- Toggle Workflow Panel — `Cmd+\`
- Toggle Artifacts Panel — `Cmd+Shift+\`
- Zoom In/Out (graph only) — `Cmd+=`, `Cmd+-`

**Settings**

- Preferences — `Cmd+,`

### 2.8 Visual design system

Keep it minimal, code-tool aesthetic:

- Default dark theme with optional light.
- Use semantic colors only for node states (state mapping in graph + badges).
- Typography: system UI font for chrome, monospace for logs/output/prompt blocks.
- Accessibility:

  - Color + icon shape for state (not color alone)
  - Keyboard navigation for approvals and run list

---

## 3. Smithers Pi‑Extension Specification

### 3.1 Integration stance

**Decision:** Both

- pi-extension tools (agent can run/control workflows)
- Dedicated workflow UI (operators can manage runs directly)

### 3.2 Tool definitions (agent-facing)

These tools are registered into the agent’s tool registry in Bun.

#### `smithers.listWorkflows`

- **Purpose:** discover runnable workflows in the workspace.
- **Input:** `{ root?: string }`
- **Output:** `{ workflows: Array<{ path: string; name?: string; description?: string }> }`

#### `smithers.runWorkflow`

- **Purpose:** start a new run.
- **Input:** `{ workflowPath: string; input: unknown; focus?: boolean }`
- **Output:** `{ runId: string }`
- **Side effects:**

  - Starts run in `SmithersService`
  - Emits `RunStarted` to UI stream (and posts a chat workflow card)
  - If `focus`, UI focuses the run in the workflow sidebar

Smithers supports both CLI start and a programmatic `runWorkflow(workflow, { input, onProgress })`. ([GitHub][2])

#### `smithers.getRun`

- **Purpose:** quick status for agent responses.
- **Input:** `{ runId: string }`
- **Output:** `{ status, activeNodes, waitingApprovals, lastEventSeq, startedAt, ... }`

#### `smithers.approveNode` / `smithers.denyNode`

- **Purpose:** resolve approvals.
- **Input:** `{ runId, nodeId, iteration?, note? }`
- **Output:** `{ ok: true }`

Approval behavior (waiting-approval + ApprovalRequested events, CLI approve/deny) is defined in Smithers docs. ([GitHub][2])

#### `smithers.cancelRun` / `smithers.resumeRun`

- **Purpose:** control run lifecycle.
- **Input:** `{ runId }`
- **Output:** `{ ok: true }`

#### `smithers.getFrame`

- **Purpose:** retrieve the latest (or a specific) frame snapshot to reason about dynamic plans.
- **Input:** `{ runId: string; frameNo?: number }`
- **Output:** `FrameSnapshotDTO`

Smithers documents `renderFrame` programmatic usage. ([GitHub][2])

#### `smithers.openRunInUI`

- **Purpose:** when agent wants user attention.
- **Input:** `{ runId: string; nodeId?: string }`
- **Output:** `{ ok: true }`
- **Implementation:** bun → webview RPC `focusRun`

### 3.3 Custom chat message types for workflow cards

Use pi-web-ui message renderer registry:

- `registerMessageRenderer(...)`
- `renderMessage(...)`
- Custom message typing (`CustomMessages`) ([jsDelivr][5])

Define message types:

```ts
type WorkflowCardMessage = {
  type: "smithers.workflow.card";
  runId: string;
  workflowName: string;
  status: "running" | "waiting-approval" | "finished" | "failed" | "cancelled";
  primaryNodeId?: string;
  approvals?: Array<{ nodeId: string; iteration?: number }>;
};
```

Renderer UI:

- compact run summary
- inline actions:

  - Focus run
  - Approve/Deny (if applicable)
  - Cancel

### 3.4 Approval surfacing rules

When `SmithersService` receives `ApprovalRequested`:

1. Persist event
2. Update run materialized state (node becomes waiting-approval)
3. Emit `workflowEvent` to UI
4. If run has `chatSessionId`, append a `smithers.workflow.card` message

### 3.5 Workflow state synchronization

**Source of truth:** Bun.
UI uses a **replay + subscribe** model:

- On app start:

  - `listRuns()`, then for active run(s) `getRun(runId)` and `getRunEvents(afterSeq=0)`

- During runtime:

  - UI receives `workflowEvent` messages with monotonic `seq`
  - If UI detects seq gap, it calls `getRunEvents(afterSeq=lastSeenSeq)`

This prevents UI from drifting when:

- window is suspended
- webview reloads
- user switches workspaces

---

## 4. Data Models

### 4.1 Chat session schema (app DB)

**Tables (SQLite):**

`chat_sessions`

- `session_id TEXT PRIMARY KEY`
- `title TEXT`
- `workspace_root TEXT NULL`
- `created_at_ms INTEGER`
- `updated_at_ms INTEGER`
- `agent_config_json TEXT` (model, thinking level, tool allowlist)

`chat_messages`

- `message_id TEXT PRIMARY KEY`
- `session_id TEXT`
- `seq INTEGER` (monotonic within session)
- `role TEXT` (`user|assistant|tool|system|custom`)
- `content_json TEXT` (pi-web-ui compatible message parts)
- `created_at_ms INTEGER`
- `run_id TEXT NULL` (links message to an agent run)

`chat_tool_calls`

- `tool_call_id TEXT PRIMARY KEY`
- `session_id TEXT`
- `run_id TEXT`
- `message_id TEXT`
- `tool_name TEXT`
- `input_json TEXT`
- `output_json TEXT`
- `status TEXT`
- `started_at_ms INTEGER`
- `finished_at_ms INTEGER`

### 4.2 Workflow run tracking (app DB)

Smithers run outputs live in the workflow DB(s), but the app tracks runs centrally.

`workflow_runs`

- `run_id TEXT PRIMARY KEY`
- `workspace_root TEXT`
- `workflow_path TEXT`
- `workflow_name TEXT`
- `status TEXT` (`running|waiting-approval|finished|failed|cancelled`)
- `started_at_ms INTEGER`
- `finished_at_ms INTEGER NULL`
- `input_json TEXT`
- `attached_session_id TEXT NULL` (if run triggered from chat)
- `workflow_db_path TEXT NULL` (if app controls DB location)

`workflow_events`

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `run_id TEXT`
- `seq INTEGER` (monotonic per run)
- `timestamp_ms INTEGER`
- `type TEXT`
- `payload_json TEXT`

`workflow_nodes` (materialized)

- `run_id TEXT`
- `node_id TEXT`
- `iteration INTEGER DEFAULT 0`
- `state TEXT`
- `last_attempt INTEGER`
- `needs_approval INTEGER`
- `last_error_json TEXT NULL`
- PRIMARY KEY `(run_id, node_id, iteration)`

`workflow_frames`

- `run_id TEXT`
- `frame_no INTEGER`
- `timestamp_ms INTEGER`
- `xml_hash TEXT`
- `xml_text TEXT NULL` (optional compression in implementation)
- `graph_json TEXT`
- PRIMARY KEY `(run_id, frame_no)`

`workflow_approvals`

- `run_id TEXT`
- `node_id TEXT`
- `iteration INTEGER`
- `decision TEXT` (`approved|denied`)
- `note TEXT NULL`
- `decided_at_ms INTEGER`
- PRIMARY KEY `(run_id, node_id, iteration)`

### 4.3 Settings and preferences

`settings`

- `key TEXT PRIMARY KEY`
- `value_json TEXT`

Recommended keys:

- `ui.workflowPanel.isOpen`
- `ui.workflowPanel.width`
- `ui.lastWorkspaceRoot`
- `agent.defaultModel`
- `agent.thinkingLevel`
- `agent.toolPolicy` (allowlist/denylist)
- `smithers.defaultWorkflowGlob`
- `smithers.maxConcurrentRuns`

### 4.4 Secrets and credentials

pi-web-ui includes stores for provider keys and settings, but browser storage is not ideal for a desktop app. ([jsDelivr][5])

**Design choice:**

- Store secrets in Bun using OS keychain if available (phase 2+).
- Phase 1 fallback: encrypted blob in SQLite (encryption key derived from OS keystore or user passphrase).

---

## 5. Implementation Phases

### Phase 1 — Basic chat (pi agent in Bun, pi-web-ui in webview)

Deliver:

- Electrobun shell + single window
- pi-web-ui `ChatPanel` rendered in webview
- Bun `AgentService` with:

  - streaming assistant output to UI
  - file tools (read/write/edit) + bash with sandbox (no network)

- Session persistence to app DB

Key tests:

- streaming correctness (no duplicated/missing tokens)
- tool rendering correctness

### Phase 2 — Smithers integration (run + monitor)

Deliver:

- Workflow discovery in workspace
- Run workflow via UI (“Run Workflow…” dialog)
- Run list + basic status badges
- Event log streaming to UI

Base events supported per Smithers progress events. ([GitHub][2])

### Phase 3 — Approvals

Deliver:

- Detect `ApprovalRequested` and show approval card
- Approve/deny actions from UI
- Chat workflow cards for approvals if run attached to session
- Run focus + notification rules

Smithers approval flow semantics are defined (waiting-approval, ApprovalRequested, CLI approve/deny). ([GitHub][2])

### Phase 4 — Advanced visualization

Deliver:

- Graph view with layout + node detail drawer
- Timeline view with attempt grouping
- Frame history and plan evolution (renderFrame snapshots)
- Output browsing with table introspection
- “Ask agent about this node/run” integrations

---

## 6. Technical Decisions

### 6.1 pi-mono packages and placement

**In Bun**

- pi-agent-core (agent runtime + events)
- pi-coding-agent SDK features as needed (sessions/branching)

  - If SDK integration is heavy initially, implement minimal session persistence and add SDK later.

**In webview**

- pi-web-ui (ChatPanel, dialogs, message renderer registry, tool renderers) ([jsDelivr][5])

### 6.2 Tool execution strategy

**All tools run in Bun** to keep:

- consistent sandboxing
- consistent workspace rooting
- consistent logging for audit trails

Smithers tools have explicit sandboxing/auditing expectations:

- cwd at workflow root
- reject path traversal outside root
- bash network-disabled by default
- resource limits
- log stdout/stderr/exit codes ([GitHub][2])

Unify pi agent tools and Smithers tools behind a single `ToolSandbox` module in Bun:

- `resolvePath(root, userPath)`
- file size caps
- bash wrapper that enforces env + disables network (implementation-specific)

### 6.3 Workflow visualization library choice

**Graph layout**: `dagre` or `elkjs`

- DAG layout is stable and predictable
- supports dynamic updates (node state changes)

**Rendering**: SVG-based (d3 or a lightweight custom renderer)

- easiest to theme and to implement hit-testing for node click/hover

**Tabs**: Graph / Timeline / Logs (default Graph)

### 6.4 Testing strategy

**Bun unit tests**

- RPC handlers (pure request → response)
- event sequencing (monotonic seq, gap handling)
- reducers: event → node state materialization

**Integration tests**

- Run a canned workflow with stubbed agents, assert event stream and stored DB rows.
- Simulate approval request, assert UI action triggers state transition.

**UI tests**

- Component-level tests in a normal browser runner for web components.
- End-to-end tests are harder in native webview; keep most logic testable outside Electrobun by isolating UI state management.

---

## Appendices

### A) Smithers concepts that drive UI behavior

- Deterministic NodeId = `<Task id>`; `<Ralph>` iterations reuse NodeId and disambiguate with `iteration`. ([GitHub][2])
- Node states and approval mode (`waiting-approval`) must be displayed distinctly. ([GitHub][2])
- Progress events cover run lifecycle, node lifecycle, retries, approvals, and revert. ([GitHub][2])

### B) Minimal “Run Workflow…” dialog wireframe

```
┌──────────────────────────── Run Workflow ────────────────────────────┐
│ Workflow: [ code-review-loop.tsx ▼ ]                                  │
│ Input (JSON):                                                         │
│ ┌───────────────────────────────────────────────────────────────────┐ │
│ │ { "directory": "./src", "focus": "auth" }                          │ │
│ └───────────────────────────────────────────────────────────────────┘ │
│ Attach to chat session: [ Current session ▼ ]                         │
│ [Run] [Cancel]                                                        │
└───────────────────────────────────────────────────────────────────────┘
```

---

### C) Reference Implementation Mapping (apps/desktop)

This repo includes a working implementation under `apps/desktop`.

Folder layout:

```text
apps/desktop/
  src/bun/main.ts
  src/bun/agent/AgentService.ts
  src/bun/agent/runner.ts
  src/bun/smithers/SmithersService.ts
  src/bun/tools/index.ts
  src/bun/tools/sandbox.ts
  src/bun/db.ts
  src/shared/rpc.ts
  src/webview/main.ts
  src/webview/main.css
  views/main/index.html
```

Runtime wiring (entry points):

- `apps/desktop/src/bun/main.ts` wires RPC, instantiates `AgentService` and `SmithersService`, and streams events to the webview.
- `apps/desktop/src/bun/agent/AgentService.ts` owns chat sessions, tool execution, and `@workflow(...)` trigger parsing.
- `apps/desktop/src/bun/smithers/SmithersService.ts` runs workflows, materializes node state, and persists event/frame data.
- `apps/desktop/src/bun/db.ts` defines the app SQLite schema and query helpers.
- `apps/desktop/src/shared/rpc.ts` is the source of truth for DTOs and RPC schema.
- `apps/desktop/src/webview/main.ts` builds the UI (toolbar, chat pane, sidebar, run inspector) and handles RPC streaming.
- `apps/desktop/src/webview/main.css` defines the visual system and layout primitives.
- `apps/desktop/views/main/index.html` is the webview entrypoint.

UI component tree (webview/main.ts):

```text
App
  Toolbar
  Content
    ChatPane
      ContextBar
      ChatPanel (pi-web-ui)
    Sidebar
      Tabs: Runs | Workflows
      RunsTab
        RunList
        RunInspector
          ApprovalCard (conditional)
          Tabs: Graph | Timeline | Logs | Outputs | Attempts
          NodeDrawer (Graph)
      WorkflowsTab
        WorkflowList
        RunWorkflowDialog (overlay)
```

[1]: https://smithers.sh/introduction "https://smithers.sh/introduction"
[2]: https://github.com/evmts/smithers "https://github.com/evmts/smithers"
[3]: https://blackboard.sh/electrobun/docs/apis/browser-window/ "https://blackboard.sh/electrobun/docs/apis/browser-window/"
[4]: https://www.npmjs.com/package/%40mariozechner%2Fpi-agent-core "https://www.npmjs.com/package/%40mariozechner%2Fpi-agent-core"
[5]: https://cdn.jsdelivr.net/npm/%40mariozechner/pi-web-ui%400.30.2/dist/index.d.ts "https://cdn.jsdelivr.net/npm/%40mariozechner/pi-web-ui%400.30.2/dist/index.d.ts"
