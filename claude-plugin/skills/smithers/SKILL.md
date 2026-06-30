---
name: smithers
description: "Drive Smithers, a durable control plane for long-running coding agents, from Claude Code. Use when the user wants multi-step, long-running, crash-safe, or human-in-the-loop agent work ('orchestrate agents', 'run a workflow', 'implement this and review it', 'keep iterating until tests pass', 'plan then build') or anything needing retries, approvals, replay, or evals across multiple AI steps. YOU (Claude) run Smithers on the user's behalf; it is not a GUI the human clicks. HARD RULE 1, run long-running / multi-step / background work through a durable Smithers workflow, NOT through the native Workflow tool, Task/Agent subagents, or /loop. HARD RULE 2, every workflow you create or run MUST get a live custom UI at .smithers/ui/<key>.tsx (built with gateway-react) and you MUST launch it with `smithers ui` so the human can watch."
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

- the native **Workflow** tool,
- the **Task** / **Agent** subagent fan-out (spawning your own worker agents),
- **`/loop`** or any self-scheduled / ScheduleWakeup-style re-prompting loop.

Those are ephemeral. The moment your turn ends, an ad-hoc subagent tree is gone:
no persisted steps, no resume after a crash, no automatic retry, no approval
gate, no replay, no eval history. Smithers gives you all of that for free because
every node's output is written to a durable store the instant it finishes.

The mapping:

- "fan out N workers" → one Smithers workflow with N nodes (or an array agent).
- "loop until tests pass" → a Smithers loop/retry node, not `/loop`.
- "do this in the background and check on it later" → `run_workflow` (detached) +
  `watch_run` / `smithers inspect --watch`, not a self-wakeup.
- "plan, then build, then review" → one workflow with `plan` → `build` → `review`
  nodes, not three chained Task calls.

The native tools are fine for a short, single-shot lookup that finishes inside
this turn (a quick search, reading a few files). The instant the work is durable,
multi-step, or backgroundable, it belongs in a Smithers workflow.

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

For the full API at any time, run `bunx smithers-orchestrator docs-full` (prints
the complete `llms-full.txt`) or `bunx smithers-orchestrator ask "<question>"`.

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
2. **Imports — ONLY these two:** `react` and `smithers-orchestrator/gateway-react`.
   No `components` package (that is the server-side workflow-definition library,
   not browser UI), no third-party UI libraries, no extra dependencies. Write
   plain HTML/JSX and inline all CSS in a `<style>` tag.
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
import {
  createGatewayReactRoot,
  useGatewayRunEvents,
  useGatewayNodeOutput,
} from "smithers-orchestrator/gateway-react";

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
  const stream = useGatewayRunEvents(runId, { afterSeq: 0 });
  const output = useGatewayNodeOutput({ runId, nodeId: RESULT_NODE_ID, iteration: 0 });
  const row = unwrapRow(output.data);
  const result = typeof row.answer === "string" ? row.answer : "";

  const status = !runId
    ? "no run — open with `smithers ui <runId>`"
    : result
      ? "finished"
      : stream.events.length > 0
        ? "running"
        : "waiting";

  const steps = stream.events.filter((e) => e.event?.startsWith?.("node."));

  return (
    <div className="wrap">
      <style>{styles}</style>
      <header>
        <h1>Workflow run</h1>
        <span className={`badge ${result ? "done" : "live"}`}>{status}</span>
      </header>

      <section className="timeline">
        {steps.length === 0 && <p className="muted">Waiting for the first step…</p>}
        {steps.map((e) => (
          <div className="step" key={e.seq}>
            <code>{e.event}</code>
            <span className="muted">{String((e.payload as any)?.nodeId ?? "")}</span>
          </div>
        ))}
      </section>

      {result && (
        <section className="result">
          <h2>Result</h2>
          <pre>{result}</pre>
        </section>
      )}
    </div>
  );
}

const styles = `
  .wrap { font: 14px/1.5 ui-sans-serif, system-ui; max-width: 820px; margin: 0 auto; padding: 24px; color: #111; }
  header { display: flex; align-items: center; gap: 12px; }
  h1 { font-size: 18px; margin: 0; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #eee; }
  .badge.live { background: #fde68a; }
  .badge.done { background: #bbf7d0; }
  .timeline { margin-top: 16px; display: grid; gap: 6px; }
  .step { display: flex; justify-content: space-between; padding: 6px 10px; border: 1px solid #eee; border-radius: 8px; }
  .step code { color: #2563eb; }
  .muted { color: #888; }
  .result { margin-top: 20px; }
  .result pre { background: #0b1020; color: #e5e7eb; padding: 14px; border-radius: 10px; overflow: auto; white-space: pre-wrap; }
`;

createGatewayReactRoot(<App />);
```

Adapt `RESULT_NODE_ID` and the rendered fields to the workflow's real node ids and
output schema. For a UI that also **launches/cancels/approves** runs and shows a
run picker, additionally use `useGatewayRuns` + `useGatewayActions` (build buttons
that call `actions.launchRun({ workflow: "<key>", input })`,
`actions.cancelRun({ runId })`, `actions.submitApproval({...})`). Study the seeded
`.smithers/ui/*.tsx` files in the repo for richer patterns; `e2e-probe.tsx` is the
minimal live-watch model and `kanban.tsx` is the full launch/approve model.

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
