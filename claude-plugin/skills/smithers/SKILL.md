---
name: smithers
description: "Drive Smithers, a durable control plane for long-running coding agents, from Claude Code. Use when the user wants multi-step, long-running, crash-safe, or human-in-the-loop agent work ('orchestrate agents', 'run a workflow', 'implement this and review it', 'keep iterating until tests pass', 'plan then build') or anything needing retries, approvals, replay, or evals across multiple AI steps. YOU (Claude) run Smithers on the user's behalf; it is not a GUI the human clicks. HARD RULE 1, right-size the route FIRST, handle a most-trivial edit directly, run ANY clear single-goal ask through `smithers oneshot`, even a large repo-wide one (one strong agent one-shots up to roughly 300k tokens in a single run), and reserve a full workflow for work that genuinely needs ordered stages, durability, approvals, loops, or reuse; never author a multi-node workflow for a single-goal task, and neither task size nor context-window worries ever justify one. HARD RULE 2, run long-running / multi-step / background work through a durable Smithers workflow, NOT through Task/Agent subagents, /loop, or hand-written native Workflow scripts; the native Workflow tool has exactly ONE sanctioned use, launching the plugin's smithers-run.mjs mirror so the run shows live in /workflows. HARD RULE 3, when creating or editing workflow code, ALWAYS use https://smithers.sh/llms-full.txt as the API reference (fetch it first). A workflow that runs long, fans out, or pauses on approvals should get a live custom UI at .smithers/ui/<key>.tsx (composed from the smthrs/gateway-ui + smthrs/ui component libraries over the gateway-react hooks, never hand-rolled markup), launched with `smithers ui` so the human can watch; short linear runs are fine on `smithers monitor`."
---

# Smithers (from Claude Code)

Smithers is a durable control plane for long-running coding agents: workflows
are TypeScript/JSX, run for minutes or days, and survive crashes (every
finished step persists, so a restart resumes from the last completed node).
Retries, approvals, replay, and evals live in one place.

## Right-size the route first

Use the lightest route that preserves the durability the task needs:

1. **Ambiguous goal or acceptance criteria**: ask the user clarifying
  questions (what outcome, what counts as done) and stop until they answer.
  "Make the settings page better" gets a reply that is ONLY clarifying
  questions, covering both the target and what "better"/"done" means — never
  a plan whose first step is to find out, and never a provisional plan under
  an assumed answer.
2. **Most-trivial one-off edit** (a rename, a config line, a quick answer):
  just do it directly. No Smithers. If the stored trivial preference is
  `oneshot`, launch with `--model opus` or `--model terra` — the ONLY two
  slots allowed for trivial oneshot, never sol, luna, kimi, or any other
  tier. Trivial means ONE tiny change in one
  place; an ask bundling multiple coordinated edits (code plus help text
  plus a test) is oneshot work, not trivial.
3. **Clear single-goal ask, at ANY size**: `smithers oneshot "<goal>"`. It
  runs one strong agent in the background with durable state, an optional
  reviewer, and a live chat/diff UI — no workflow file to author. One strong
  agent routinely finishes repo-wide, hours-long goals of up to roughly 300k
  tokens in a single run; the worker manages its own context, so "it will
   not fit in one context window" is never a reason to author a workflow.
   Oneshot picks the model from the goal: a UI-flavored ask leads with Kimi
   K3 (opencode's `kimi-for-coding/k3`, then kimi through pi
   (`pi --provider kimi-coding --model k3`), then the kimi CLI, backed by
   claude opus then fable); every other ask leads with claude opus. Every
   rung is availability-gated.
4. **Genuinely multi-goal work** (ordered phases, human approvals, loops with
  verified exits, several agents with different tools, schedules, reuse):
  a full workflow.

**Size does not pick the route; shape does.** Real asks that belong in a
single `smithers oneshot`, each historically one-shotted by one strong agent
in under 300k tokens:

- "Go through the entire codebase and make sure every feature is documented."
- "Run `pnpm up --latest` on every package and make sure all builds still pass."
- "Make CI green on this branch: rebase on main, fix failures, push until green."
- "Replace every use of library X with library Y and get all tests passing."
- "Read review.md, address every review comment, delete the artifacts when done."

Authoring a workflow (or running `create-workflow`) for asks like these is
overengineering. Escalate to a workflow only when you can name the
workflow-only feature the task requires; neither "it feels big" nor a seeded
workflow with a matching name (`audit`, `review`, `upgrade`) qualifies. Pick
exactly ONE route and commit to it — never a menu of routes or a hybrid.
Explicit user overrides win: "oneshot" forces oneshot, "oneshot with review"
adds `--review on`, "oneshot without review" adds `--review off`. Check
`smithers oneshot --status` before first use; if no usable agent is reported,
fall back to the direct or workflow route (oneshot being unavailable never
means YOU are; "no routing path exists" is never the answer).

Structure is a cost. The shipped OrchBench benchmark measured a solo frontier
agent at reward 0.901 / $10.49 / 19 min while a three-model review panel
scored LOWER (0.734) at 2.1x the wall clock, and review stages consumed more
time than implementation. Add nodes for named risks, not for ceremony.

## Repair-loop discipline (non-negotiable)

When you drive fix/verify rounds through Smithers (or hand-author repair
workflows), these rules stop the 100-run death spiral:

- **Same-signature budget.** If 3 consecutive rounds fail with the same
 failure signature, STOP authoring round N+1. Change strategy (gather
 evidence, widen scope) or escalate to the human via `smithers ask-human`
 with what you know. Thirteen hypotheses against one 500 is an incident,
 not progress.
- **Green ratchet.** Never let a previously-passing check go red after a
 harness/infra-only change without flagging it: that is a harness
 regression — revert or fix the harness, do not touch the product.
- **Never widen a red gate.** Acceptance criteria only grow while the gate is
 green. If the gate is red, narrow scope to the last-green slice and get
 back to green first.
- **Classify red before repairing.** A check that could not RUN (service
 unreachable, network denied, missing credentials, broken harness) is an
 environment fault, not product evidence. `smithers eval` exits 5 and marks
 such cases INCONCLUSIVE — repair the harness, never the product, on that
 signal.
- **Harness-vs-product ratio.** If several consecutive rounds only add
 test-infrastructure seams (env vars, simulators, local TLS), say so out
 loud and re-examine the approach with the human before adding another.
- **If the root cause looks fenced out** (read-only repo, forbidden path),
 propose widening the fence to the human instead of a deeper in-scope fix.
- **Use the engine's loops, not new files.** Iterate with `<Loop>` /
 `retries` / `smithers retry-task` inside ONE workflow so context and
 verdict history persist across rounds. Authoring a near-duplicate .tsx per
 attempt (with `noSessionPersistence` and a hand-maintained forensic prompt)
 throws away the run's memory each round and re-bills the same context.
- **Don't redact your own diagnostics blind.** Privacy rules belong on
 shipped artifacts and anything leaving the machine, not on a local debug
 loop; if rounds are being decided by response-body byte lengths, relax
 local redaction before the next round.

## Launch attribution

The plugin mirror supplies `--started-by-harness claude-code` and the current
`CLAUDE_CODE_SESSION_ID` automatically. For direct CLI launches use
`--started-by-harness`, `--started-by-session`, and only an explicitly chosen
`--started-by-prompt`; never copy workflow input, a goal, or a transcript into
the attribution prompt. MCP/Gateway callers use `startedBy: { harness,
sessionId, prompt }`. Codex/Claude CLI and MCP launches also best-effort detect
their current session; Kimi/OpenCode callers should pass a known session.

Reach Smithers two ways, both wired by this plugin:

- The **`smithers` MCP tools** (`list_workflows`, `run_workflow`, `watch_run`,
  `get_run`, `list_pending_approvals`, `resolve_approval`, `ask_human`,
  `get_node_detail`, `fork_run`, `time_travel`, ...).
- The **`smithers` CLI**: a real binary you invoke through Bash.

## Use Smithers, not Claude Code's dynamic orchestration

The headline rule: run long-running, multi-step, backgroundable, or
retry-needing work as a durable Smithers workflow, not hand-rolled
orchestration with Claude Code's own multi-agent machinery. Do not reach for:

- a hand-written script for the native **Workflow** tool,
- the **Task** / **Agent** subagent fan-out (spawning your own worker agents),
- **`/loop`** or any self-scheduled / ScheduleWakeup-style re-prompting loop.

These are ephemeral: the moment your turn ends, an ad-hoc subagent tree is
gone (no persisted steps, crash resume, retry, approval gate, replay, eval
history). Smithers keeps all of that: every node's output writes to a durable
store the instant it finishes.

**The native Workflow tool's one sanctioned use is the mirror**:
`workflows/smithers-run.mjs` (path in the SessionStart context) launches or
attaches to a run and mirrors it live into `/workflows` (details below).
Durable work always runs in the Smithers engine: never write your own
Workflow scripts or reimplement the mirror inline.

The mapping:

- "one clear goal, however big" → `smithers oneshot` (no workflow file, see
  "Right-size the route first" above).
- "fan out N workers" → one Smithers workflow with N nodes (or an array agent).
- "loop until tests pass" → a Smithers loop/retry node, not `/loop`.
- "do this in the background and check on it later" → `run_workflow` (detached) +
  the /workflows mirror, not a self-wakeup.
- "plan, then build, then review" → one workflow with `plan` → `build` → `review`
  nodes, not three chained Task calls.

Native tools are fine for a short, single-shot lookup that finishes inside this
turn (a quick search, reading a few files); anything durable, multi-step, or
backgroundable belongs in a Smithers workflow.

## The /workflows mirror (default-on live view)

Every Smithers run you start from Claude Code gets a live `/workflows` mirror
with zero per-workflow setup:

1. **Launch + mirror in one step**: invoke the native Workflow tool with the
   plugin's mirror script (path from the SessionStart context; fallback: glob
   `~/.claude/plugins/**/smithers*/workflows/smithers-run.mjs`):

   ```
   Workflow({
     scriptPath: "<plugin>/workflows/smithers-run.mjs",
     args: { workflow: "<workflow-id>", input: { ... } }
   })
   ```

   The script starts the detached run (`smithers workflow run --detach`), logs
   the runId, then mirrors it: phases from the workflow's real containers, one
   row per node, outputs on completion, approval banners.

2. **Attach to an existing run** with `args: { runId: "<run-id>" }`: after a
   session restart, when the user asks about a run you did not start, or when
   the SessionStart context reports non-terminal runs.

3. **The mirror is a view, not the run**: stopping it never stops the
   Smithers run; re-attach anytime. To stop a run, use `cancel_run` /
   `smithers cancel <runId>`.

4. **It scales itself**: data-dependent fan-outs and loop iterations appear as
   they materialize, very large runs collapse to per-phase summaries, and a
   continued run (continue-as-new) is followed automatically.

5. **React to what it surfaces.** Relay pending approvals or human requests to
   the human and resolve them yourself, exactly as in "You drive it" below. On
   a failure, run `smithers inspect <runId>` and report findings.

The mirror consumes the versioned `smithers claude tick` / `smithers claude
node-wait` CLI protocol; on a contract mismatch, update both the plugin and
`smthrs`, then re-attach.

## You drive it, the human does not

The human asks for an outcome ("implement rate limiting, don't stop until tests
pass"); you run the workflow, watch it, clear approval gates, and report back,
while Smithers spawns the *worker* agents (Claude Code, Codex, ...) inside the
workflow, where implementation happens.

**You run every Smithers command yourself, never tell the human to run one**:
when a run needs a human (an approval, an `ask_human` question), relay it in
plain language, collect the decision in chat, and call the resolving
tool/command (`resolve_approval`, `smithers approve`, ...) yourself.

### Do it — don't describe it

The #1 failure is narrating instead of acting: when asked to create/run/fix a
workflow, **use your tools right now** (write `.smithers/workflows/<key>.tsx`,
write `.smithers/ui/<key>.tsx`, run the `smithers` CLI / MCP tools), not paste
the workflow as a code block and stop. The files on disk are the answer.

## After every command: guide the user

Apply these three after every `smithers` command and before every workflow you
build:

1. **Act on the CLI's next steps**: nearly every `smithers` command ends with
   a "Next steps" (cta) block. Never drop it silently, run the obvious
   continuation yourself and relay the other options in plain language.
2. **Ask before you build.** Ask a few clarifying questions (goal, inputs,
   "done" condition, where a human should approve), then scaffold, render the
   graph, run, and watch together. Prefer the scaffolder to hand-writing:
   `smithers workflow run create-workflow --prompt "..."` (or `smithers
   make-workflow "<task>"`), then review the generated `.tsx` with the user.
3. **Proactively offer to visualize, every time**: the `/workflows` mirror
   (above), plus `smithers graph <file>.tsx` (renders the graph without
   executing), `smithers tree <run-id>` (live node tree), `smithers up
   <file>.tsx --interactive` or `smithers workflow run <id> --interactive`
   (the TUI monitor), the custom browser UI (`.smithers/ui/<key>.tsx` +
   `smithers ui <runId>`, mandatory: see below), and `smithers ui --app` for
   the full control-plane UI. Build one if the workflow has none yet.

## The core loop

1. `list_workflows`: see what exists (each reports `key`, `hasUi`, `uiPath`).
2. Author or pick a workflow at `.smithers/workflows/<key>.tsx`: **always fetch
   https://smithers.sh/llms-full.txt first and write against it** (see below).
3. **Author its UI at `.smithers/ui/<key>.tsx`** (mandatory, see below).
4. **Launch through the mirror**: Workflow tool + `smithers-run.mjs` with
   `args: { workflow: "<key>", input: { ... } }`. The run starts detached in the
   Smithers engine and appears live in `/workflows`; the mirror logs the runId.
5. **`smithers ui <runId>`**: also open the custom UI in the human's browser.
6. Watch the mirror, clear gates the moment the mirror or monitor surfaces them (`resolve_approval`),
   feed failures back in (`smithers inspect <runId>`), and report evidence from
   the mirror's return value.

A suspend on an approval gate is **waiting**, not failure (the CLI exits non-zero,
code 3, on suspend: expected). Node output rows are snake_case and array
fields are JSON strings.

## Workflow authoring reference (hard rule)

**ALWAYS use https://smithers.sh/llms-full.txt as the API reference for
workflows**: fetch it (WebFetch) before creating or editing any
`.smithers/workflows/*.tsx` file and write against it, never from memory. It's
the complete, current contract for components, agents, schemas, deps/needs,
loops, approvals, and outputs. Offline fallback: `bunx smthrs
docs-full` prints the same bundle; `bunx smthrs ask
"<question>"` answers targeted questions.

---

# Custom live UIs (for workflows that earn one)

A workflow that runs long, fans out, or pauses on approvals should get a
custom UI so the human can *watch the run live in their browser* instead of
reading text summaries. When you create such a workflow, or run one with no
UI yet (`hasUi: false` from `list_workflows`), author the UI and launch it.
A short linear pipeline does not need a bespoke UI — `smithers monitor`
already shows every run live; skip the UI rather than scaffold one out of
ceremony.

## The authoring contract (follow exactly — do not invent API)

A workflow UI is a **standalone React app** that the gateway bundles and
serves, fed entirely by live gateway hooks. The rules:

1. **Path & name:** exactly `.smithers/ui/<key>.tsx`, where `<key>` is the
   workflow file's basename without extension (`.smithers/workflows/foo.tsx` →
   `.smithers/ui/foo.tsx`). A name mismatch means no UI is mounted.
2. **Imports, ONLY these four:** `react`,
   `smthrs/gateway-react` (hooks + `createGatewayReactRoot`),
   `smthrs/gateway-ui` (prebuilt run widgets + page shell), and
   `smthrs/ui` (Button/Card/Tabs/Dialog/... primitives).
   No `components` package (server-side workflow-definition library, not
   browser UI), no third-party UI libraries, no extra dependencies, no `.css`
   imports (shipped components carry their own styles).
3. **First line is the JSX pragma:** `/** @jsxImportSource react */`.
4. **Mount with `createGatewayReactRoot(<App />)`** as the last statement: it
   finds `#root`, builds the gateway client, and wraps your app in both the
   action and live-sync providers. Do NOT call `ReactDOM.createRoot` or add
   your own providers.
5. **The run comes from the URL**, not props: read it with
   `new URLSearchParams(location.search).get("runId")` (the UI receives no
   React props). `smithers ui <runId>` opens `/workflows/<key>?runId=<runId>`.
6. **`useGatewayNodeOutput().data` is wrapped and hooks no-op safely when
   `runId` is undefined**: unwrap `response.data.row` → `data.row` → `data`
   before reading fields (see helper below; never read result fields straight
   off `.data`), and guard the "no run yet" render state.
7. **Compose from the component libraries below, never hand-roll** a run list,
   node tree, event log, approval queue, status pill, button, card, or empty
   state that a shipped component already provides. Bespoke markup is only for
   panes neither library covers (feed those with the hooks).

## The component libraries you compose from

- **`smthrs/gateway-ui`: run-shaped widgets.** Each connects to
  the gateway itself: `SimpleWorkflowDashboard` (one-component launch/watch/select
  dashboard), `WorkflowUiShell` (page scaffold: house styles +
  topbar with `title`/`meta`/`actions`), `RunMeta` (the `run-id · status ·
  connection` cluster for the shell's `meta` slot), `NodeChatStream`
  (**live per-node agent chat**: stdout, tool calls, reasoning as chat
  bubbles), `FleetTable` (selectable fan-out ledger rolling up
  live pipeline status from per-item `nodeIds`), `NodeStageStrip` (pipeline
  chips bound to node statuses), `NodeOutputCard`, `RunList`, `RunTree`,
  `RunEventLog`, `NodeOutputView`, `ApprovalPanel` (approve/deny buttons
  wired), `LaunchButton`, `WorkflowPicker`, `ConnectionBadge`, `StatusPill`,
  the `nodeStatusIndex`/`rollupNodeStatus` status helpers, plus the `theme`
  tokens.
- **`smthrs/ui`: token-native primitives** for everything else:
  `Button`, `Badge`, `StatusPill`, `Card`/`CardHeader`/
  `CardTitle`/`CardContent`, `Input`, `Textarea`, `Label`, `Alert`, `Table`,
  `Tabs`, `Dialog`, `Tooltip`, `Select`, `Progress`, `Separator`, `Skeleton`,
  `Spinner`, `EmptyState`, `SectionHeader`, `RowButton`, `KpiStat`, and the
  chat surface (`ChatTranscript`, `ChatMessage`, `ChatComposer`). Render
  `<SmithersUiStyles />` once at the root; everything is correct in light and
  dark automatically, so write zero CSS for anything these cover.

Default shapes, in order of preference:

1. Launch + watch only →
   `createGatewayReactRoot(<SimpleWorkflowDashboard workflow="<key>" />)`, done.
2. Bespoke output → `WorkflowUiShell` (with `meta={<RunMeta
   runId={runId} />}`) + gateway-ui widgets for runs/tree/events/approvals
   + `smthrs/ui` primitives for custom panes, fed by the
   hooks below.
3. Fan-out/pipeline workflows → `FleetTable` for the item ledger,
   `NodeStageStrip` for the top-level phases, and a detail pane per selected
   item.

**Live-feedback rule (non-negotiable): every agent node shown in a detail pane
gets a `NodeChatStream`** (`runId`, `nodeId`, `title`, `subtitle` = agent ·
model, `status` from `nodeStatusIndex`) so the human watches the agent's chat,
tool calls, and reasoning live; deterministic nodes use
`NodeOutputCard` instead. Hand-rolled status pills (`borderRadius: 999` + hex
colors), raw `<table>` markup, and hand-built status-rank maps are rejected by
the `create-ui` compliance gate (`gradeWorkflowUiSource` in
`smthrs/scorers`): compose the components above instead.

## The hooks you actually have (from `smthrs/gateway-react`)

- `useGatewayRunEvents(runId, { afterSeq: 0 })` → `{ events, lastHeartbeat,
  streaming, error }`. Live event stream: each event is `{ type, event, payload,
  seq, stateVersion }`. **No `data`/`refetch`.** Match to a run via
  `payload.runId`; heartbeats are filtered out.
- `useGatewayNodeOutput({ runId, nodeId, iteration })` → `GatewayAsyncState`
  (`{ data, error, loading, refetch }`): one node's stored output (wrapped:
  unwrap it), auto-disabled until `runId` and `nodeId` are both set.
- `useGatewayRun(runId)` → live single-run record (`data` = run or `undefined`).
- `useGatewayRuns({ filter: { limit } })` → live list of run summaries
  (`runId`, `workflowKey`, `status`, `createdAtMs`), for building a run picker.
- `useGatewayApprovals()` → live pending approvals (`{ runId, nodeId, iteration,
  requestTitle }`). Pair with `actions.submitApproval` for approve/deny buttons.
- `useGatewayActions()` → stable imperative methods: `launchRun({ workflow, input
  })` (returns `{ runId }`), `cancelRun({ runId })`, `resumeRun`, `rewindRun`,
  `submitApproval({ runId, nodeId, iteration, decision: { approved, note } })`,
  `submitSignal`, `hijackRun`, `cronCreate/Delete/Run`.
- `useGatewayRunTree(runId)` → `{ root, nodes, status }` for rendering your own
  node tree (status ∈ `ok|running|queued|failed|waiting`); you build the
  markup.

There are **no** bare `useRun`/`useNodes`/`useTimeline` hooks: every hook is
`useGateway*`.

## Minimal working example (model your UI on this)

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
house styles and topbar; `RunTree`/`RunEventLog`/`ApprovalPanel` connect to the
gateway themselves; the result pane uses `smthrs/ui` primitives.
The only hand-written logic is which node's output to headline: adapt
`RESULT_NODE_ID` and the rendered fields to the workflow's real node ids and
output schema. Add `LaunchButton` (or `useGatewayActions` for custom buttons)
for launch/cancel, and `RunList` for a run picker. Study the seeded
`.smithers/ui/*.tsx` files for richer patterns.

## Launching the UI

After you start a run, **always** open the UI for the human:

```bash
smithers ui <runId>          # opens the most relevant run's UI in the browser
smithers ui                  # latest run
smithers ui -w <key>         # open a workflow's UI directly
```

`smithers ui` auto-starts a local gateway (default `http://127.0.0.1:7331`) if
one isn't running, and opens `/workflows/<key>?runId=<runId>`. Run it yourself,
tell the human "I opened the live UI in your browser," and keep watching via
`watch_run` / `smithers inspect --watch`.

If `smithers ui` reports `NO_UI`, you forgot step 3: author
`.smithers/ui/<key>.tsx` and retry.
