---
name: smithers
description: >-
  Drive Smithers, a durable control plane for long-running coding agents, from
  Codex. Use when the user wants multi-step, long-running, crash-safe, or
  human-in-the-loop agent work ("orchestrate agents", "run a workflow",
  "implement this and review it", "keep iterating until tests pass", "plan then
  build") or anything needing retries, approvals, replay, or evals across
  multiple AI steps. YOU (Codex) run Smithers on the user's behalf; it is not a
  GUI the human clicks. HARD RULE: right-size the route FIRST, handle a
  most-trivial edit directly, run a clear well-scoped single-agent task through
  `smithers oneshot`, and reserve a full workflow for work that genuinely needs
  ordered stages, durability, approvals, loops, or reuse. A workflow that runs
  long, fans out, or pauses on approvals should get a live custom UI at
  .smithers/ui/<key>.tsx (composed from the smthrs/gateway-ui +
  smthrs/ui component libraries over the gateway-react hooks,
  never hand-rolled markup), launched with `smithers ui` so the human can
  watch; short linear runs are fine on `smithers monitor`.
---

# Smithers (from Codex)

Smithers is a durable control plane for long-running coding agents. Workflows are
TypeScript/JSX, run for minutes or days, and survive crashes: every finished step
is persisted, so a restart resumes from the last completed node. Retries, human
approvals, replay, and evals all live in one place.

## Right-size the route first

Use the lightest route that preserves the durability the task needs: handle a
most-trivial one-off edit directly; run a clear, well-scoped goal one strong
agent can finish in one context window through `smithers oneshot "<goal>"`
(durable background run, optional reviewer, no workflow file to author); and
reserve a full workflow for work that genuinely needs ordered stages, human
approvals, loops with verified exits, several agents with different tools,
schedules, or reuse. Structure is a cost: the shipped OrchBench benchmark
measured a solo frontier agent OUTSCORING a three-model review panel at half
the wall clock, so add nodes for named risks, not ceremony.

## Repair-loop discipline (non-negotiable)

When you drive fix/verify rounds through Smithers: stop after 3 consecutive
rounds fail with the same failure signature and escalate via
`smithers ask-human` instead of authoring round N+1. Never widen a red
acceptance gate (criteria grow only while green); never let a previously-green
check go red after a harness-only change without treating it as a harness
regression to revert. Classify every red before repairing: a check that could
not RUN (service unreachable, network denied, missing credentials, broken
harness) is an environment fault, not product evidence — `smithers eval`
exits 5 and marks such cases INCONCLUSIVE. Iterate with `<Loop>`/`retries`/
`smithers retry-task` inside ONE workflow instead of authoring a near-duplicate
.tsx per attempt, and keep local diagnostics readable: privacy redaction
belongs on shipped artifacts, not on your own debugging loop.

You reach Smithers two ways, both already wired by this plugin:

- The **`smithers` MCP tools** (`list_workflows`, `run_workflow`, `watch_run`,
  `get_run`, `list_pending_approvals`, `resolve_approval`, `ask_human`,
  `get_node_detail`, `fork_run`, `time_travel`, ...).
- The **`smithers` CLI** — a real binary you invoke through your shell.

> **If `smithers` is not on your PATH**, run it as `bunx smthrs
> <args>` — the exact package the MCP server in this plugin launches. So every
> `smithers <cmd>` below is equivalent to `bunx smthrs <cmd>`
> (e.g. `bunx smthrs ui <runId>`). Don't ask the human to install
> anything; fall back to `bunx` yourself.

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

### Orchestrator-only

For any task that runs in the background, takes more than a couple minutes, has
multiple steps, or can fail and need a retry: **do not fan out your own ad-hoc
subagents. Run a Smithers workflow instead.** Smithers persists each step the
instant it finishes, resumes after a crash, retries on failure, and stays
inspectable for days. Your own subagents lose all of that when your turn ends.

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
3. **Proactively offer to visualize, every time.** Suggest ways to *see* the
   workflow and the run: `smithers graph <file>.tsx` (renders the graph without
   executing), `smithers tree <run-id>` (live node tree),
   `smithers up <file>.tsx --interactive` or
   `smithers workflow run <id> --interactive` (the TUI monitor), the custom
   browser UI (`.smithers/ui/<key>.tsx` + `smithers ui <runId>`, mandatory per
   the hard rule below), and `smithers ui --app` for the full local
   control-plane UI. If a workflow has no UI yet, build one.

## The core loop

1. `list_workflows` — see what exists (each reports `key`, `hasUi`, `uiPath`).
2. Author or pick a workflow at `.smithers/workflows/<key>.tsx`.
3. **Author its UI at `.smithers/ui/<key>.tsx`** (mandatory — see below).
4. `run_workflow` (or `smithers run <key>`) → returns a `runId`.
5. **`smithers ui <runId>`** — opens the live UI in the human's browser.
6. `watch_run` / `smithers inspect --watch <runId>` — observe; clear gates with
   `resolve_approval`; feed failures back in; report evidence.

A suspend on an approval gate is **waiting**, not failure (the CLI exits non-zero,
code 3, on suspend — that is expected). Node output rows are snake_case and array
fields are JSON strings.

For the full API at any time, run `bunx smthrs docs-full` (prints
the complete `llms-full.txt`) or `bunx smthrs ask "<question>"`.

## Durable spawn-tool routing (recommended)

Codex >= 0.144 supports the alpha-tested native multi-agent spawn hint fields
`features.multi_agent_v2.multi_agent_mode_hint_text` and
`features.multi_agent_v2.usage_hint_text`. The dependency-free configurator at
`<plugin-dir>/scripts/configure-codex-routing.mjs` persists Smithers guidance
in the two supported `features.multi_agent_v2` hint fields using Codex App Server:

```bash
node <plugin-dir>/scripts/configure-codex-routing.mjs                 # dry-run
node <plugin-dir>/scripts/configure-codex-routing.mjs --apply          # install
node <plugin-dir>/scripts/configure-codex-routing.mjs --status         # inspect
node <plugin-dir>/scripts/configure-codex-routing.mjs --disable        # preview restore
node <plugin-dir>/scripts/configure-codex-routing.mjs --disable --apply
```

For an installed plugin, `<plugin-dir>` is the directory containing this
`skills/smithers/` directory; resolve that directory first if Codex runs from a
different workspace. Setup saves exact prior values in
`$CODEX_HOME/.smithers-codex-routing.json` and preserves the original snapshot
on later setup runs. Existing user-authored hint text is a conflict and is
never overwritten unless `--replace-existing-policy` is explicitly supplied.
Disable refuses to clobber edits made after setup and validates rollback. Use
`--status --require-effective` as an automation doctor check.

---

# Custom live UIs (for workflows that earn one)

A workflow that runs long, fans out, or pauses on approvals should get a custom
UI so the human can *watch the run live in their browser* instead of reading
your text summaries. When you create such a workflow, or run one that has no UI
yet (`hasUi: false` from `list_workflows`), author the UI and launch it. A
short linear pipeline does not need a bespoke UI — `smithers monitor` already
shows every run live; skip the UI rather than scaffold one out of ceremony.

## The authoring contract (follow exactly — do not invent API)

A workflow UI is a **standalone React app** that the gateway bundles and serves.
It is fed entirely by live gateway hooks. The rules:

1. **Path & name:** exactly `.smithers/ui/<key>.tsx`, where `<key>` is the
   workflow file's basename without extension (`.smithers/workflows/foo.tsx` →
   `.smithers/ui/foo.tsx`). A name mismatch means no UI is mounted.
2. **Imports — ONLY these four:** `react`,
   `smthrs/gateway-react` (hooks + `createGatewayReactRoot`),
   `smthrs/gateway-ui` (prebuilt run widgets + page shell), and
   `smthrs/ui` (Button/Card/Tabs/Dialog/... primitives).
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

- **`smthrs/gateway-ui` — run-shaped widgets.** Each one connects
  to the gateway by itself: `SimpleWorkflowDashboard` (a complete
  launch/watch/select dashboard in ONE component), `WorkflowUiShell` (the page
  scaffold: house styles + topbar with `title`/`meta`/`actions`), `RunList`,
  `RunTree`, `RunEventLog`, `NodeOutputView`, `ApprovalPanel` (approve/deny
  buttons wired), `LaunchButton`, `WorkflowPicker`, `ConnectionBadge`,
  `StatusPill`, plus the `theme` tokens.
- **`smthrs/ui` — token-native primitives** for everything
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
2. The workflow has bespoke output → `WorkflowUiShell` + the gateway-ui widgets
   for runs/tree/events/approvals + `smthrs/ui` primitives for
   the custom panes, fed by the hooks below.

## The hooks you actually have (from `smthrs/gateway-react`)

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
`useGateway*`. These names cover the common cases; the MCP server runs whatever
`smthrs` version `bunx` resolves, so for anything beyond the hooks
listed here, confirm the current surface with `bunx smthrs
docs-full` (or read the installed `smthrs/gateway-react` types)
before relying on it.

## Minimal working example (model your UI on this)

**Before you copy this:** open the workflow's `.smithers/workflows/<key>.tsx` and
read its real node ids and each node's output schema. The example below uses a
placeholder node id `"result"` and `iteration: 0` — you MUST replace those with
the workflow's actual node id(s), and for nodes that retry/loop, read the latest
iteration, not a hardcoded `0`. Copying the example verbatim onto a workflow whose
nodes are named differently produces a UI that shows nothing.

```tsx
/** @jsxImportSource react */
import { createGatewayReactRoot, useGatewayNodeOutput } from "smthrs/gateway-react";
import { ApprovalPanel, ConnectionBadge, RunEventLog, RunTree, WorkflowUiShell } from "smthrs/gateway-ui";
import { Card, CardHeader, CardTitle, EmptyState, SmithersUiStyles, StatusPill } from "smthrs/ui";

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
gateway by themselves, and the result pane is `smthrs/ui`
primitives. The only hand-written logic is the workflow-specific part: which
node's output to headline. Adapt `RESULT_NODE_ID` and the rendered fields to
the workflow's real node ids and output schema. For launch/cancel from the UI,
add `LaunchButton` (or `useGatewayActions` for custom buttons); for a run
picker, add `RunList`. Study the seeded `.smithers/ui/*.tsx` files in the repo
for richer patterns.

## Launching the UI

After you start a run, **always** open the UI for the human. Verify it resolves
before claiming it is open:

```bash
# 1. Confirm the UI mounts (prints the URL, does NOT open a browser).
#    Fails with NO_UI if you forgot to author .smithers/ui/<key>.tsx.
smithers ui <runId> --no-open      # or: bunx smthrs ui <runId> --no-open

# 2. Then actually open it for the human.
smithers ui <runId>                # opens the most relevant run's UI in the browser
smithers ui                        # latest run
smithers ui -w <key>               # open a workflow's UI directly
```

(If `smithers` is not on PATH, prefix every command with `bunx smthrs`.)

`smithers ui` auto-starts a local gateway (default `http://127.0.0.1:7331`) if one
isn't running and opens `/workflows/<key>?runId=<runId>`. You run this command
yourself; only after step 1 succeeds do you tell the human "I opened the live UI
in your browser." Then keep watching the run via `watch_run` /
`smithers inspect --watch`.

If `smithers ui` reports `NO_UI`, you forgot step 3 — author `.smithers/ui/<key>.tsx`
and retry.
