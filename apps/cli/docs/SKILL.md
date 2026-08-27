---
name: smithers
description: >
  Drive Smithers, a durable control plane for long-running coding agents.
  Use when the user wants multi-step, long-running, crash-safe, or
  human-in-the-loop agent work: "orchestrate agents", "run a workflow",
  "implement this and review it", "keep iterating until tests pass",
  "plan then build", or anything that needs retries, approvals, replay,
  or evals across multiple AI steps. YOU (the agent) run Smithers on the
  user's behalf; it is not a GUI the human clicks. HARD RULE 0: if
  `SMITHERS_INSIDE_RUN` is set in your environment you are ALREADY a
  worker agent inside a Smithers node, so never invoke the Smithers CLI
  or MCP tools to launch or steer a run; do the node's task directly
  with your ordinary tools. Everything below applies only when it is
  unset. You are otherwise an
  ORCHESTRATOR: run long-running, multi-step, or background work
  *through* Smithers, not through your own ad-hoc subagents; spend your
   time observing the run and reporting. Also governs DELIVERABLE SHAPE
   even when no workflow is involved: a user-facing report, plan, or
   architecture document is a self-contained HTML page, and workflow
   UIs are composed from the shipped shared components
   (MarkdownEditor, DiffHunks, chat surfaces, KpiStat, StatusPill,
   EmptyState) rather than hand-rolled markup.
---

# Smithers

Smithers is a durable control plane for long-running coding agents. Workflows are
TypeScript (JSX), run for minutes or days, and survive crashes. Every finished
step is persisted in the workspace's durable run store, so a restart resumes
from the last completed node instead of starting over. Retries, human approvals,
replay, evals, and sandbox review all live in one place.

## ⚠️ Rule 0: if you are already inside a Smithers run, do not use Smithers

**Check this before anything else.** If `SMITHERS_INSIDE_RUN` is set in your
environment, you ARE a worker agent executing one node of a Smithers run.
Smithers sets that variable on every agent it spawns. This rule overrides every
routing rule below.

Do the node's task directly with your ordinary tools (read, edit, shell) and
finish your turn.

- Never launch or steer a run from inside a node: no `smithers up`, no
  `smithers workflow run`, no status-poll-and-sleep loop, and none of the
  Smithers MCP tools that start or watch runs.
- The prompt you were handed IS the work. It is never a request to orchestrate,
  even when it reads like one ("review this diff", "implement this feature").
- The one exception is escalating upward: `smithers ask-human` (or the
  `ask_human` MCP tool) when you are blocked, uncertain, or about to do
  something irreversible. That reports to the human running your run; it does
  not start a new one.

Everything below this section applies only when `SMITHERS_INSIDE_RUN` is unset.

## Route first: not every ask needs a workflow

Before reaching for any workflow machinery, route the ask:

1. **Ambiguous goal or acceptance criteria** → ask the user clarifying
   questions (what outcome, what counts as done) and stop until they answer. A
   discovery plan, a repo audit, or your own assumed definition of "better" is
   not a substitute for asking. Example: "make the settings page better" →
   reply ONLY with clarifying questions, covering BOTH the target (which
   settings page?) and the goal (what is wrong today? what does better mean?
   what counts as done?). The entire reply is the questions: never append a
   step-by-step plan whose first step is to find out, and never a provisional
   plan under an assumed answer.
2. **Clear single-goal ask, at ANY size** → do it directly with your ordinary
   tools. One agent working straight through finishes repo-wide, hours-long
   goals; you manage your own context across the task, so "this will not fit in
   one context window / one prompt" is NOT a reason to author a workflow. If
   you want the work to run durably in the background instead, run it as a
   regular workflow: `smithers up <file.tsx>`, or `smithers workflow run
   create-workflow --prompt "..."` (`smithers make-workflow`) to have Smithers
   build the file first.
3. **Genuinely multi-goal shape** (human approval gates, staged phases that
   need different agents or models, parallel fan-out, durable loops with caps,
   or a reusable procedure) → build and run a full workflow.

Size does not pick the route; shape does. "Make CI green", "upgrade every
dependency and fix all builds", and "document every feature in the codebase"
are each a single direct task, not a workflow. Name the workflow-only feature
you need before escalating to tier 3; "it feels big" never qualifies. A seeded
workflow with a matching name (`audit`, `review`, `upgrade`) is not a reason
either: existing workflows matter only when the task's shape needs one. Pick exactly ONE route and commit to it: never answer
with a menu of alternative routes, a hybrid, or "complementary strategies".

## Launch attribution

CLI launches may persist self-reported provenance with
`--started-by-harness`, `--started-by-session`, and
`--started-by-prompt`. Use the prompt flag only for deliberate launch context:
never reuse workflow input, `--prompt`, or a transcript. MCP and Gateway
callers send `startedBy: { harness, sessionId, prompt }`. Codex and
Claude short-lived CLI/MCP launches best-effort detect their active session;
Kimi/OpenCode callers should pass their known session explicitly.

## You drive it, not the human

This is the thing to internalize: **you, the AI agent, operate Smithers.** The
human asks for an outcome ("implement rate limiting and don't stop until the
tests pass"); you reach for Smithers, run the workflow, watch it, and report
back. Smithers spawns *other* agents (Claude Code, Codex, etc.) as the workers
inside a workflow. You are the operator standing at the control panel, not a
person clicking buttons in a UI.

So when a task is bigger than one prompt (it has stages, needs to survive a
crash, needs a human to approve a step, or needs to loop until something is
true) don't hand-roll it turn by turn. Run a Smithers workflow.

A corollary that is also a hard rule: **you run every Smithers command
yourself. Never instruct the human to run a Smithers command** or paste
commands for them to execute. When a run needs a human (an approval, an
`ask-human` question), relay the question in plain language, collect their
decision in conversation, and run the resolving command (`approve`, `deny`,
`human answer`, `signal`) yourself.

### ⚠️ Do it - don't describe it

**This is the single most common failure, so read it.** When asked to "create a
Smithers workflow" (or run, monitor, or fix one), the failure mode is to *narrate
the steps* - print `smithers init`, paste the workflow `.tsx` as a code block, or
write a numbered "here's how you'd do it" - instead of **actually doing it with
your tools right now.** Describing the work is not the work.

Concretely, when a request maps to a Smithers action:

- **Create a workflow** → call your file-write tool to author
  `.smithers/workflows/<id>.tsx` (or run `smithers workflow create <id>` via your
  shell tool, then edit the file). Do not emit the workflow source as a chat
  message and stop.
- **Run / inspect / fix a run** → invoke the `smithers` CLI through your shell
  (`Bash`) tool. Do not print the command for the human to paste.
- **If you catch yourself writing a how-to**, that is the signal to stop typing
  prose and start calling tools.

Two specific traps:

1. **Don't stall in read-only plan mode.** Designing a workflow is fine, but a
   plan that only *describes* the workflow and never writes the file is a
   non-answer. Leave plan mode (or never enter it for a scaffold request) and
   write the file. The workflow `.tsx` *is* the plan - make it real on disk.
2. **The `smithers` CLI is a real binary you invoke with Bash, not a tool you
   wait to be handed.** If a `smithers-*` tool isn't already loaded in your
   harness, just run the `smithers` command in a shell. Never let "I don't see a
   smithers tool" become "so I'll explain it instead."

### ⚠️ Gateway is the control plane - never drive the database

**This is a hard operator rule.** The workspace Gateway owns run discovery and
control. Long-lived controllers, Bun cron jobs, health monitors, bots, and
custom clients must use `smthrs/gateway-client` (or the Gateway
RPC/REST surface) for `listRuns`, `getRun`, event streaming, launch, resume,
cancel, approvals, signals, cron, scores, and node output. One-shot operator
actions through the public `smithers ps` / `inspect` / `why` / `approve` CLI are
also fine; those commands are the abstraction boundary.

Never import `openSmithersStore` or CLI-internal `findAndOpenDb`, instantiate
SQLite/PGlite/Postgres in an operator script, query `_smithers_*` tables, inspect
`.smithers/pg` or `smithers.db`, or parse the Gateway runtime state file. Those
are runtime, migration, and maintainer-diagnostic internals, not a client API.
Do not pass `--backend` to `ps`, `inspect`, or any other run-control command to
hunt for a run in a different store. Backend selection belongs at Gateway boot
or an explicit `smithers migrate` operation; all clients then talk to that one
workspace Gateway.

For a local controller, ensure the singleton exists with `smithers gateway`,
discover its verified URL with `smithers gateway status --format json`, and
construct `SmithersGatewayClient({ baseUrl, token })`. Do not assume port 7331:
the singleton may select another port and reports the real URL through `gateway
status`. The Gateway's health identity is the authority for workspace, version,
and backend.

### ⚠️ Orchestrator-only: Smithers does the work, your subagents do not

**This is a hard rule. Read it twice.**

You are an **orchestrator, not an implementer.** For any task that runs in the
background, takes more than a couple of minutes, has multiple steps, or could
fail and need a retry, **do NOT spawn your own subagents (the Task tool,
sub-tasks, "let me fan out N parallel agents") to do the work. Run a Smithers
workflow instead.** Smithers is the durable layer your ad-hoc subagents lack:
its steps persist the instant they finish, resume after a crash, retry on
failure, loop until a condition holds, run in isolated worktrees, and stay
inspectable for days. Hand-rolled subagents lose all of that the moment your
turn ends or the process dies; their work is gone and there is nothing to
resume from.

The division of labor is strict:

- **Smithers does the work.** Every real, long-running, or multi-step task
  (implement, debug, research, plan, review, migrate, audit, "keep going until
  X") goes into a Smithers run when its shape needs one (see "Route first"
  above): a workflow for a multi-goal shape. Smithers spawns the
  *worker* agents (Claude Code, Codex, …) inside the run; that is where
  implementation happens. You do not re-implement it yourself or in your own
  Task subagents.
- **You orchestrate and observe.** Your job is to translate the human's request
  into the right workflow, launch it, watch it (`ps`, `inspect --watch`,
  `chat --follow`, `events --watch`, `logs -f`), clear approval gates, feed
  failures back in, and report evidence. Most of your time should be spent
  *observing a run*, not typing the work yourself.
- **Subagents are for monitoring, never for the background work.** If you want
  parallel help, point your own subagents at *watching Smithers*: tailing a
  run, summarizing its events, flagging when a gate needs the human, diffing a
  node's output, never at building, fixing, or researching the thing a Smithers
  workflow should own. Monitoring with subagents: fine. Doing the actual
  background task outside Smithers: not fine.

Rule of thumb: **if you're about to spawn a subagent to "go build / fix /
research / migrate this," that is the exact signal to run a Smithers workflow
instead.** The only agents you launch directly are the lightweight ones watching
a Smithers run for you.

### Smithers is your plan mode, with muscle

Think of Smithers as a **powerful version of plan mode**. Plan mode lets you lay
out steps before acting; Smithers lets you lay out steps *and then actually run
them*, durably, in order, with retries, approvals, and loops baked in. Instead
of writing a plan in prose and executing it yourself one message at a time, you
encode the plan as a workflow graph (`<Sequence>`, `<Parallel>`, `<Branch>`,
`<Ralph>`) and hand it to the runtime. The plan becomes executable, resumable,
and inspectable: each step is a real agent task whose output is persisted and
checked before the next step runs. Reach for it whenever you'd otherwise be
tempted to "make a plan and then carefully do each part": Smithers *is* that,
made durable.

## How to guide the user (after every command)

Four standing behaviors. They apply after every `smithers` command you run and
before every workflow you build, and the rest of this skill assumes them.

1. **Act on the CLI's next steps.** Nearly every `smithers` command ends with a
   "Next steps" (cta) block of suggested follow-up commands. Never silently drop
   it: run the obvious continuation yourself, and relay the other options to the
   user in plain language so they can steer.
2. **Ask before you build, then guide step by step.** Before creating a
   workflow, ask the user a few clarifying questions (the goal, the inputs, the
   "done" condition, where a human should approve). Then walk them through the
   build one step at a time: scaffold, render the graph, run, watch. Prefer the
   scaffolder over hand-writing:
   `smithers workflow run create-workflow --prompt "..."` (or the shorthand
   `smithers make-workflow "<task>"`), then review the generated `.tsx` with the
   user. See [Authoring new workflows](#authoring-new-workflows).
3. **Proactively offer to visualize, every time.** Whenever a workflow or run is
   in play, suggest ways to *see* it instead of leaving the user with prose:
   - **Match the view to where the user already is.** If you are in a herdr
     terminal workspace (`HERDR_ENV=1`) or the user has a `smithers supervisor`
     open, that terminal cockpit **is** their live view: do **not** open the
     browser Monitor. Mirror the run into it with `smithers up … --herdr` and
     let the supervisor pick it up (it polls the workspace store and shows every
     run automatically); the user drives steer/hijack from the node panes or the
     supervisor's `Enter`. Only when there is **no** terminal cockpit, open the
     Smithers Monitor proactively: run `smithers monitor <run-id>` so the live
     web UI (status, execution tree, per-node live output, events, approvals)
     opens in the user's browser without being asked (pass `--no-open` to just
     print the URL). `smithers up` / `smithers workflow run` never open a browser
     themselves; browser opening belongs to `smithers monitor`, `smithers gui`,
     and `smithers ui`. Use `smithers ui <run-id>` for a workflow's custom UI.
   - `smithers graph <file>.tsx` renders the workflow graph without executing
     (also your pre-run sanity check; it must exit 0).
   - `smithers tree <run-id>` prints the run's live node tree, and
     `smithers up <file>.tsx --interactive` (or
     `smithers workflow run <id> --interactive`) opens the interactive TUI
     monitor for a run.
   - A custom browser UI: author `.smithers/ui/<workflowId>.tsx` by composing
     the `smthrs/gateway-ui` run widgets and
     `smthrs/ui` primitives over the
     `smthrs/gateway-react` hooks, then `smithers ui <runId>`
     opens it live. **If a workflow has no UI yet, offer to build one.** See
     [Custom workflow UIs](#custom-workflow-uis).
   - `smithers ui --app` serves the full local control-plane UI when the user
     wants the whole picture, every run and workflow in one place.
4. **Hand humans interactive commands.** When you give the human a command to
   run themselves, include the `--interactive` flag whenever the command
   supports it (`smithers up --interactive`,
   `smithers workflow run <id> --interactive`), so they land in the full-screen
   TUI monitor instead of staring at a detached log tail. Reserve the
   non-interactive forms for CI, scripts, and the commands you run yourself
   with your shell tool (never pass `--interactive` to a command you execute:
   it opens a full-screen TUI your harness cannot drive).

## Reports, plans, and architecture docs are HTML pages

When the user asks for a **report**, a **plan**, an **architecture document**,
or any other written deliverable meant to be read and shared, the deliverable
is a **self-contained HTML page** - one `.html` file with its styles embedded,
no server, no build, no external assets. Not a Markdown file, not chat
scrollback. Markdown is for READMEs and code-adjacent notes a developer edits;
anything the user will *read, present, or forward* gets HTML.

**Words like "plan" and "runbook" name documents here, not workflows.** When
the user asks you to *write* a plan, runbook, or postmortem, they want a
document to read - produce the HTML page. Reach for a workflow ("Smithers is
your plan mode", the `<Runbook>` pattern) only when the user wants the machine
to *execute* the steps, not when they want prose to read and share.

- **Produce the page, don't describe it.** Write the file
  (`report.html`, `plan.html`, `architecture.html`, or under `artifacts/`) and
  hand the user the path (or open it). A chat message *about* the report is a
  non-answer.
- **Make it a real page.** `<!DOCTYPE html>`, an embedded `<style>`, semantic
  sections, tables where they help, and HTML/CSS diagrams for architecture
  (boxes and arrows beat ASCII art). Polished enough to forward without
  apology.
- **Run reports too.** Summarizing what a run did? Source it from persisted
  state (`smithers inspect`, `events`, `scores`), not memory, and render HTML -
  the `report-maker` skill covers the run-slideshow variant.

## Reusable procedures belong in workflows

When you capture something reusable, capture it as a workflow. A one-off goal,
even a large repo-wide one, does not need a new workflow file.

A skill is *static instructions* - prose an agent reads and then has to execute
by hand, every time, with no memory that it ran, no retries, no gates, no typed
result. A Smithers workflow is the strict superset: it is **executable**
(it runs, it doesn't just describe), **durable** (every step persists and
resumes after a crash), **typed** (Zod-validated outputs instead of hope),
**inspectable** (`ps` / `inspect` / `timeline`), **composable** (it nests other
workflows and components), and **optimizable** (see below). Everything a skill
can say, a workflow can say *and then do*.

Use these rules:

- **One-off goal, at any size, needs no workflow file.** A clear goal with a
  single finish line gets done directly; never author a workflow just because
  the goal is large.
- **Reusable ⇒ workflow.** If you'd reach for a skill because the procedure
  recurs, that recurrence is the strongest possible reason to make it a workflow:
  one source of truth you can run, version, eval, and optimize, instead of
  instructions every agent re-interprets.
- **Multi-step ⇒ workflow.** If it has stages, loops, approvals, or different
  models per step, it was never a skill in the first place.

Don't hand-author the workflow from scratch unless it's trivial. Run the seeded
**`create-workflow`** workflow (see [Authoring new workflows](#authoring-new-workflows))
with a plain-English description and it scaffolds, verifies, and documents the
new workflow for you.

### Optimize workflows the way you'd optimize a skill

The reason teams iterate on skills is to make the agent better at a task: write
it down, watch it fail, tighten the wording, repeat. **Apply that exact loop to
workflows - except a workflow gives the loop real teeth instead of vibes:**

- **Evals instead of eyeballing.** `smithers eval workflow.tsx --cases
  evals/suite.jsonl` runs the workflow over a regression suite and scores it, so
  "did my change help?" has a number, not an opinion.
- **Scorers instead of "looks right."** Attach `faithfulness`, `relevancy`,
  `schemaAdherence`, or `llmJudge(...)` to any `<Task>` and read them with
  `smithers scores <run>`.
- **Automated prompt tuning instead of hand-wordsmithing.** `smithers optimize`
  (GEPA) searches prompt variants against your eval suite and writes an optimized
  prompt artifact. That is "make the instructions better," done by machine,
  measured against cases.

The same craft you'd put into a great skill - clear instructions, the right
context, tested edge cases - goes into a great workflow. The difference is the
workflow is the artifact that runs *and* the artifact you measure, so the
improvement compounds.

## 60 seconds to the aha

From inside the user's project (Bun ≥ 1.3, plus a model key like
`ANTHROPIC_API_KEY` in the env). Run these yourself with your shell tool - every
bare `smithers …` below is identical to `bunx smthrs …` if there
is no global install, so prefer `bunx smthrs …` when unsure:

```bash
# 1. Scaffold .smithers/ with the focused authoring workflows (create-workflow,
#    create-skill, docs-driven-development) and hidden system plumbing.
#    Add --yes (or set SMITHERS_NONINTERACTIVE=1) when running as an agent so init
#    never hangs waiting for interactive prompts.
smithers init --yes

# 2. Browse plain-English starters and their copy-paste commands
smithers starters

# 3. Author a brand-new workflow file, then make the graph render before running it
smithers workflow create my-workflow      # writes .smithers/workflows/my-workflow.tsx
smithers graph .smithers/workflows/my-workflow.tsx   # renders without executing - must exit 0

# 4. Run one. This dispatches a real coding agent to do the work, durably.
smithers workflow run create-workflow --prompt "Build a workflow for a /health endpoint"

# 5. Watch it
smithers ps                 # active / paused / recent runs
smithers logs <run-id> -f   # follow the event stream
```

That's the loop: scaffold → author / run a workflow → watch the run. The "aha" is
running a workflow (step 4): you kicked off a multi-step agent job that you can
crash, resume, fork, and inspect, all from the CLI you already live in.

When you start a run in the background (`up --detach`, `run --detach`, or the MCP
`run_workflow` tool), the user can't see its progress. The CLI hands you a
`monitoring` block telling you to offer them one of three ways to watch it, then
set up whichever they pick: (1) a status-report cron that polls `getRun` through
`SmithersGatewayClient` and streams run events when awake, (2) a live custom UI
(`smithers ui <run-id>`, authoring `.smithers/ui/<workflow>.tsx` first if none
exists), or (3) a quick static HTML page populated from the Gateway `getRun` and
`getDevToolsSnapshot` RPCs and refreshed every ~5 minutes. Surface these instead
of leaving the user blind, and offer the other visualizations too (`smithers
graph`, `smithers tree <run-id>`, the `--interactive` TUI); see
[How to guide the user](#how-to-guide-the-user-after-every-command).

**Starting a detached run makes you its supervisor until it ends.** A detached
run staying alive is not the same as it making progress: a run can grind
through node retries for hours without ever failing outright. The background
monitor turns that silence into notifications: `node-retrying` (a node's
active attempt reached the churn threshold, default 3) and `run-progress` (a
followed run produced no notification for a full window, default 30 minutes)
lines arrive alongside approval, failure, and stall alerts. When one lands,
relay a one-or-two-sentence status to the user right away, then decide: keep
watching, `smithers pause <run-id>` / `smithers cancel <run-id>`, or narrow
the work. Never let a detached run go hours without the user hearing its
state; if the monitor is unavailable, check `smithers status <run-id>`
yourself on the same cadence and report what you find.

Two verbs start a run, split by what you hand them. `smithers up <file>.tsx`
runs a workflow **file by path** (use this to start a run from a `.tsx` file).
`smithers workflow run <id>` (step 3 above) runs a **discovered/seeded**
workflow by its **id**, resolved from `.smithers/workflows/`.

For the compact static contracts that every new workflow must satisfy, read the
[workflow authoring rules](/workflows/authoring-rules) before writing JSX. It
covers reserved output columns, unsupported direct/forked nested-loop rejection
(while preserving the supported `Loop` → `Sequence` → `Loop` topology) and the
queue-based backfill pattern, `ctx.latest`/`outputMaybe` loop bindings, the
`renderWorkflow` production-test contract, and `.smithers/package.json` test
registration.

## The mental model

Smithers renders the workflow JSX tree every "frame." Each render answers one
question: *given what has already finished, what can run now?* Tasks produce
outputs validated by Zod schemas; the runtime persists them and renders again.
Crash mid-run and the next render picks up exactly where it left off: completed
nodes are never re-run.

```tsx
/** @jsxImportSource smthrs */
import { createSmithers, Sequence, Task } from "smthrs";
import { z } from "zod";

const { Workflow, smithers, outputs } = createSmithers({
  analyze: z.object({ summary: z.string(), severity: z.enum(["low", "high"]) }),
  fix: z.object({ patch: z.string() }),
});

export default smithers((ctx) => (
  <Workflow name="bugfix">
    <Sequence>
      <Task id="analyze" output={outputs.analyze} agent={analyzer}>
        {`Analyze the bug: ${ctx.input.description}`}
      </Task>
      <Task id="fix" output={outputs.fix} agent={fixer}>
        {`Fix: ${ctx.output("analyze", { nodeId: "analyze" }).summary}`}
      </Task>
    </Sequence>
  </Workflow>
));
```

Core components: `<Workflow>` (root), `<Task>` (an AI or static step),
`<Sequence>` (ordered), `<Parallel>` (concurrent), `<Branch>` (conditional),
`<Loop>` / `<Ralph>` (loop until a condition is true, great for "keep fixing
until the reviewer approves"), plus durable human-in-the-loop suspension
(`<Approval>`, `<HumanTask>`, `<Signal>`, `<WaitForEvent>`) and `<Timer>`,
sandboxes, and sub-flows. A suspended run is a row, not a process: it costs
nothing while it waits.

```tsx
<Ralph until={ctx.latest(outputs.review, "review")?.approved} maxIterations={5}>
  <Task id="implement" output={outputs.fix} agent={coder}>Fix based on feedback</Task>
  <Task id="review" output={outputs.review} agent={reviewer}>Review the implementation</Task>
</Ralph>
```

## Context engineering: the levers you pull

For a fixed model, output quality is a function of the context window you hand it.
Authoring a good script is context engineering. The doctrine you operate by, with
the full treatment in [Context engineering](/guides/context-engineering):

- **Three levers, and they trade off.** Quality (`<Panel>` + `<ReviewLoop>`: more
  attempts, model diversity, verification), cost (`<Sidecar>`: a cheap shadow model
  scored against the primary so you know when to promote it), and speed
  (`<Parallel>`). Pushing one usually costs another, so name which you are spending.
- **Stay in the smart zone.** Agents perform best under ~200k tokens of context,
  ideally under ~100k. Do research and planning up front so the implementer spends
  its window on the work. Watch it with `smithers.tokens.context_window_per_call`
  (histogram, buckets `[50k,100k,200k,500k,1M]`), the `TokenUsageReported` event
  (🧮), and `smithers node`. Cap it with `<Aspects tokenBudget>`;
  for a long loop, catch `ASPECT_BUDGET_EXCEEDED` and `<ContinueAsNew>` to a fresh
  context (durable `/clear`).
- **Plan the validation, not the feature.** Review is cheapest on a plan, miserable
  on a diff. Review the plan, test the output, skip the diff. A vetted plan with
  teeth (named tests, machine-checkable "done") plus real backpressure takes a
  complex feature from ~40% to ~98% one-shot. Never call it done without an e2e test.
- **Sandwich delegation.** Smart, expensive models plan and review at the ends;
  cheaper models implement the middle. Recurse as the work grows. Do not spend your
  most expensive model on work a cheaper one can do.
- **You are the lifeline; keep your own window lean.** As the long-lived orchestrator
  driving these runs, your context is the scarce resource, not the sub-agents'. Never
  read a large diff, log, or file into your own window; spawn a throwaway sub-agent
  (or a `<Task>`) to read it and return one paragraph. Judge the same way: a fresh
  verifier ranks best-of-N and hands back a verdict, so you never pull N diffs into
  your context. A polluted orchestrator degrades every decision downstream.
- **Re-read your instructions to fight drift.** Long sessions drift from their
  instructions. Every few steps, re-read the spec/goal you are working to (and this
  doctrine) and check recent behavior against it: right model tier, evidence bar
  actually enforced, still on the stated goal. Self-caught drift is free; drift the
  human catches costs a day. `<ContinueAsNew>` re-injects the goal for this reason.

## Reading outputs, and fanning out over worktrees

Two data-access facts the API examples above don't make obvious, and that you
need the moment you fan out:

- `ctx.output(table, { nodeId })` / `ctx.latest(table, nodeId)` read a single node. But
  `ctx.outputs.<schemaName>` is the **full array of every row written for that
  schema**, across all nodes and all loop iterations. That array is how you wire
  per-item work: give each item an id field in its schema, then filter
  (`ctx.outputs.review.filter(r => r.itemId === id)`) and take the last match to
  get "this item's latest review." Without this you cannot tell which of N
  parallel agents produced which row.
- Fresh runs and graph previews parse `ctx.input` through its Zod schema, so
  defaults and transforms are available while rendering. Coalesce only fields
  declared optional or nullable (`ctx.input?.maxConcurrency ?? 4`).

Fan-out, isolate, then serialize the risky merge:

- `<Worktree path={...} branch={...} baseBranch="main">` runs its children in an
  **isolated checkout**. In a jj repo it is a `jj workspace` with a bookmark
  named `branch`; the agent's edits auto-snapshot into `@`. To turn that into a
  PR from a compute task: `jj describe -m ...` → `jj bookmark set <branch> -r @`
  → `jj git push --bookmark <branch> --allow-new --remote origin` → `gh pr
  create`. (Plain `git` does not work inside a jj workspace dir; use `jj`.)
- `<MergeQueue maxConcurrency={1}>` is just a **concurrency limiter** (default 1).
  It does not merge anything itself; you put your own merge `<Task>`s inside it so
  they run one at a time instead of racing the shared base branch.

The canonical end-to-end shape (discover → per-item `<Worktree>` with an
implement/review `<Loop>` → `<Approval>` gate → `<MergeQueue>`) is worked out in
`.smithers/workflows/studio-parity-swarm.tsx`; read it before hand-rolling a
multi-worktree workflow.

## Why a durable runtime, not a queue or a framework

The right agent topology changes every six months (chains → ReAct → tools →
plan-execute → crews/swarms → background agents). Underneath all of them sits a
layer that *doesn't* change: durable steps, persisted state, retries,
suspension, observability. Smithers is that stable layer. Build it yourself from
a queue + a database and you reinvent ~60% of a real durable-execution engine,
badly; couple to a topology framework and you rewrite when the meta moves.
Smithers hands you the primitive instead and lets you compose the shape: one
high-token agentic workflow (gstack) shrank ~80% just by composing components
rather than hand-writing the orchestration.

## Patterns ship as components, so don't hand-roll them

Anything seen twice across the orchestration field was promoted to a composable
component. Reach for these before writing your own loop:

- `<ReviewLoop>`: producer + reviewer(s), loop until approved (array = consensus)
- `<Optimizer>`: generator + evaluator, loop until a target score
- `<ScanFixVerify>`: scanner → parallel fixers → verifier, retry survivors
- `<Panel>`: N reviewers in parallel, a moderator synthesizes (vote/consensus/merge)
- `<Debate>`: proposer vs opponent for N rounds, a judge decides
- `<Supervisor>`: boss plans, workers run in parallel, boss re-delegates failures
- `<Saga>`: forward steps with compensations that fire in reverse on failure
- `<Kanban>` / `<MergeQueue>`: items flow through columns / serialize risky ops
- `<EscalationChain>`: tier 1 → tier 2 → human on low confidence
- `<ClassifyAndRoute>` / `<GatherAndSynthesize>`: route to specialists / fan-out-fan-in

More ship in the box (`<CheckSuite>`, `<DecisionTable>`, `<Poller>`,
`<Runbook>`, `<DriftDetector>`, `<ContentPipeline>`, `<TryCatchFinally>`,
`<ContinueAsNew>`) and the catalog grows; check the docs for the current set.
Each is ~20–40 lines of JSX over the substrate, so read, fork, or copy them.
Ready-to-edit workflow and component recipes live in `examples/` (listed
below); copy the complete dependency closure for the pattern you choose.

## Beyond control flow: the production surface

The same substrate carries the concerns you'd otherwise bolt on later:

- **Isolation**: `<Worktree>` (per-agent jj workspaces), `<Sandbox>` (microsandbox / docker / process), `<Subflow>` & `<SuperSmithers>` (nest a workflow as a node).
- **Budgets**: `<Aspects tokenBudget={{ max, onExceeded }}>` propagates token / latency budgets to a subtree, enforced at task dispatch: before each descendant task the engine checks the run's accumulated tokens against `max` and applies `onExceeded` (`fail` raises `ASPECT_BUDGET_EXCEEDED`, `warn` logs, `skip-remaining` skips the task). The per-task limit (`perTask`) is not enforced yet. Catch `ASPECT_BUDGET_EXCEEDED` in a `<TryCatchFinally>` whose catch renders `<ContinueAsNew>` to do a durable `/clear` (see [Context engineering](/guides/context-engineering)).
- **Scorers / evals**: attach `faithfulness`, `relevancy`, `schemaAdherence`, or `llmJudge(...)` to any `<Task>`; inspect with `smithers scores <run>`.
- **Memory**: cross-run facts + history per namespace; `memory={{ recall, save }}` auto-injects the top-K relevant facts; query with `smithers memory`.
- **Hot mode**: `--hot true` re-renders against persisted state when you edit the workflow or an `.mdx` prompt mid-run; finished tasks stay put.
- **Time travel**: every render is a frame: `smithers timeline | fork | replay | rewind | diff | timetravel | retry-task`.
- **Observability / serving**: `smithers observability --detach` (Grafana/Prometheus/Tempo/OTLP); `smithers observability --down` stops it; `smithers up … --serve --metrics` exposes an HTTP API, SSE event stream, and `/metrics`. A workflow can even serve its own React front-end.
- **Agents**: pluggable runtimes (claude, codex, antigravity, kimi, amp, forge, Effect-native) configured in `agents.ts`; `agent={[primary, fallback]}` falls back on failure.
- **Tools**: built-in `read`/`write`/`edit`/`bash`/`grep`/`ls` with path containment (`--root`); `smithers openapi <spec>` generates typed AI SDK tools from an OpenAPI spec.
- **Integrations**: run Smithers itself as an MCP server (`smithers mcp add`), sync skills into agent dirs (`smithers skills add`), durable schedules (`smithers cron`), pager-style `smithers alerts`, a structured `<HumanTask>` queue (`smithers human`), and `smithers hijack` to hand off a live agent session. Optionally mirror a run into a [herdr](https://herdr.dev) terminal workspace with `smithers up … --herdr` (a pane per agent node running `smithers tail`, plus `smithers herdr attach <run-id>` / `smithers herdr status`); it is fully degradable and never affects the run.
- **Lower-level API**: `Smithers.workflow().step(...)` exposes the raw Effect-ts surface (Schedules, Layers, fibers); mix it with JSX in one workflow.

## The `.smithers/` folder

`smithers init` scaffolds a `.smithers/` directory in the project. It is a real
Bun/TypeScript package (it has its own `package.json`, `tsconfig.json`,
`bunfig.toml`, and `preload.ts`), and it's where everything you author lives.
The layout separates the four things you edit (**agents, workflows, prompts,
and components**) from runtime state, which is gitignored.

```
.smithers/
├── agents.ts            # WHERE AGENTS ARE CONFIGURED. Named agent pools
│                        #   (claude, smart, cheapFast, smartTool, …) mapped to
│                        #   provider instances (ClaudeCodeAgent, Codex, …).
│                        #   Workflows import { agents } from "../agents".
│                        #   Generated from ~/.smithers/accounts.json. Manage
│                        #   accounts with `smithers agents add|list|remove`.
├── smithers.config.ts   # repoCommands { lint, test, coverage } the workflows call
├── workflows/           # WHERE WORKFLOWS GO. One .tsx per workflow (implement,
│                        #   review, plan, ralph, debug, research, …). These are
│                        #   the executable graphs you run. `smithers up
│                        #   <file>.tsx` runs one by FILE PATH; `smithers
│                        #   workflow run <id>` runs a discovered one by ID.
├── prompts/             # WHERE MDX PROMPTS GO. One .mdx per prompt, authored as
│                        #   JSX prompt components. A workflow imports one and
│                        #   renders it as a tag:
│                        #     import PlanPrompt from "../prompts/plan.mdx";
│                        #     <PlanPrompt prompt={ctx.input.prompt} />
├── components/          # WHERE COMPONENTS GO. Seeded local-pack reusable workflow
│                        #   .tsx pieces and their Zod output schemas
│                        #   (ValidationLoop, Review, LoopUntilScored,
│                        #   ForEachFeature, …). Imported by workflows like any
│                        #   React-style component.
├── monitor/             # WHERE MONITORS GO. One .tsx per watched workflow, named
│                        #   `<workflowId>.tsx`. Smithers auto-launches it as a
│                        #   sibling run whenever that workflow starts, linked by
│                        #   parent_run_id, and tears it down when the run ends.
│                        #   Compose the shipped <Monitor> component. Optional:
│                        #   no file means no monitor and no behavior change.
├── ui/                  # workflow UI sources for the `smithers ui` command
├── specs/  tickets/     # feature specs and tickets some workflows read/write
│
│   # ── runtime state (gitignored; don't author here) ──
├── executions/  runs/   # per-run event logs and persisted frames
├── sandboxes/           # sandboxed review checkouts
├── state/  tmp/  *.db   # opaque runtime state; clients use Gateway
└── node_modules/
```

The mental shortcut: **agents** say *who* does the work (`agents.ts`),
**workflows** say *what* happens and in what order (`workflows/*.tsx`),
**prompts** say *what to tell the agent* (`prompts/*.mdx`), and **components**
are the reusable building blocks workflows compose from (`components/*.tsx`). A
typical workflow file imports from all three: `../agents`, `../prompts/foo.mdx`,
and `../components/Bar`. **Monitors** (`monitor/*.tsx`) are the odd one out:
they are workflows that watch *another* run rather than doing work themselves.

### Monitor workflows

Any workflow that runs long, unattended, or in a loop can silently wedge with
nobody watching. Give it a monitor: a workflow at
`.smithers/monitor/<workflowId>.tsx` that Smithers launches automatically, as a
sibling run, whenever `<workflowId>` starts.

```bash
bunx smthrs up .smithers/workflows/nightly.tsx    # auto-discovers .smithers/monitor/nightly.tsx
bunx smthrs up nightly.tsx --monitor ops/watch.tsx  # pick one explicitly
bunx smthrs up nightly.tsx --no-monitor             # opt out
```

The monitor is a child run (`parent_run_id` = the watched run), so `ps`,
`inspect`, and the Gateway show the pairing, `cancel` cascades to it, and it is
torn down when the watched run finishes. A monitor never gets a monitor of its
own. With no monitor file, nothing changes.

Compose the shipped `<Monitor>` component instead of hand-rolling a poll loop:
it is a heartbeat that samples the watched run, classifies it into one closed
condition (`healthy`, `stalled`, `wedged-node`, `runaway-loop`,
`awaiting-human`, `failing`, `unknown`), and routes that condition to a handler
through `<DecisionTable>`. Only `stalled` and `wedged-node` heal without a
human, because resuming a run and retrying a node are idempotent and
reversible; everything else escalates through a durable human request. The
monitor reads run state through `smthrs/gateway-client` or the
public CLI, never the store. See
[Monitor workflows](https://smithers.sh/guides/monitor-workflows).

## Operating runs

Everything is a CLI verb (prefix with `bunx smthrs` if it isn't on PATH):

```bash
smithers up workflow.tsx --input '{"description":"Fix bug"}'   # start a run from a .tsx FILE (by path)
smithers workflow run create-workflow --prompt "Build a workflow for this change" # start a run from a DISCOVERED workflow (by id)
smithers up workflow.tsx --run-id <id> --resume true          # resume after a crash
smithers ps                                                   # list runs
smithers inspect <run-id>                                     # full run state
smithers logs <run-id> -f                                     # follow events
smithers tail <run-id> --node <node-id>                       # tail one node's agent output verbatim
smithers up workflow.tsx --herdr                              # also mirror the run into a herdr workspace
smithers herdr attach <run-id>                                # mirror an already-running run into herdr
smithers approve <run-id> --node review --by alice            # clear an approval gate
smithers deny <run-id> --node review --by alice               # reject an approval gate
smithers signal <run-id> <signal-name> --data '{}'            # deliver a Signal/WaitForEvent payload
smithers cancel <run-id>                                      # stop a run
smithers eval workflow.tsx --cases evals/smoke.jsonl --suite smoke
```

When a workflow pauses on a human approval or question, the run is durable: it
waits. Resolve it with `smithers approve` / `smithers deny` / `smithers signal`
and the run continues from there. `approve` and `deny` take the same arguments:
the `<run-id>` (positional, required), `--node <node-id>` to pick the gate
(optional when exactly one gate is pending; required when several are),
`--by <name>` to record who decided, and an optional `--note "<reason>"`. After
denying, `onDeny` on the `<Approval>` decides what happens next (`fail`,
`continue`, or `skip`); resume the run with `smithers up <file> --run-id <id>
--resume true` to proceed.

`signal` takes `<run-id>` and `<signal-name>` as required positional arguments.
Use `--data '<json>'` for the payload (defaults to `{}`), `--correlation <id>` to
target a specific waiter, and `--by <name>` to record the sender. Example:
`smithers signal run_123 deploy.ready --data '{"ok":true}' --correlation ticket-42
--by alice`, then resume the paused run with `smithers up <file> --run-id run_123
--resume true`.

## When you're blocked, ask a human, never guess

The patterns above (`<Approval>`, `<HumanTask>`) are gates you declare **ahead of
time** in the graph. But an agent often discovers it's stuck **mid-task**: an
ambiguous decision, missing context, or an irreversible/destructive action it
shouldn't take on its own. The rule for any agent running inside a Smithers task:
**stop and ask a human; do not guess or proceed on an assumption.**

There is a first-class, blocking escalation for exactly this:

```bash
# From inside a run (an agent, a Task's shell, anywhere with the CLI):
smithers ask-human "Drop and recreate the prod `users` table to fix the migration?"

# Restrict the answer to fixed choices:
smithers ask-human "Which rollback target?" --choices "v1.4.2,v1.4.1,abort"

# Give up after a while instead of blocking forever:
smithers ask-human "Proceed with the deploy?" --timeout 1800
```

`ask-human` creates a **durable** human request bound to the current run and
**blocks** until a human resolves it. It auto-targets the run from the
`SMITHERS_RUN_ID` / `SMITHERS_NODE_ID` / `SMITHERS_ITERATION` env vars Smithers
injects into every agent it spawns (pass `--run-id` to override, or it falls back
to the single active run). It exits `0` with the answer on approval, and non-zero
(do **not** proceed) if the request is denied, cancelled, or times out.

Agents on the Smithers MCP surface get the same thing as the **`ask_human`** tool;
prefer it over inventing your own pause. The behavioral contract is baked into
the agent prompt: *blocked / uncertain / about to do something irreversible →
`ask_human` (or `smithers ask-human`) and wait.*

Resolving the request is the orchestrating agent's job, not the human's: relay
the question to the human in conversation, collect their decision, then submit
it yourself (never tell the human to run these):

```bash
smithers human inbox                                   # everything waiting on a human
smithers human answer <request-id> --value '"approve"' # unblock with an answer
smithers human cancel <request-id>                     # refuse, and the agent must stop
```

## When to use Smithers vs. just answering

Use the lightest route that preserves the needed durability.

- Handle any clear single-goal ask directly, small or repo-wide.
- Use a full workflow when the work is genuinely multi-goal in shape: approval
  gates, staged phases with different agents, parallel lanes, durable loops, or
  reuse.

Structure is a cost, not a virtue. The shipped OrchBench benchmark
(benchmarks/orchbench/RESULTS.md) measured a solo frontier agent at reward
0.901 / $10.49 / 19 min while a three-model review panel scored LOWER (0.734)
at 2.1x the wall clock, and review stages consumed more minutes than
implementation. Add a node, gate, or reviewer for a named risk (landing on
main, destructive actions, release gates), never as ceremony.

## Repair-loop discipline

When you drive fix/verify rounds through Smithers, these rules stop the
100-run death spiral:

- **Same-signature budget.** If 3 consecutive rounds fail with the same
  failure signature, stop authoring round N+1. Change strategy (gather
  evidence, widen scope) or escalate via `smithers ask-human`.
- **Green ratchet.** A previously-passing check that goes red after a
  harness/infra-only change is a harness regression: revert or fix the
  harness; do not touch the product.
- **Never widen a red gate.** Acceptance criteria grow only while the gate is
  green. A red gate narrows to the last-green slice first.
- **Classify red before repairing.** A check that could not RUN (service
  unreachable, network denied, missing credentials, broken harness) is an
  environment fault, not product evidence. `smithers eval` exits 5 and marks
  such cases INCONCLUSIVE; reviewers return `blocked` instead of
  `approved: false`. On those signals repair the harness, never the product.
- **Iterate inside one workflow.** Use `<Loop>`, `retries`, and
  `smithers retry-task` so context and verdict history persist; authoring a
  near-duplicate workflow file per attempt throws away the run's memory and
  re-bills the same context every round.
- **Keep local diagnostics readable.** Privacy redaction belongs on shipped
  artifacts, not on your own debugging loop.

## Keep the orchestrator context lean

Do not read the worker's full diff or logs. Check progress with one
`smithers chat <runId>` call, or the `get_chat_transcript` MCP tool, and give
the user the run UI URL.

## Examples: copy one and edit it

The repo ships ~90 runnable example workflows plus a few deployment/integration
setups. They're the fastest way to see a pattern wired end-to-end, so find the one
closest to the task, copy it into `.smithers/workflows/`, and edit. Browse them
on GitHub:

**https://github.com/smithersai/smithers/tree/main/examples**

*Starters & building blocks*
- `simple-workflow`: minimal schema-driven end-to-end workflow (start here)
- `pi-hello-world`: smallest possible workflow, one typed output
- `pi-tools-workflow`: minimal workflow exercising built-in tools
- `ralph-loop`: the Ralph loop: keep iterating until the work is done
- `fan-out-fan-in`: split work into N parallel agents, aggregate results
- `waterfall`: sequential phases, each receives the previous phase's output
- `etl`: Extract → Transform → Load, per-stage agents
- `milestone`: state-machine progression M0 → M1 → … → Complete
- `gate`: block execution until an external condition is met (polling)
- `plan`: agent produces a structured, prioritized action plan
- `discovery`: scan a codebase/API, categorize findings, store structured results
- `scaffold`: generate project/feature structure from a template or spec

*Multi-agent orchestration patterns*
- `code-review-loop`: producer + reviewer, loop until approved
- `review-cycle`: implement → review → fix, loop until approved
- `debate`: two agents argue opposing positions, a judge decides
- `panel`: N specialists review in parallel, a moderator synthesizes
- `supervisor`: boss agent plans and delegates to workers dynamically
- `kanban`: process items through columns (backlog → in-progress → review → done)
- `classifier-switchboard`: route items through a typed enum to specialists
- `triage`: intake → classify/prioritize → route to handlers
- `parallel-tickets`: triage → wave-by-wave parallel execution → merge queue
- `prompt-optimizer-harness`: run prompt variants against test cases, evaluate, pick best
- `gastown`: clone of Steve Yegge's multi-agent framework on Smithers primitives

*Code, repo & CI workflows*
- `refactor`: analyze → plan refactor → apply → validate
- `coverage-loop`: run tests → measure coverage → write tests → repeat to target
- `migration`: plan → transform files → validate → report
- `dependency-update`: check outdated deps → assess risk → update → verify
- `changelog`: analyze git history → categorize → generate changelog
- `doc-sync`: compare docs to code → find drift → fix → PR
- `docs-fixup-bot`: scan docs for broken examples/drift and propose fixes
- `docs-patcher`: detect public API/CLI changes, patch affected docs, verify
- `branch-doctor`: diagnose a broken branch (bad rebases, partial cherry-picks)
- `bisect-guide`: orchestrate git bisect with an agent reading each outcome
- `pr-lifecycle`: rebase → self-review → push → poll CI → merge
- `pr-shepherd`: watch a PR to ready-for-review, gather diffs/tests/context
- `repo-janitor`: scheduled cleanup of warnings, stale TODOs, broken examples
- `merge-conflict-mediator`: explain the semantic disagreement in a conflict
- `standards-reviewer`: review changes against repo-local standards files
- `patch-plausibility-gate`: verify a candidate patch before promotion
- `failing-test-author`: from an issue/traceback, write the smallest failing test
- `flake-hunter`: rerun a failing test under variants to characterize flakiness
- `test-sharder-judge`: use the diff to select and order the most relevant tests
- `repro-harness-builder`: build a minimal Docker/harness repro from an issue
- `change-blast-radius`: map a diff to impacted services, tests, docs, owners
- `smoketest`: setup environment → run smoke checks → report
- `audit`: scan → categorize → process → report

*Ops, SRE & monitoring*
- `alert-suppressor`: classify alerts against prior incidents, suppress noise
- `benchmark-sheriff`: run benchmarks vs a baseline, escalate only real regressions
- `canary-judge`: compare logs/metrics/traces between stable and canary
- `collector-probe`: wrap agent calls with timing/usage collection + alerting
- `command-watchdog`: run a command on a schedule, escalate only on failure
- `config-diff-explainer`: explain env/Helm/Terraform/k8s diffs
- `contract-drift-sentinel`: compare OpenAPI/JSON Schema/GraphQL/protobuf contracts
- `error-clusterer`: group recurring errors into clusters
- `log-digest`: compress build/test/deploy logs into root-cause hypotheses
- `mcp-health-probe`: periodically exercise MCP servers/tools, detect outages
- `rollback-advisor`: read failed-deploy evidence, produce a rollback/mitigation
- `runbook-executor`: run safe runbook steps, pause on risky ones for approval
- `slo-breach-explainer`: on SLO alarms, pull traces/logs and explain the breach
- `trace-explainer`: read agent/workflow traces, produce a concise explanation
- `visual-diff-explainer`: compare baseline/current screenshots, explain regressions
- `retry-budget-manager`: track retry budgets across steps, adapt backoff/routing
- `fail-only-report`: run commands, invoke an agent only when a run fails
- `schema-conformance-gate`: validate extracted/generated data against schema rules

*Typed extraction & data*
- `extract-anything-workbench`: reusable local workbench for typed extraction
- `typed-extractor-stage`: turn messy text/files into a typed structured object
- `dynamic-schema-enricher`: build/select output schemas dynamically at runtime
- `receipt-stream-watcher`: stream a structured extraction from receipt data
- `survey-answerer-agent`: read source material, produce constrained typed answers
- `openapi-contract-agent`: convert JSON Schema/OpenAPI into typed structures
- `blog-analyzer-pipeline`: ingest blog content, analyze topics, emit insights

*Business, inbox & support agents*
- `financial-inbox-guard`: monitor finance mailboxes for invoices/exceptions
- `invoice-approval-watch`: extract invoice data, validate, route for approval
- `lead-enricher`: enrich a raw inbound lead with firmographic/context data
- `lead-router-with-approval`: score leads, propose routing, gate on approval
- `meeting-briefer`: watch meetings, classify intent, gather CRM/context
- `feedback-pulse`: watch feedback streams, extract pain points and sentiment
- `revenue-scout`: scan conversations/forms for revenue signals
- `social-inbox-router`: classify social inbox items into leads/noise/etc.
- `service-desk-dispatcher`: distinguish incidents from requests/policy questions
- `support-deflector`: classify support issues, retrieve knowledge, deflect
- `memory-support-agent`: support conversations with durable cross-run memory
- `form-filler-assistant`: extract known fields from docs/input, fill forms
- `friday-bot`: scheduled digest gathering context across systems
- `tweet-thread`: post a pre-generated tweet thread to X/Twitter
- `trust-safety-moderator`: screen content, classify risk, route edge cases
- `compliance-evidence-collector`: gather compliance evidence from APIs/MCP tools
- `threat-intel-enricher`: enrich a security alert with external/internal context
- `ransomware-isolation-coordinator`: coordinate ransomware-response steps

*Agent runtimes & repros*
- `kimi-example`: minimal workflow run against the Kimi agent
- `chat-log-repro`: minimal chat-log-visibility repro (Claude Code + Codex)

*Deployment & sandbox integrations (subfolders)*
- `bun-port-smithers/`: production-oriented workflow pack (porting work for Bun)
- `microsandbox/`: first-class local microVM sandbox provider
- `dstack/`: Smithers + dstack on Google Cloud, serving Kimi K2
- `kubernetes/`: run Smithers workflows distributed on a Kubernetes cluster

## Authoring new workflows

You don't have to hand-write a workflow from scratch, and you shouldn't: first
ask the user the clarifying questions from
[How to guide the user](#how-to-guide-the-user-after-every-command), then let
the seeded **`create-workflow`** workflow build it from a plain-English ask
(`smithers make-workflow "<task>"` is the shorthand for the same thing):

```bash
bunx smthrs workflow run create-workflow \
  --prompt "Watch a landing request and auto-land it once CI is green"
```

It clarifies the request into a spec, **provisions the right docs and skills**
(pulls the relevant `llms-*.txt`, finds the closest `examples/` template, and
`smithers skills add`s the worker skills the new workflow needs), designs the
graph, pauses for your approval, scaffolds the `.tsx` + `.mdx` files, verifies the
graph renders (`smithers graph`) in a fix-and-retry loop, and writes a skill doc.
This is the "context engineering for you" layer: you describe the outcome and it
assembles the prompts, context, components, and gates. See the
[Context Engineering](https://smithers.sh/guides/context-engineering) guide for
the layered model behind it.

If you hand-author or hand-edit a workflow `.tsx` instead, read
[Workflow Authoring Rules](https://smithers.sh/workflows/authoring-rules)
first: reserved output columns, no nested loops (+ the queue-based backfill
pattern), `ctx.latest` vs `outputMaybe({ nodeId, iteration })` for loop
bindings, the `renderWorkflow`-based test contract, and
`.smithers/package.json` test registration. Every one of these is a "passes
`smithers graph`, fails at runtime hours later" trap if skipped.

### ⚠️ A workflow and its tests are one indivisible change

**Authoring a Smithers script and writing its tests with the Smithers workflow
testing library is a single act, not two.** A workflow `.tsx` delivered without
its test is unfinished work — do not report it as done, and do not offer the
test as an optional follow-up.

The rule, concretely, for a workflow at `.smithers/workflows/hello.tsx`:

1. Write the test at `.smithers/tests/hello.test.tsx` using
   `renderWorkflow` from `smthrs/testing`. It must load and
   render the **real** workflow module — a hand-built plan/graph object
   validates a stand-in that merely resembles the workflow and passes while
   the real file is broken.
2. Register it by appending `./tests/hello.test.tsx` to the space-separated
   `test` script in `.smithers/package.json`. That list is not a glob: an
   unregistered test is silently never run and contributes zero coverage.
3. Assert something real about the graph. The floor is four assertions:
   - the **expected node ids** are present;
   - their **expected order** (dependency edges) holds;
   - each task's **outputSchema** is the one you intended;
   - **branches and loops** render the right nodes for the inputs driving them.

   A truthiness smoke test (`expect(graph).toBeTruthy()`) does not meet the
   floor and is treated as a missing test.
4. Run it and see it pass before you finish.

`smithers graph` is a cheap structural pre-flight, and it
**never substitutes for the registered test**: it renders one frame with no
assertions, so it cannot catch a wrong schema, a wrong dependency edge, or a
branch that renders the wrong node.

## Custom workflow UIs

A workflow can ship a **first-class browser UI** that the Gateway bundles, serves at `/workflows/<key>`, and the Smithers PWA / Studio / `smithers ui` embeds same-origin. Reach for this when a workflow has long-running interaction the CLI can't show well: a composer for an open-ended chat, a question pool, a live spec, a custom diff view. Per [How to guide the user](#how-to-guide-the-user-after-every-command), **offer to build a UI for every workflow that lacks one**: author `.smithers/ui/<workflowId>.tsx` from the shipped component libraries (below), then open it with `smithers ui <runId>` (and `smithers ui --app` for the full control-plane UI).

Register the UI when you register the workflow:

```ts
gateway.register("my-workflow", workflow, {
  ui: { entry: ".smithers/ui/my-workflow.tsx", title: "My Workflow" },
});
```

The bundle is one file. Two shipping shapes:

- **React (recommended).** Compose from the shipped component libraries; hand-rolled markup and CSS is the last resort. `smthrs/gateway-ui` ships run-shaped widgets that each connect to the Gateway by themselves: `SimpleWorkflowDashboard` (a complete launch/watch dashboard in one component), `WorkflowUiShell` (the page scaffold with house styles), `RunList`, `RunTree`, `RunEventLog`, `NodeOutputView`, `ApprovalPanel`, `LaunchButton`, `WorkflowPicker`, `ConnectionBadge`, `StatusPill`. `smthrs/ui` ships the token-native primitives for everything around them (`Button`, `Card`, `Input`, `Tabs`, `Dialog`, `Table`, `StatusPill`, `EmptyState`, `KpiStat`, chat surfaces), correct in light and dark automatically. Under both sits `smthrs/gateway-react`: one call to `createGatewayReactRoot(<App />)` reads the boot config, mounts a provider, and gives the tree live hooks for bespoke panes: `useGatewayRun`, `useGatewayRunEvents`, `useGatewayNodeOutput`, `useGatewayApprovals`, `useGatewayActions` (for `submitApproval`, `submitSignal`, `cancelRun`, `rewindRun`, etc.). The hooks are **stale-data-free by construction**: when `runId` (or any input) changes, the prior data clears synchronously and any late response from the old inputs is dropped. A custom UI that switches between runs never blinks the wrong data. It automatically manages subscriptions, pushed updates, metrics, and resilient reconnections.
- **Vanilla.** `smthrs/gateway-client`. One `SmithersGatewayClient` class with `getRun`, `getNodeOutput`, `getNodeDiff`, `submitApproval`, `submitSignal`, `cancelRun`, and a `streamRunEventsResilient` async generator that reconnects with backoff + jitter and resumes from the last per-run `seq`. This generator handles live pushed updates, metrics streaming, and subscriptions. Pick this when you want zero dependencies or already own your render layer.

**Match the situation to the shipped component - never hand-roll these.** Each is the single shared implementation; reaching for it is the default, not an option:

| The situation | The component |
| --- | --- |
| The user edits a node's markdown output (spec, doc, report) | `MarkdownEditor` + `MarkdownEditorStyles` from `smthrs/ui/adapters/markdown-editor` - the shared WYSIWYG (Milkdown Crepe); the user edits the rendered document, **never raw markdown in a `<textarea>`** |
| Rendering a `DiffBundle` for review | `DiffHunks` from `smthrs/ui` (`@@`-grouped hunks, dual gutters, add/remove/context coloring, pagination built in) |
| A conversational workflow (agent questions ↔ user replies) | `ChatTranscript` + `ChatComposer` from `smthrs/ui` |
| Headline counts on an overview | `KpiStat` |
| Any run/node status badge | `StatusPill` (feed it `normalizeStatus`) |
| A zero-data state ("no runs yet") | `EmptyState` |
| Raw shell/test log output, live (ANSI, scrollback) | `Terminal` from `smthrs/ui/adapters/terminal` - a real xterm surface, not a styled HTML list |
| Where a run sits in a fixed pipeline of stages | `StageStrip` |
| Browsing the files a run changed | `FileTree` |
| Charting data (counts per category, trends, magnitudes) | `ChartContainer` + `ChartTooltipContent`/`ChartLegendContent` + `chartConfig` from `smthrs/ui/adapters/chart` (Recharts elements as children, series colors via the validated palette slots) - never `<canvas>`, chart.js, or hand-rolled SVG bars |

The bundle reads `?runId=<id>` from `location.search` for the run to scope to, and optionally `__SMITHERS_GATEWAY_UI__` (a `GatewayUiBootConfig`) for the mount path, RPC path, WebSocket path, and free-form `props` you set at `gateway.register({ ui: { props } })`.

**Auth.** The bundle never holds a token in the user-facing path. Same-origin Vite proxy (local dev) or a Cloudflare Worker (Smithers Cloud / Plue) terminates the user session, strips and re-injects trusted-proxy headers (`x-user-id`, `x-user-scopes`, `x-user-role`), and forwards `/v1/rpc/*`, `/workflows/*`, `/health` to the Gateway. The Gateway is configured `mode: "trusted-proxy"` (or `mode: "token"` with a Worker-side service credential). For details and a reference Worker, see [Custom Workflow UIs](https://smithers.sh/guides/custom-workflow-ui#smithers-cloud--plue-same-origin-proxy).

**Local dev.**

```bash
bunx smthrs up my-workflow -d         # boot the gateway with the workflow + UI
bunx smthrs ui                        # opens the UI for the most recent run
bunx smthrs ui <runId>                # specific run
```

**Reference bundles in this repo:** `.smithers/ui/vcs.tsx`, `.smithers/ui/grill-me.tsx`, `.smithers/ui/ultragrill.tsx`, `.smithers/ui/workflow-skill.tsx`.

**Docs:**
- Guide: `smithers.sh/guides/custom-workflow-ui`
- Component catalogs: `smithers.sh/reference/gateway-ui` (run widgets), `smithers.sh/reference/ui` (primitives)
- Examples: `smithers.sh/examples/workflow-ui-react`, `smithers.sh/examples/workflow-ui-vanilla`
- Protocol: `smithers.sh/integrations/gateway`

## Full reference

This skill ships the complete docs next to it as **`llms-full.txt`**. Read it
when you need the exact API: every component, the CLI catalog, the Gateway HTTP
API and browser console, memory, OpenAPI tools, evals, optimization, and the
full event union.

The docs are **progressively disclosed**, so start narrow and widen only as
needed:

- **`https://smithers.sh/llms.txt`**: the compact website index. Along with
  `https://smithers.sh/llms-full.txt`, it is one of the only two llms files
  served on the docs site.
- **`https://smithers.sh/llms-full.txt`**: every topic in one bundle, when you
  want the complete reference in context.
- **Topic fragments**: `llms-core.txt`, `llms-memory.txt`,
  `llms-openapi.txt`, `llms-observability.txt`, `llms-effect.txt`,
  `llms-integrations.txt`, and `llms-events.txt` are generated build artifacts
  under `docs/` in a repository checkout. Read them locally when useful; they
  are not separately resolvable from `smithers.sh`.

```bash
bunx smthrs docs           # prints llms.txt (the concise index)
bunx smthrs docs-full      # prints llms-full.txt
bunx smthrs ask "How do I add a human approval gate?"
```

- Docs: **https://smithers.sh** (`/llms.txt` and `/llms-full.txt` are the
  served llms documents)
- Repo: **https://github.com/smithersai/smithers**
- npm package: `smthrs`

**When in doubt, clone the repo** (`github.com/smithersai/smithers`) and read the
source directly; the docs and `llms-*.txt` bundles can lag the code. The
ground truth lives in `packages/components/src/components/` (every component +
its `*Props.ts`), `apps/cli/src/` (the CLI), and `examples/` (~90 runnable
workflows). Grep there before guessing at an API.
