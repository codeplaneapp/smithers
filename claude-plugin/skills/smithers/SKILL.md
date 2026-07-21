---
name: smithers
description: "Drive Smithers, a durable control plane for long-running coding agents, from Claude Code. Use when the user wants multi-step, long-running, crash-safe, or human-in-the-loop agent work ('orchestrate agents', 'run a workflow', 'implement this and review it', 'keep iterating until tests pass', 'plan then build') or anything needing retries, approvals, replay, or evals across multiple AI steps. YOU (Claude) run Smithers on the user's behalf; it is not a GUI the human clicks. HARD RULE 1, run long-running / multi-step / background work through a durable Smithers workflow, NOT through Task/Agent subagents, /loop, or hand-written native Workflow scripts; the native Workflow tool has exactly ONE sanctioned use, launching the plugin's smithers-run.mjs mirror so the run shows live in /workflows. HARD RULE 2, every workflow you create or run MUST get a live custom UI at .smithers/ui/<key>.tsx (composed from the smithers-orchestrator/gateway-ui + smithers-orchestrator/ui component libraries over the gateway-react hooks, never hand-rolled markup) and you MUST launch it with `smithers ui` so the human can watch. HARD RULE 3, when creating or editing workflow code, ALWAYS use https://smithers.sh/llms-full.txt as the API reference (fetch it first)."
---

# Smithers (from Claude Code)

Smithers is a durable control plane for long-running coding agents. Workflows are
TypeScript/JSX, run for minutes or days, and survive crashes: every finished step
is persisted, so a restart resumes from the last completed node. Retries, human
approvals, replay, and evals all live in one place.

You reach Smithers two ways, both already wired by this plugin:

- The **`smithers` MCP tools** (`list_workflows`, `run_workflow`, `watch_run`,
  `get_run`, `list_pending_approvals`, `resolve_approval`, `ask_human`,
  `get_node_detail`, `fork_run`, `time_travel`, ...).
- The **`smithers` CLI** — a real binary you invoke through Bash.

## Use Smithers, not Claude Code's dynamic orchestration

This is the headline rule for this plugin. When a task is long-running,
multi-step, runs in the background, or can fail and need a retry, **run a durable
Smithers workflow. Do NOT hand-roll the orchestration with Claude Code's own
multi-agent machinery.** Specifically, for that class of work do not reach for:

- a hand-written script for the native **Workflow** tool,
- the **Task** / **Agent** subagent fan-out (spawning your own worker agents),
- **`/loop`** or any self-scheduled / ScheduleWakeup-style re-prompting loop.

Those are ephemeral. The moment your turn ends, an ad-hoc subagent tree is gone:
no persisted steps, no resume after a crash, no automatic retry, no approval
gate, no replay, no eval history. Smithers gives you all of that for free because
every node's output is written to a durable store the instant it finishes.

**The one sanctioned use of the native Workflow tool is the mirror.** The plugin
ships a generic script, `workflows/smithers-run.mjs` (the SessionStart context
announces its absolute path), that launches or attaches to a Smithers run and
mirrors it live into Claude Code's `/workflows` tree. The durable work always
runs in the Smithers engine; the mirror is a view. Never write your own Workflow
scripts for durable work, and never re-implement the mirror inline.

The mapping:

- "fan out N workers" → one Smithers workflow with N nodes (or an array agent).
- "loop until tests pass" → a Smithers loop/retry node, not `/loop`.
- "do this in the background and check on it later" → `run_workflow` (detached) +
  the /workflows mirror, not a self-wakeup.
- "plan, then build, then review" → one workflow with `plan` → `build` → `review`
  nodes, not three chained Task calls.

The native tools are fine for a short, single-shot lookup that finishes inside
this turn (a quick search, reading a few files). The instant the work is durable,
multi-step, or backgroundable, it belongs in a Smithers workflow.

## The /workflows mirror (default-on live view)

Every Smithers run you start from Claude Code gets a live `/workflows` mirror,
with zero per-workflow setup:

1. **Launch + mirror in one step.** Invoke the native Workflow tool with the
   plugin's mirror script (path from the SessionStart context; fallback: glob
   `~/.claude/plugins/**/smithers*/workflows/smithers-run.mjs`):

   ```
   Workflow({
     scriptPath: "<plugin>/workflows/smithers-run.mjs",
     args: { workflow: "<workflow-id>", input: { ... } }
   })
   ```

   The script starts the detached run itself (`smithers workflow run --detach`),
   logs the runId, then mirrors the run: phases from the workflow's real
   containers, one row per node, outputs on completion, approval banners.

2. **Attach to an existing run** with `args: { runId: "<run-id>" }` — after a
   session restart, when the user asks about a run you did not start, or when
   the SessionStart context reports non-terminal runs.

3. **The mirror is a view, not the run.** Stopping the mirror workflow never
   stops the Smithers run; re-attach anytime. To actually stop a run, use
   `cancel_run` / `smithers cancel <runId>`.

4. **It scales itself.** Data-dependent fan-outs and loop iterations appear as
   they materialize; very large runs collapse to per-phase summaries; a
   continued run (continue-as-new) is followed automatically.

5. **React to what it surfaces.** When the mirror (or the background monitor)
   reports a pending approval or human request, relay it to the human in plain
   language, collect the decision, and resolve it yourself (`resolve_approval`,
   `smithers approve`). When it reports a failure, run `smithers inspect
   <runId>` and report findings.

The mirror consumes the versioned `smithers claude tick` / `smithers claude
node-wait` CLI protocol; if it reports a contract mismatch, update both the
plugin and `smithers-orchestrator`, then re-attach.

## You drive it, the human does not

The human asks for an outcome ("implement rate limiting, don't stop until tests
pass"). You reach for Smithers, run the workflow, watch it, clear approval gates,
and report back. Smithers spawns the *worker* agents (Claude Code, Codex, ...)
inside the workflow; that is where implementation happens.

**You run every Smithers command yourself. Never tell the human to run one.** When
a run needs a human (an approval, an `ask_human` question), relay it in plain
language, collect the decision in chat, and call the resolving tool/command
(`resolve_approval`, `smithers approve`, ...) yourself.

### Do it — don't describe it

The #1 failure is narrating instead of acting. When asked to create/run/fix a
workflow, **use your tools right now**: write `.smithers/workflows/<key>.tsx`,
write `.smithers/ui/<key>.tsx`, and run the `smithers` CLI / MCP tools. Do not
paste the workflow as a code block and stop. The files on disk are the answer.

## After every command: guide the user

Three standing behaviors, applied after every `smithers` command and before
every workflow you build:

1. **Act on the CLI's next steps.** Nearly every `smithers` command ends with a
   "Next steps" (cta) block of suggested follow-up commands. Never silently
   drop it: run the obvious continuation yourself and relay the other options
   to the user in plain language.
2. **Ask before you build, then guide step by step.** Before creating a
   workflow, ask the user a few clarifying questions (goal, inputs, "done"
   condition, where a human should approve), then walk them through the build:
   scaffold, render the graph, run, watch. Prefer the scaffolder over
   hand-writing: `smithers workflow run create-workflow --prompt "..."` (or the
   shorthand `smithers make-workflow "<task>"`), then review the generated
   `.tsx` with the user.
3. **Proactively offer to visualize, every time.** The `/workflows` mirror is
   the default view (it is already live if you launched through it; attach one
   if not). Also suggest: `smithers graph <file>.tsx` (renders the graph without
   executing), `smithers tree <run-id>` (live node tree),
   `smithers up <file>.tsx --interactive` or
   `smithers workflow run <id> --interactive` (the TUI monitor), the custom
   browser UI (`.smithers/ui/<key>.tsx` + `smithers ui <runId>`, mandatory per
   the hard rule below), and `smithers ui --app` for the full local
   control-plane UI. If a workflow has no UI yet, build one.

## The core loop

1. `list_workflows` — see what exists (each reports `key`, `hasUi`, `uiPath`).
2. Author or pick a workflow at `.smithers/workflows/<key>.tsx` — **always fetch
   https://smithers.sh/llms-full.txt first and write against it** (see below).
3. **Author its UI at `.smithers/ui/<key>.tsx`** (mandatory — see below).
4. **Launch through the mirror**: Workflow tool + `smithers-run.mjs` with
   `args: { workflow: "<key>", input: { ... } }`. The run starts detached in the
   Smithers engine and appears live in `/workflows`; the mirror logs the runId.
5. **`smithers ui <runId>`** — also open the custom UI in the human's browser.
6. Watch the mirror; clear gates the moment the mirror or monitor surfaces them
   (`resolve_approval`); feed failures back in (`smithers inspect <runId>`);
   report evidence from the mirror's return value.

A suspend on an approval gate is **waiting**, not failure (the CLI exits non-zero,
code 3, on suspend — that is expected). Node output rows are snake_case and array
fields are JSON strings.

## Workflow authoring reference (hard rule)

**ALWAYS use https://smithers.sh/llms-full.txt as the API reference for
workflows.** Before you create or edit any `.smithers/workflows/*.tsx` file,
fetch that URL (WebFetch) and write against what it says — it is the complete,
current contract for components, agents, schemas, deps/needs, loops, approvals,
and outputs. Do not write workflow code from memory. Offline fallback:
`bunx smithers-orchestrator docs-full` prints the same bundle; targeted
questions: `bunx smithers-orchestrator ask "<question>"`.

---

# MANDATORY: every workflow gets a live custom UI

**This is a hard rule for this plugin. A workflow without a UI is incomplete.**
Whenever you create a workflow, or run one that has no UI yet (`hasUi: false` from
`list_workflows`), you MUST author a custom UI and launch it so the human can
*watch the run live in their browser* instead of reading your text summaries.

## The authoring contract (follow exactly — do not invent API)

A workflow UI is a **standalone React app** that the gateway bundles and serves.
It is fed entirely by live gateway hooks. The rules:

1. **Path & name:** exactly `.smithers/ui/<key>.tsx`, where `<key>` is the
   workflow file's basename without extension (`.smithers/workflows/foo.tsx` →
   `.smithers/ui/foo.tsx`). A name mismatch means no UI is mounted.
2. **Imports — ONLY these four:** `react`,
   `smithers-orchestrator/gateway-react` (hooks + `createGatewayReactRoot`),
   `smithers-orchestrator/gateway-ui` (prebuilt run widgets + page shell), and
   `smithers-orchestrator/ui` (Button/Card/Tabs/Dialog/... primitives).
   No `components` package (that is the server-side workflow-definition library,
   not browser UI), no third-party UI libraries, no extra dependencies, no
   `.css` imports (the shipped components carry their own styles).
3. **First line is the JSX pragma:** `/** @jsxImportSource react */`.
4. **Mount with `createGatewayReactRoot(<App />)`** as the last statement. It
   finds `#root`, builds the gateway client, and wraps your app in BOTH the action
   provider and the live-sync provider. Do NOT call `ReactDOM.createRoot` or add
   your own providers.
5. **The run comes from the URL**, not props: read it with
   `new URLSearchParams(location.search).get("runId")`. The UI receives no React
   props. `smithers ui <runId>` opens `/workflows/<key>?runId=<runId>`.
6. **`useGatewayNodeOutput().data` is wrapped** — unwrap `response.data.row` →
   `data.row` → `data` before reading fields (see helper below). Never read
   result fields straight off `.data`.
7. **Hooks no-op safely when `runId` is undefined** — guard the "no run yet"
   render state.
8. **Compose from the component libraries below — never hand-roll** a run list,
   node tree, event log, approval queue, status pill, button, card, or empty
   state that a shipped component already provides. Bespoke markup is only for
   panes neither library covers (feed those with the hooks).

## The component libraries you compose from

- **`smithers-orchestrator/gateway-ui` — run-shaped widgets.** Each one connects
  to the gateway by itself: `SimpleWorkflowDashboard` (a complete
  launch/watch/select dashboard in ONE component), `WorkflowUiShell` (the page
  scaffold: house styles + topbar with `title`/`meta`/`actions`), `RunMeta`
  (the `run-id · status · connection` header cluster for the shell's `meta`
  slot), `NodeChatStream` (**live per-node agent chat** — stdout, tool calls,
  reasoning, streamed into chat bubbles), `FleetTable` (selectable fan-out
  ledger whose rows roll up live pipeline status from per-item `nodeIds`),
  `NodeStageStrip` (pipeline chips bound to node statuses), `NodeOutputCard`,
  `RunList`, `RunTree`, `RunEventLog`, `NodeOutputView`, `ApprovalPanel`
  (approve/deny buttons wired), `LaunchButton`, `WorkflowPicker`,
  `ConnectionBadge`, `StatusPill`, the `nodeStatusIndex`/`rollupNodeStatus`
  status helpers, plus the `theme` tokens.
- **`smithers-orchestrator/ui` — token-native primitives** for everything
  around those widgets: `Button`, `Badge`, `StatusPill`, `Card`/`CardHeader`/
  `CardTitle`/`CardContent`, `Input`, `Textarea`, `Label`, `Alert`, `Table`,
  `Tabs`, `Dialog`, `Tooltip`, `Select`, `Progress`, `Separator`, `Skeleton`,
  `Spinner`, `EmptyState`, `SectionHeader`, `RowButton`, `KpiStat`, and the
  chat surface (`ChatTranscript`, `ChatMessage`, `ChatComposer`). Render
  `<SmithersUiStyles />` once at the root. Everything is correct in light AND
  dark automatically — write zero CSS for anything these cover.

Default shapes, in order of preference:

1. The workflow only needs launch + watch →
   `createGatewayReactRoot(<SimpleWorkflowDashboard workflow="<key>" />)` and
   you are done.
2. The workflow has bespoke output → `WorkflowUiShell` (with `meta={<RunMeta
   runId={runId} />}`) + the gateway-ui widgets for runs/tree/events/approvals
   + `smithers-orchestrator/ui` primitives for the custom panes, fed by the
   hooks below.
3. Fan-out/pipeline workflows → `FleetTable` for the item ledger,
   `NodeStageStrip` for the top-level phases, and a detail pane per selected
   item.

**Live-feedback rule (non-negotiable): every agent node shown in a detail pane
gets a `NodeChatStream`** (`runId`, `nodeId`, `title`, `subtitle` = agent ·
model, `status` from `nodeStatusIndex`) so the human watches the agent's chat,
tool calls, and reasoning in real time; deterministic nodes use
`NodeOutputCard` instead. Hand-rolled status pills (`borderRadius: 999` +
hex colors), raw `<table>` markup, and hand-built status-rank maps are
rejected by the `create-ui` compliance gate (`gradeWorkflowUiSource` in
`smithers-orchestrator/scorers`) — compose the components above instead.

## The hooks you actually have (from `smithers-orchestrator/gateway-react`)

- `useGatewayRunEvents(runId, { afterSeq: 0 })` → `{ events, lastHeartbeat,
  streaming, error }`. Live event stream. Each event is `{ type, event, payload,
  seq, stateVersion }`. **No `data`/`refetch`.** Match to a run via
  `payload.runId`. Heartbeats are filtered out.
- `useGatewayNodeOutput({ runId, nodeId, iteration })` → `GatewayAsyncState`
  (`{ data, error, loading, refetch }`). One node's stored output (wrapped, unwrap
  it). Auto-disabled until `runId` and `nodeId` are both set.
- `useGatewayRun(runId)` → live single-run record (`data` = run or `undefined`).
- `useGatewayRuns({ filter: { limit } })` → live list of run summaries
  (`runId`, `workflowKey`, `status`, `createdAtMs`). Use to build a run picker.
- `useGatewayApprovals()` → live pending approvals (`{ runId, nodeId, iteration,
  requestTitle }`). Pair with `actions.submitApproval` for approve/deny buttons.
- `useGatewayActions()` → stable imperative methods: `launchRun({ workflow, input
  })` (returns `{ runId }`), `cancelRun({ runId })`, `resumeRun`, `rewindRun`,
  `submitApproval({ runId, nodeId, iteration, decision: { approved, note } })`,
  `submitSignal`, `hijackRun`, `cronCreate/Delete/Run`.
- `useGatewayRunTree(runId)` → `{ root, nodes, status }` if you want to render a
  node tree (status ∈ `ok|running|queued|failed|waiting`). You render the tree
  markup yourself.

There are **no** bare `useRun`/`useNodes`/`useTimeline` hooks — every hook is
`useGateway*`.

## Minimal working example (model your UI on this)

```tsx
/** @jsxImportSource react */
import { createGatewayReactRoot, useGatewayNodeOutput } from "smithers-orchestrator/gateway-react";
import { ApprovalPanel, ConnectionBadge, RunEventLog, RunTree, WorkflowUiShell } from "smithers-orchestrator/gateway-ui";
import { Card, CardHeader, CardTitle, EmptyState, SmithersUiStyles, StatusPill } from "smithers-orchestrator/ui";

// The node whose output is the workflow's headline result. Match your workflow.
const RESULT_NODE_ID = "result";

function runIdFromUrl(): string | undefined {
  if (typeof location === "undefined") return undefined;
  return new URLSearchParams(location.search).get("runId") ?? undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// useGatewayNodeOutput().data is wrapped: response.data.row -> data.row -> data.
function unwrapRow(value: unknown): Record<string, unknown> {
  const res = isRecord(value) ? value : {};
  const data = isRecord(res.data) ? res.data : res;
  return isRecord(data.row) ? data.row : isRecord(data) ? data : {};
}

function App() {
  const runId = runIdFromUrl();
  const output = useGatewayNodeOutput({ runId, nodeId: RESULT_NODE_ID, iteration: 0 });
  const row = unwrapRow(output.data);
  const result = typeof row.answer === "string" ? row.answer : "";

  return (
    <WorkflowUiShell
      title="Workflow run"
      meta={<StatusPill status={!runId ? undefined : result ? "ok" : "running"} />}
      actions={<ConnectionBadge />}
    >
      <SmithersUiStyles />
      {!runId ? (
        <EmptyState title="No run yet" description="Open this page with: smithers ui RUN_ID" />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <RunTree runId={runId} />
          <RunEventLog runId={runId} style={{ height: 320 }} />
        </div>
      )}
      {result && (
        <Card>
          <CardHeader>
            <CardTitle>Result</CardTitle>
          </CardHeader>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{result}</pre>
        </Card>
      )}
      <ApprovalPanel />
    </WorkflowUiShell>
  );
}

createGatewayReactRoot(<App />);
```

Every visible piece above is a shipped component: `WorkflowUiShell` injects the
house styles and topbar, `RunTree`/`RunEventLog`/`ApprovalPanel` connect to the
gateway by themselves, and the result pane is `smithers-orchestrator/ui`
primitives. The only hand-written logic is the workflow-specific part: which
node's output to headline. Adapt `RESULT_NODE_ID` and the rendered fields to
the workflow's real node ids and output schema. For launch/cancel from the UI,
add `LaunchButton` (or `useGatewayActions` for custom buttons); for a run
picker, add `RunList`. Study the seeded `.smithers/ui/*.tsx` files in the repo
for richer patterns.

## Launching the UI

After you start a run, **always** open the UI for the human:

```bash
smithers ui <runId>          # opens the most relevant run's UI in the browser
smithers ui                  # latest run
smithers ui -w <key>         # open a workflow's UI directly
```

`smithers ui` auto-starts a local gateway (default `http://127.0.0.1:7331`) if one
isn't running and opens `/workflows/<key>?runId=<runId>`. You run this command
yourself; then tell the human "I opened the live UI in your browser" and keep
watching the run via `watch_run` / `smithers inspect --watch`.

If `smithers ui` reports `NO_UI`, you forgot step 3 — author `.smithers/ui/<key>.tsx`
and retry.
