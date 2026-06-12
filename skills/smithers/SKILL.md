---
name: smithers
description: Drive Smithers, a durable control plane for long-running coding agents. Use when the user wants multi-step, long-running, crash-safe, or human-in-the-loop agent work: "orchestrate agents", "run a workflow", "implement this and review it", "keep iterating until tests pass", "plan then build", or anything that needs retries, approvals, replay, or evals across multiple AI steps. YOU (the agent) run Smithers on the user's behalf; it is not a GUI the human clicks. You are an ORCHESTRATOR: run long-running, multi-step, or background work *through* Smithers, not through your own ad-hoc subagents; spend your time observing the run and reporting.
---

# Smithers

Smithers is a durable control plane for long-running coding agents. Workflows are
TypeScript (JSX), run for minutes or days, and survive crashes. Every finished
step is persisted to SQLite, so a restart resumes from the last completed node
instead of starting over. Retries, human approvals, replay, evals, and sandbox
review all live in one place.

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
  X") goes into a Smithers run. Smithers spawns the *worker* agents (Claude
  Code, Codex, …) inside the workflow; that is where implementation happens. You
  do not re-implement it yourself or in your own Task subagents.
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

## 60 seconds to the aha

From inside the user's project (Bun ≥ 1.3, plus a model key like
`ANTHROPIC_API_KEY` in the env):

```bash
# 1. Scaffold .smithers/ with ready-made workflows (implement, review, plan, ralph, debug…)
bunx smithers-orchestrator init

# 2. Browse plain-English starters and their copy-paste commands
bunx smithers-orchestrator starters

# 3. Run one. This dispatches a real coding agent to do the work, durably.
bunx smithers-orchestrator workflow run implement --prompt "Add a /health endpoint"

# 4. Watch it
bunx smithers-orchestrator ps                 # active / paused / recent runs
bunx smithers-orchestrator logs <run-id> -f   # follow the event stream
```

That's the loop: scaffold → run a workflow → watch the run. The "aha" is step 3:
you kicked off a multi-step agent job that you can crash, resume, fork, and
inspect, all from the CLI you already live in.

## The mental model

Smithers renders the workflow JSX tree every "frame." Each render answers one
question: *given what has already finished, what can run now?* Tasks produce
outputs validated by Zod schemas; the runtime persists them and renders again.
Crash mid-run and the next render picks up exactly where it left off: completed
nodes are never re-run.

```tsx
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Task } from "smithers-orchestrator";
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
<Ralph until={ctx.latest("review")?.approved} maxIterations={5}>
  <Task id="implement" output={outputs.fix} agent={coder}>Fix based on feedback</Task>
  <Task id="review" output={outputs.review} agent={reviewer}>Review the implementation</Task>
</Ralph>
```

## Reading outputs, and fanning out over worktrees

Two data-access facts the API examples above don't make obvious, and that you
need the moment you fan out:

- `ctx.output(nodeId)` / `ctx.latest(nodeId)` read a single node. But
  `ctx.outputs.<schemaName>` is the **full array of every row written for that
  schema**, across all nodes and all loop iterations. That array is how you wire
  per-item work: give each item an id field in its schema, then filter
  (`ctx.outputs.review.filter(r => r.itemId === id)`) and take the last match to
  get "this item's latest review." Without this you cannot tell which of N
  parallel agents produced which row.
- `ctx.input` fields arrive as their raw value or `null`, **not** their Zod
  default. Always coalesce (`ctx.input?.maxConcurrency ?? 4`).

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
`<Runbook>`, `<DriftDetector>`, `<ContentPipeline>`, `<LoopUntilScored>`,
`<TryCatchFinally>`, `<ContinueAsNew>`) and the catalog grows; check the docs
for the current set. Each is ~20–40 lines of JSX over the substrate, so read,
fork, or copy them. ~90 more ready-to-edit recipes live in `examples/` (listed
below).

## Beyond control flow: the production surface

The same substrate carries the concerns you'd otherwise bolt on later:

- **Isolation**: `<Worktree>` (per-agent git worktrees), `<Sandbox>` (freestyle / docker / process), `<Subflow>` & `<SuperSmithers>` (nest a workflow as a node).
- **Budgets**: `<Aspects>` propagates token / latency / cost budget metadata to a subtree, but runtime enforcement is not implemented yet.
- **Scorers / evals**: attach `faithfulness`, `relevancy`, `schemaAdherence`, or `llmJudge(...)` to any `<Task>`; inspect with `smithers scores <run>`.
- **Memory**: cross-run facts + history per namespace; `memory={{ recall, save }}` auto-injects the top-K relevant facts; query with `smithers memory`.
- **Hot mode**: `--hot true` re-renders against persisted state when you edit the workflow or an `.mdx` prompt mid-run; finished tasks stay put.
- **Time travel**: every render is a frame: `smithers timeline | fork | replay | rewind | diff | timetravel | retry-task`.
- **Observability / serving**: `smithers observability --detach` (Grafana/Prometheus/Tempo/OTLP); `smithers observability --down` stops it; `smithers up … --serve --metrics` exposes an HTTP API, SSE event stream, and `/metrics`. A workflow can even serve its own React front-end.
- **Agents**: pluggable runtimes (claude, codex, antigravity, kimi, amp, forge, Effect-native) configured in `agents.ts`; `agent={[primary, fallback]}` falls back on failure.
- **Tools**: built-in `read`/`write`/`edit`/`bash`/`grep`/`ls` with path containment (`--root`); `smithers openapi <spec>` generates typed AI SDK tools from an OpenAPI spec.
- **Integrations**: run Smithers itself as an MCP server (`smithers mcp add`), sync skills into agent dirs (`smithers skills add`), durable schedules (`smithers cron`), pager-style `smithers alerts`, a structured `<HumanTask>` queue (`smithers human`), and `smithers hijack` to hand off a live agent session.
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
│                        #   accounts with `smithers agent add|list|remove`.
├── smithers.config.ts   # repoCommands { lint, test, coverage } the workflows call
├── workflows/           # WHERE WORKFLOWS GO. One .tsx per workflow (implement,
│                        #   review, plan, ralph, debug, research, …). These are
│                        #   the executable graphs you run with `smithers up` /
│                        #   `smithers workflow run`.
├── prompts/             # WHERE MDX PROMPTS GO. One .mdx per prompt, authored as
│                        #   JSX prompt components. A workflow imports one and
│                        #   renders it as a tag:
│                        #     import PlanPrompt from "../prompts/plan.mdx";
│                        #     <PlanPrompt prompt={ctx.input.prompt} />
├── components/          # WHERE COMPONENTS GO. Reusable workflow .tsx pieces and
│                        #   their Zod output schemas (ValidationLoop, Review,
│                        #   LoopUntilScored, ForEachFeature, …). Imported by
│                        #   workflows like any React-style component.
├── ui/                  # workflow UI sources for the `smithers ui` command
├── specs/  tickets/     # feature specs and tickets some workflows read/write
│
│   # ── runtime state (gitignored; don't author here) ──
├── executions/  runs/   # per-run event logs and persisted frames
├── sandboxes/           # sandboxed review checkouts
├── state/  tmp/  *.db   # SQLite + scratch
└── node_modules/
```

The mental shortcut: **agents** say *who* does the work (`agents.ts`),
**workflows** say *what* happens and in what order (`workflows/*.tsx`),
**prompts** say *what to tell the agent* (`prompts/*.mdx`), and **components**
are the reusable building blocks workflows compose from (`components/*.tsx`). A
typical workflow file imports from all three: `../agents`, `../prompts/foo.mdx`,
and `../components/Bar`.

## Operating runs

Everything is a CLI verb (prefix with `bunx smithers-orchestrator` if it isn't on PATH):

```bash
smithers up workflow.tsx --input '{"description":"Fix bug"}'   # start a run
smithers up workflow.tsx --run-id <id> --resume true          # resume after a crash
smithers ps                                                   # list runs
smithers inspect <run-id>                                     # full run state
smithers logs <run-id> -f                                     # follow events
smithers approve <run-id> --node review                       # clear an approval gate
smithers cancel <run-id>                                      # stop a run
smithers eval workflow.tsx --cases evals/smoke.jsonl --suite smoke
```

When a workflow pauses on a human approval or question, the run is durable: it
waits. Resolve it with `smithers approve` / `smithers deny` / `smithers signal`
and the run continues from there.

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

- **Use it** when order matters across steps, you need crash recovery, a human
  must approve mid-run, different steps need different models/tools, or you need
  to loop until something is true. Also when the user wants the work to keep
  going while they're away.
- **Skip it** for a single prompt → single response, or a quick one-off edit you
  can just do yourself. Smithers adds no value there.

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
- `freestyle/`: Freestyle VM sandbox provider example (real-computer agents)
- `dstack/`: Smithers + dstack on Google Cloud, serving Kimi K2
- `kubernetes/`: run Smithers workflows distributed on a Kubernetes cluster

## Authoring new workflows

You don't have to hand-write a workflow from scratch. The seeded pack ships a
**`create-workflow`** workflow that builds one for you from a plain-English ask:

```bash
bunx smithers-orchestrator workflow run create-workflow \
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

## Custom workflow UIs

A workflow can ship a **first-class browser UI** that the Gateway bundles, serves at `/workflows/<key>`, and the Smithers PWA / Studio / `smithers ui` embeds same-origin. Reach for this when a workflow has long-running interaction the CLI can't show well: a composer for an open-ended chat, a question pool, a live spec, a custom diff view.

Register the UI when you register the workflow:

```ts
gateway.register("my-workflow", workflow, {
  ui: { entry: ".smithers/ui/my-workflow.tsx", title: "My Workflow" },
});
```

The bundle is one file. Two shipping shapes:

- **React (recommended).** `smithers-orchestrator/gateway-react`. One call to `createGatewayReactRoot(<App />)` reads the boot config, mounts a provider, and gives the tree live hooks: `useGatewayRun`, `useGatewayRunEvents`, `useGatewayNodeOutput`, `useGatewayApprovals`, `useGatewayActions` (for `submitApproval`, `submitSignal`, `cancelRun`, `rewindRun`, etc.). The hooks are **stale-data-free by construction**: when `runId` (or any input) changes, the prior data clears synchronously and any late response from the old inputs is dropped. A custom UI that switches between runs never blinks the wrong data. It automatically manages subscriptions, pushed updates, metrics, and resilient reconnections.
- **Vanilla.** `smithers-orchestrator/gateway-client`. One `SmithersGatewayClient` class with `getRun`, `getNodeOutput`, `getNodeDiff`, `submitApproval`, `submitSignal`, `cancelRun`, and a `streamRunEventsResilient` async generator that reconnects with backoff + jitter and resumes from the last per-run `seq`. This generator handles live pushed updates, metrics streaming, and subscriptions. Pick this when you want zero dependencies or already own your render layer.

The bundle reads `?runId=<id>` from `location.search` for the run to scope to, and optionally `__SMITHERS_GATEWAY_UI__` (a `GatewayUiBootConfig`) for the mount path, RPC path, WebSocket path, and free-form `props` you set at `gateway.register({ ui: { props } })`.

**Auth.** The bundle never holds a token in the user-facing path. Same-origin Vite proxy (local dev) or a Cloudflare Worker (Smithers Cloud / Plue) terminates the user session, strips and re-injects trusted-proxy headers (`x-user-id`, `x-user-scopes`, `x-user-role`), and forwards `/v1/rpc/*`, `/workflows/*`, `/health` to the Gateway. The Gateway is configured `mode: "trusted-proxy"` (or `mode: "token"` with a Worker-side service credential). For details and a reference Worker, see [Custom Workflow UIs](https://smithers.sh/guides/custom-workflow-ui#smithers-cloud--plue-same-origin-proxy).

**Local dev.**

```bash
bunx smithers-orchestrator up my-workflow -d         # boot the gateway with the workflow + UI
bunx smithers-orchestrator ui                        # opens the UI for the most recent run
bunx smithers-orchestrator ui <runId>                # specific run
```

**Reference bundles in this repo:** `.smithers/ui/vcs.tsx`, `.smithers/ui/grill-me.tsx`, `.smithers/ui/ultragrill.tsx`, `.smithers/ui/workflow-skill.tsx`.

**Docs:**
- Guide: `smithers.sh/guides/custom-workflow-ui`
- Examples: `smithers.sh/examples/workflow-ui-react`, `smithers.sh/examples/workflow-ui-vanilla`
- Protocol: `smithers.sh/integrations/gateway`

## Full reference

This skill ships the complete docs next to it as **`llms-full.txt`**. Read it
when you need the exact API: every component, the CLI catalog, the Gateway HTTP
API and browser console, memory, OpenAPI tools, evals, optimization, and the
full event union.

The docs are **progressively disclosed**, so you don't have to load the whole
bundle to answer a focused question. Start narrow and widen only as needed:

- **`smithers.sh/llms.txt`**: a tiny index that points to the topic fragments below.
- **Topic fragments** (each a few KB, pull only what's relevant):
  `llms-core.txt` (runtime, JSX surface, CLI, components, recipes, types, errors),
  `llms-memory.txt`, `llms-openapi.txt`, `llms-observability.txt` (HTTP server,
  gateway, MCP, OpenTelemetry), `llms-effect.txt` (Effect-ts authoring API),
  `llms-integrations.txt` (agent runtimes, tools), `llms-events.txt` (the full
  `SmithersEvent` union).
- **`llms-full.txt`**: everything concatenated, when you want it all in context.

```bash
bunx smithers-orchestrator docs           # prints llms.txt (the concise index)
bunx smithers-orchestrator docs-full      # prints llms-full.txt
bunx smithers-orchestrator ask "How do I add a human approval gate?"
```

- Docs: **https://smithers.sh**  ·  fragments at `smithers.sh/llms-*.txt`
- Repo: **https://github.com/smithersai/smithers**
- npm package: `smithers-orchestrator`

**When in doubt, clone the repo** (`github.com/smithersai/smithers`) and read the
source directly; the docs and `llms-*.txt` bundles can lag the code. The
ground truth lives in `packages/components/src/components/` (every component +
its `*Props.ts`), `apps/cli/src/` (the CLI), and `examples/` (~90 runnable
workflows). Grep there before guessing at an API.
