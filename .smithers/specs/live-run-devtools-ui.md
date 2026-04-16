# Live Run DevTools UI — Design Spec

> Status: v1 · Author: will (with Claude) · Target surface: gui (SmithersGUI, Swift/SwiftUI)
>
> Replaces the existing "watch a live run" page (`LiveRunChatView`) with a
> React DevTools-style XML tree + inspector. Smithers IS React — we render
> it as React. This doc is the single source of truth; all implementation
> tickets (`.smithers/tickets/00XX-*.md` in both repos) flow from here.

---

## 1. Why this shape

Smithers workflows are JSX. A workflow is a React tree of `<Workflow>`,
`<Sequence>`, `<Parallel>`, `<Task>`, `<ForEach>`, etc. The engine maintains
that tree through a custom reconciler and emits **frames** (full or delta
snapshots of the tree) as state evolves.

Today the gui flattens all of this into "task cards" and a chat transcript
per task. That throws away:

- Structure (which tasks run in parallel, nesting, sequence order).
- Props (the actual prompt / script / schema / agent on each node).
- The mental model that the underlying system is React.

A DevTools-style tree is the most honest rendering of what Smithers is, and
React DevTools has had a decade of UI/UX iteration we can inherit. We are
explicitly copying their Components tab layout, keybindings, and interaction
model — diverging only where Smithers semantics require it.

Reference clone (read-only, for UI inspiration):
`/tmp/ref/react/packages/react-devtools-shared/src/devtools/views/Components/`
— notably `Components.js`, `Tree.js`, `Element.js`, `InspectedElement.js`,
`KeyValue.js`, `ExpandCollapseToggle.js`, `SearchInput.js`.

---

## 2. UX at a glance

```
┌─────────────────────────────────────────────────────────────────────┐
│  ● runId: run_abc123   workflow: reviewer   elapsed: 02:41   ♥ ♥   │  ← header + dual heartbeats
│  ├─────────────────── frame scrubber ─────────────────┤  [Rewind]  │  ← time travel
├────────────────────────────┬────────────────────────────────────────┤
│  Tree                      │  Inspector                             │
│  [search…]                 │  <Task nodeId="task:review:0">         │
│  ▼ <Workflow name="rev.">  │  state: running · iteration 2 · 00:14  │
│    ▼ <Sequence>            │  ┌─ props ────────────────────────┐    │
│      ▶ <Task id="fetch" ✓> │  │ agent:   "claude-opus-4-7"     │    │
│      ▼ <Parallel>          │  │ prompt:  "Review PR #42…"      │    │
│        ▼ <Task id="rev0" …)│  │          [expand]              │    │
│        ▶ <Task id="rev1" ✓>│  │ schema:  ▶ { rating, notes }   │    │
│        ▼ <Task id="rev2" ✗>│  │ retries: 3                     │    │
│      ▶ <Task id="merge" ·) │  └────────────────────────────────┘    │
│  (virtualized)             │  [ Output | Diff | Logs ]              │
└────────────────────────────┴────────────────────────────────────────┘
```

### 2.1 Tree pane (left)

Copy React DevTools' Components tree.

- Indented hierarchy with arrow chevrons. `▶` collapsed, `▼` expanded.
- **Collapsed by default.** Auto-expand the path to the currently-active
  (running) task so something is always on-screen. Never auto-expand a
  subtree the user has explicitly collapsed (remember per-session).
- Each row: chevron · `<Tag>` · key props summary · state badge · timing.
- Elements are **virtualized** — required, real workflows reach 500+ nodes.
- Inside `<Parallel>`, children stay in structural declaration order. We do
  not float running tasks to the top (matches RDT; reordering is confusing).
- Color by state:
  - `pending` — muted foreground
  - `running` — accent blue, animated pulse on the tag
  - `finished` — normal foreground, subtle checkmark
  - `blocked` / `waitingApproval` — amber
  - `failed` — red tag, red background tint on the row
  - `cancelled` — strikethrough muted
- **Error bubble-up**: if any descendant is `failed`, ancestor chevrons show
  a small red dot even when collapsed. Lets the user scan a collapsed tree
  and know where to look.
- Search input at the top of the pane. v1 matches on tag + nodeId + label
  only (prop-content search is expensive on large trees — deferred). Matches
  highlighted, non-matches dimmed (not removed — structure stays intact).
- Keyboard (mirror RDT exactly): ↑/↓ navigate rows, ←/→ collapse/expand,
  Enter focuses inspector, Cmd+F focuses search.

### 2.2 Inspector pane (right)

Mirrors RDT's `InspectedElement` layout with Smithers-specific sections.

**Always visible (top):**
- Element header: `<Tag>` + nodeId + state badge + iteration + timing.
- Props table (equivalent of RDT's `KeyValue.js`):
  - Scalar props rendered inline.
  - Object / schema props are collapsible trees.
  - Long string props (notably `prompt`): truncated to ~200 chars with an
    `[expand]` control. Expansion is **inline** (not a modal). Collapses
    back on click. Rationale: modals feel heavy for a quick glance; RDT's
    inline-expand pattern works.
  - Copy-to-clipboard affordance per value.
- **Ghost state**: if the currently-selected node disappears from the tree
  (re-render, iteration advance), the inspector keeps showing the last-known
  data for that node with a banner: *"This node is no longer in the running
  tree."* User has to click elsewhere to leave. Rationale: unmounts are
  common and the user usually selected that node precisely because they
  wanted to read its output. Ripping it away is hostile.
- **Error banner**: if the node is `failed`, a red banner sits above the
  tabs with the error summary, an expandable stack, and a "Retry" action
  if supported. Errors are never hidden inside a tab.

**Tabs (Task nodes only): Output · Diff · Logs**

Default tab = Output if the task has finished; Logs if still running;
Diff if only the diff exists.

- **Output** — structured render of the task's output row.
  - v1: collapsible key-value tree. Strings over 2 lines truncate with
    inline expand. Numbers, bools, nulls styled distinctly. No markdown
    detection yet — minimal and good-looking, improve iteratively.
  - Empty state: *"Task has not produced output yet."*
- **Diff** — unified git/jj diff of files changed during this task's
  execution (from `computeDiffBundle` between the task's start and end
  VCS pointers).
  - Per-file collapsible sections; hunks colored red/green.
  - File list at the top with add/mod/del badges.
  - Binary files: icon + size, no preview.
  - Empty state: *"No file changes."*
- **Logs** — the per-task chat transcript (assistant messages, tool calls,
  tool results, stderr). Port from the old `LiveRunChatView` transcript
  block renderer. Follow-to-bottom toggle. Noise filter toggle.

### 2.3 Header

- Run status pill (same colors as tree rows).
- Workflow name + runId (click to copy).
- Elapsed time (live-ticking).
- **Two heartbeats** (see §5).
- Frame scrubber (see §7 time travel) + "Rewind" action.
- Overflow menu: refresh, hijack (existing), open logs, cancel.

### 2.4 Layout responsiveness

- Default: two panes side-by-side, resizable divider.
- Narrow (< ~800px): inspector collapses to a bottom sheet. Matches RDT's
  narrow-window behavior.

---

## 3. Frame-first rendering model

The UI is driven by Smithers **frames**, but consumes them in a higher-level
shape: `DevToolsSnapshot`.

### 3.1 What's on the wire

We send the **pre-processed `DevToolsNode` tree** over the wire, not the raw
XML from the reconciler. The `packages/devtools` module already builds this
shape from a frame. Sending it pre-processed means:

- One canonical "how the tree is shown" answer lives in TS, not duplicated
  in Swift.
- The gui gets task metadata (agent, label, outputTable, iteration) hoisted
  to a dedicated `task` sidecar — no pattern-matching on tag names.

```ts
// from packages/devtools/src/DevToolsNode.ts
type DevToolsNode = {
  id: number;
  type: SmithersNodeType;     // "workflow" | "sequence" | "parallel" | "task" | …
  name: string;               // display name
  props: Record<string, unknown>;
  task?: {
    nodeId: string;
    kind: "agent" | "compute" | "static";
    agent?: string;
    label?: string;
    outputTableName?: string;
    iteration?: number;
  };
  children: DevToolsNode[];
  depth: number;
};

type DevToolsSnapshot = {
  runId: string;
  frameNo: number;         // maps back to the underlying frame
  seq: number;             // monotonic across the stream (for resume)
  root: DevToolsNode;
};
```

### 3.2 Stream protocol

Two Gateway RPCs cover the tree:

- `streamDevTools(runId, fromSeq?) → AsyncIterable<DevToolsEvent>` — live
  subscription. Emits full `DevToolsSnapshot` on first connect; subsequent
  events are either full snapshots (throttled) or structural deltas
  (add/remove/update node by id). Client can reconnect with `fromSeq` to
  resume.
- `getDevToolsSnapshot(runId, frameNo?) → DevToolsSnapshot` — one-shot.
  Used for time-travel scrubbing and for finished runs. `frameNo` defaults
  to latest.

Delta shape (mirrors the frame delta codec, but nodeId-indexed):

```ts
type DevToolsDelta = {
  baseSeq: number;
  seq: number;
  ops: Array<
    | { op: "addNode", parentId: number, index: number, node: DevToolsNode }
    | { op: "removeNode", id: number }
    | { op: "updateProps", id: number, props: Record<string, unknown> }
    | { op: "updateTask", id: number, task: DevToolsNode["task"] }
  >;
};
```

Implementation uses `SmithersDevToolsCore.captureSnapshot(tree)` internally;
we add `diffSnapshots(a, b) → DevToolsDelta` alongside it.

### 3.3 Animations

Spatial stability is critical. Animate, always — no throttling even on large
re-renders. Rules:

- **Mount**: fade + slide-in from left (120ms ease-out). Parent chevron
  pulses once.
- **Unmount**: fade + slide-out (120ms). Keep in dimmed "just-left" state
  for ~1s before removing, so the user sees what disappeared.
- **State transition** (pending → running → finished): badge color
  crossfades (200ms). No layout jumps.
- **Prop change**: affected row in the inspector flashes yellow → fades
  (RDT "updated" badge pattern).
- **Tree order**: follows structural order in the XML/DevToolsNode tree,
  which is deterministic per snapshot. No reorders.

SwiftUI needs stable keys per row: use `DevToolsNode.id`.

---

## 4. Data model / wire protocol

What exists, what we add. All additions are additive — no existing
contracts change.

### 4.1 Already exists (reuse)

| Capability              | Location                                                |
|------------------------|---------------------------------------------------------|
| Frame storage          | `packages/db/src/internal-schema/smithersFrames.ts`    |
| Delta codec            | `packages/db/src/frame-codec/`                         |
| XML tree types         | `packages/graph/src/types.ts` (`XmlElement`)           |
| DevTools snapshot core | `packages/devtools/src/SmithersDevToolsCore.ts`        |
| Task output storage    | per-task Drizzle tables via `packages/db/src/output.ts` |
| Task heartbeat event   | `apps/observability/src/SmithersEvent.ts`              |
| Diff computation       | `packages/engine/src/effect/diff-bundle.ts`            |
| JJ pointers per attempt| `_smithers_attempts` (`jjPointer`, `jjCwd`)            |
| Gateway WS protocol    | `packages/server/src/gateway.ts`                       |
| Gateway heartbeat      | `HelloResponse.policy.heartbeatMs`                     |
| Time-travel replay     | `packages/time-travel/` (`diffSnapshots`, etc.)        |

### 4.2 New Smithers additions

1. **`streamDevTools(runId, fromSeq?)` + `getDevToolsSnapshot(runId, frameNo?)`**
   Gateway RPCs. Build snapshots via `SmithersDevToolsCore`; add
   `diffSnapshots` helper for deltas. *Ticket: smithers/0010.*
2. **`getNodeDiff(runId, nodeId, iteration)` → `DiffBundle`**. Gateway RPC.
   Compute via `computeDiffBundle` against the task's base VCS pointer;
   cache into a new `_smithers_node_diffs` table. *Ticket: smithers/0011.*
3. **`getNodeOutput(runId, nodeId, iteration)` → `{ schema, row }`**.
   Gateway RPC wrapping `selectOutputRow` + extracting Zod schema hints so
   the gui can render fields in declared order. *Ticket: smithers/0012.*
4. **`jumpToFrame(runId, frameNo)` → `{ ok }`**. Gateway RPC that actually
   rewinds the engine to a frame (not just view-only). Orchestrates
   `revertToJjPointer` + reconciler replay. View-only time-travel is
   covered by `getDevToolsSnapshot(runId, frameNo)`; this is the
   "actually go back" action. *Ticket: smithers/0013.*
5. **CLI**: `smithers tree <runId>`, `smithers diff <runId> <nodeId>`,
   `smithers output <runId> <nodeId>`, `smithers rewind <runId> <frameNo>`.
   Useful for debugging + scripting. *Ticket: smithers/0014.*

### 4.3 New gui additions

- `LiveRunDevToolsStore` (ObservableObject) — owns current snapshot, applies
  deltas, emits SwiftUI changes. *Ticket: gui/0074.*
- `LiveRunTreeView` (left pane). *Ticket: gui/0075.*
- `NodeInspectorView` (right pane shell + props + ghost + error banner).
  *Ticket: gui/0076.*
- `OutputTab`, `DiffTab`, `LogsTab`. *Tickets: gui/0077–0079.*
- Header + dual heartbeats. *Ticket: gui/0080.*
- Frame scrubber + rewind. *Ticket: gui/0081.*
- Retire `LiveRunChatView` dashboard, wire new view into existing
  navigation. *Ticket: gui/0082.*

---

## 5. Heartbeats

Two independent indicators side-by-side in the header.

1. **Engine heartbeat** — green if we've received a `TaskHeartbeat` (or any
   stream event) from Smithers within the last `heartbeatMs * 2` window.
   Amber if stale. Red if nothing for > `heartbeatMs * 5`. Animates a
   one-shot pulse every time a heartbeat arrives.
2. **UI heartbeat** — our local pulse watching the engine heartbeat.
   Pulses on a fixed 1s cadence regardless of engine state. When the gui
   itself stalls (SwiftUI main thread, network blocked), this stops
   pulsing — a frozen UI is visibly frozen, while the engine pulse stays
   still on screen.

Tooltip on hover: last-heartbeat-at, heartbeat interval, last seq.

---

## 6. Error rendering

First-class everywhere. Errors never buried.

- **Tree row**: red tag, faint red row background.
- **Ancestor chevrons**: red dot, visible even when collapsed (bubble-up).
- **Header**: run-level fail → red status pill.
- **Inspector**: red banner above tabs — summary + expandable stack + Retry.
- **Logs tab**: error events inline with red-tinted bubble.
- **Output tab**: if the task failed before producing output, show error +
  "Last partial output" (from `_smithers_attempts.heartbeatDataJson`).

Sources: `SmithersEvent.TaskFailed` / `RunFailed`,
`_smithers_attempts.errorJson`, `error` prop on the node in the snapshot.

---

## 7. Time travel

In scope for v1. Two modes:

1. **View-only scrub**: user drags the frame scrubber in the header; tree
   and inspector re-render against `getDevToolsSnapshot(runId, frameNo)`.
   Engine is untouched. Banner: *"Viewing frame N of M (historical)."*
2. **Actual rewind**: user clicks "Rewind to this frame". Calls
   `jumpToFrame(runId, frameNo)`. Engine reverts VCS pointers and replays
   from that frame. Requires explicit confirmation — destructive. Subsequent
   frames in the stream reflect the rewound state.

For finished runs, the scrubber starts at the last frame and works the same
way, minus the rewind action (rewind is live-run-only).

---

## 8. Non-goals (v1)

- Editing a running workflow from the UI (read-only; rewind is not editing).
- Source-code view for `<Task>` script / component render fn. Would require
  source maps from the reconciler. Deferred — flag only, no code.
- In-app terminal for hijack (keep the AppleScript bridge).
- Prop-content search (metadata-only in v1).
- Smart markdown/code detection in Output tab (v1 = minimal JSON render).
- Mobile / web. Desktop SwiftUI gui only.
- Collaboration features (shared cursors, comments).

---

## 9. Quality Standards (applies to every ticket)

Every ticket must satisfy these before it is considered done. Tickets
reference this section rather than repeating it.

### 9.1 Testing tiers

Each ticket must ship:

1. **Unit tests** for every exported function, reducer, state-machine
   transition, and parser. Branch coverage ≥ 90% on new code.
2. **Input-boundary tests** for every public input — explicitly list
   min / max / empty / oversize / malformed / unicode / null cases.
   Each boundary must either succeed as documented or return a **typed
   error** (not a 500 / not a crash).
3. **Integration tests** against real dependencies (real DB, real
   reconciler, real SwiftUI hierarchy) — not mocks — for any code that
   crosses a process / framework boundary.
4. **Happy-path E2E test** exercising the full user or RPC flow, asserting
   observable behavior (DB rows, emitted events, rendered UI).
5. **Failure-mode tests** for every documented error path: upstream
   unavailable, permission denied, malformed input, concurrency clash,
   timeout, resource exhaustion.
6. **Performance baselines** with explicit numeric budgets (per-ticket).
   Regression = fail CI.
7. **Soak / leak tests** for any long-lived subscription / store — run for
   ≥ 10 minutes, assert RSS does not grow monotonically.

### 9.2 Observability

Every RPC and long-lived client subscription must emit:

- **Structured logs** (one line per significant event) with `runId`,
  `nodeId` (if applicable), `seq`, caller identity, duration, outcome.
  Log levels: `debug` noisy-per-event, `info` lifecycle, `warn` recovered,
  `error` unrecovered.
- **Metrics** (OpenTelemetry-compatible counters + histograms): request
  rate, duration p50/p95/p99, error rate by class, payload size,
  cache-hit rate (where applicable), concurrent subscribers (where
  applicable).
- **Trace spans** covering the RPC boundary and every internal I/O
  (DB query, VCS call, sandbox call). Tag spans with `runId`, `nodeId`,
  and outcome.

GUI clients emit the same via `os_log` / Swift's unified logging — but
**never log user content** (prompts, outputs). Log only IDs, sizes, and
outcomes.

### 9.3 Error handling

- Every error returned from an RPC is a **typed error** with a machine-
  readable `code` (e.g. `RunNotFound`, `FrameOutOfRange`, `Busy`,
  `UnsupportedSandbox`). No stringly-typed `Error("something went
  wrong")`.
- Every user-reachable error carries a `message` safe to display +
  optional `hint` (remediation).
- **No silent failures.** Every `catch` either handles + logs + recovers,
  or re-throws. No swallowed errors.
- GUI surfaces every error with a retryable action where sensible. Never
  crash or show a permanent blank view.

### 9.4 Concurrency

- Every shared mutable store is either **single-owner** (actor / main
  thread) or protected by a clearly-named lock.
- RPCs that mutate shared state declare their concurrency contract:
  single-flight, N-concurrent, or unbounded.
- Streams must handle: slow consumer (backpressure), disconnect mid-emit,
  reconnect with gap, concurrent subscribers.

### 9.5 Security

- Every RPC runs through existing Gateway auth.
- Input validation: runId matches `/^[a-z0-9_-]{1,64}$/`, nodeId matches
  `/^[a-zA-Z0-9:_-]{1,128}$/`, iteration is a non-negative integer
  fitting in i32. Rejected inputs get `InvalidArgument` (never reach
  DB / VCS).
- Destructive RPCs (jumpToFrame) emit an audit log with caller +
  timestamp + before/after state.
- Never leak data from other runs: always scope queries by runId.

### 9.6 Accessibility (GUI)

Every new view must:

- Announce state to VoiceOver (rowLabel, isSelected, state badge).
- Be keyboard-only navigable (no mouse required for any action).
- Meet WCAG AA contrast on every text and badge color pair, including
  the failed / blocked / cancelled states.
- Respect `reduceMotion` — skip animations when the setting is on.

### 9.7 Documentation

- Every exported type / function has a one-line doc comment explaining
  the WHY (not what — names handle that).
- Every new RPC is added to the protocol reference doc.
- Every error code is listed with its meaning.

---

## 10. Glossary

- **Frame** — one snapshot of a run's React tree at a point in time. Stored
  in `_smithers_frames` as either a full XML or a delta.
- **Snapshot** — `DevToolsSnapshot`, the gui-facing pre-processed form of a
  frame.
- **Ghost state** — inspector showing data for a node that has been
  unmounted from the tree, with a banner indicating it's no longer live.
- **Engine heartbeat** — server-side pulse from Smithers indicating the run
  is alive (currently `TaskHeartbeat` + general stream events).
- **UI heartbeat** — gui-local pulse indicating the gui itself is responsive.
