---
name: smithers
description: >
  Drive Smithers, a durable control plane for long-running coding agents. Use
  for multi-step, long-running, crash-safe, or human-in-the-loop agent work:
  "orchestrate agents", "run a flow", "implement this and review it", "keep
  iterating until tests pass", "plan then build", or anything needing retries,
  approvals, or durable waits across several model steps. YOU run Smithers on
  the user's behalf; it is not a GUI a person clicks. HARD RULE 0, if
  SMITHERS_INSIDE_RUN is set you are already a worker inside a Smithers step,
  so never launch or steer a run; do the step's task with your ordinary tools.
  HARD RULE 1, right-size the route first: handle any clear single-goal ask
  directly however large, and reserve a flow for work that needs ordered
  stages, durability, approvals, loops, or reuse. HARD RULE 2, a flow is
  TypeScript or Markdown built from Flow.make, Action.make, and Effect; there
  is no JSX authoring API, no Task element, and no 0.x source compatibility.
---

# Smithers

Smithers is a durable control plane for long-running coding agents. A flow is
ordinary TypeScript built from `Flow.make`, `Action.make`, and Effect. It runs
for minutes or days and survives crashes: every completed action is recorded, so
a restart replays the record and resumes at the frontier instead of starting
over. Retries, approvals, durable waits, cancellation, and a control plane live
in one place.

> Smithers 1.0 is a clean break from 0.x. There is no JSX workflow API, no
> `<Task>`, no `createSmithers`, no `.smithers/` pack, and no source
> compatibility with 0.x. To upgrade an existing 0.x project, run
> `smithers migrate` and read `skills/migrate-smithers-v1/SKILL.md`.

## Rule 0: if you are already inside a run, do not use Smithers

**Check this before anything else.** If `SMITHERS_INSIDE_RUN` is set in your
environment you ARE a worker executing one step of a Smithers run. Smithers sets
that variable on every agent it spawns. This rule overrides every routing rule
below.

Do the step's task directly with your ordinary tools (read, edit, shell) and
finish your turn.

- Never launch or steer a run from inside a step: no `smithers up`, no
  `smithers plan`, no status-poll-and-sleep loop, and none of the MCP tools that
  start or watch runs.
- The prompt you were handed IS the work. It is never a request to orchestrate,
  even when it reads like one ("review this diff", "implement this feature").
- If you are blocked, say so and stop. There is no escalate-upward CLI verb in
  1.0: a step that needs a person is declared by the flow as a `HumanTask`, not
  improvised from inside an agent.

Everything below applies only when `SMITHERS_INSIDE_RUN` is unset.

## Route first: not every ask needs a flow

Before reaching for any machinery, route the ask:

1. **Ambiguous goal or acceptance criteria.** Ask the user. Do not build.
2. **One clear goal, however large.** Do it directly with your ordinary tools.
   A repo-wide rename is a single goal. Neither task size nor a worry about your
   context window justifies a flow.
3. **Ordered stages with real gates between them, durability across a crash,
   human approval, a bounded loop, or something worth reusing.** That is a flow.
4. **Already a flow in `flows/`.** Run it. Do not write a new one.

A flow you author for a single-goal task costs more than it saves: you pay for
the schemas, the plan, and the approval, and you get back a slower version of
what you would have typed.

## The mental model

Five words carry the whole design.

**Flow.** A named durable unit with typed `payload`, `success`, and `error`
schemas. `Flow.make("app/Review", { ... })` declares one; its `body` builds a
graph, and `toLayer` registers a handler.

**Action.** A named side effect with a tier, an idempotency identity, and a
result the engine records. Actions are the only place effects belong.
`Action.make({ name, success, error, tier, idempotencyKey, execute })`.

**Node.** The plan-time graph. `Action.call` records a node; it does not run
anything. `Node.andThen`, `Node.map`, `Node.branch`, and `Node.all` compose
nodes into topology the plan carries, so both arms of a branch exist in the plan
and the predicate runs later against the real value.

**Plan.** The compiled graph with every step key computed, inert until run. The
control plane hands you a plan card and an approval payload before anything
executes, so a person can see what a run will do before it does it.

**Step key.** The identity that makes replay work. It is compiled from what an
action declares: its body, its tagged input references, its layers, and its
capabilities. Same key means the recorded result is reused; a changed key means
the step runs again.

Two consequences follow, and they explain most surprises:

- **The body re-runs from the beginning after every wake.** Completed actions
  and durable waits return their recorded results, so everything before the
  frontier must be deterministic and safe to evaluate again. Read the clock, the
  filesystem, and the network inside actions, never in the body around them.
- **Schemas and tags are persistence contracts.** Renaming a flow tag or
  changing an encoded schema re-keys the work. Treat it like a database
  migration.

## Sixty seconds to the aha

```sh
# 1. Scaffold a flow directory and add .flows/ to .gitignore.
smithers init hello

# 2. See what the project offers. Project flows live in flows/<name>/.
smithers ls

# 3. Compile a plan and print its approval payload. Nothing runs yet.
smithers plan hello --data '{"name":"world"}'

# 4. Approve the payload, then run it.
smithers approve '<payload>' --scope run
smithers run '<payload>'

# 5. Or do all three at once, and follow it.
smithers up hello --data '{"name":"world"}' --json
smithers logs <run-id> --follow
```

`smithers up` is the one-shot: plan, approve with scope `run`, run. Add `-d` to
detach; it prints the run id after the admission line and logs to
`.flows/logs/<run-id>.log`. You never choose a run id; read `runId` from the
receipt.

## The flow directory

A project's flows live under `flows/`, one directory per flow, named by path:

```
flows/
  hello/
    flow.ts             # a TypeScript flow. Discovered as "hello".
  review/
    flow.mdx            # a Markdown flow. Its body is the prompt.
    read-pr/
      flow.ts           # discovered as "review/read-pr".
.flows/                 # run state: control.db, engine.db, logs. Gitignored.
```

Discovery is metadata only. It parses frontmatter and module metadata without
importing a module or reading a prompt body, so a catalog of a thousand flows
costs a thousand frontmatter parses. A body loads when the flow is invoked.
Precedence within a directory is `flow.ts`, then `flow.mdx`, then `SKILL.md`.

That has one consequence for you as an author: an entry file must state its
metadata literally, where a parser can read it without running anything. A
Markdown flow states it in frontmatter, and its body is the prompt:

```mdx
---
name: review
description: Reviews a change for correctness, regressions, and maintainability.
capabilities: ["fs:read:**"]
---

Review the supplied change and report concrete, actionable findings.
```

A module flow states the same things in the literal it exports by default: a
`description`, its `input` and `output` schemas, the `capabilities` it needs,
and its declared `effects`. A description built at runtime, or hidden behind a
helper, is not discoverable, and `smithers doctor` reports it as a warning
rather than silently dropping the flow.

## Writing a flow

```ts
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

const Research = AgentAction.make("hello/Research", {
  payload: { topic: Schema.String },
  output: Schema.Struct({
    summary: Schema.String,
    keyPoints: Schema.Array(Schema.String)
  }),
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You are a research assistant. Be concise and accurate."],
  prompt: ({ topic }) => `Research "${topic}" and report what matters about it.`
})

const Write = AgentAction.make("hello/Write", {
  payload: { keyPoints: Schema.Array(Schema.String), summary: Schema.String },
  output: Schema.Struct({ article: Schema.String, wordCount: Schema.Number }),
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You are a technical writer."],
  prompt: ({ keyPoints, summary }) =>
    `Write a short article.\n\nSummary: ${summary}\n\nKey points:\n${keyPoints.map((p) => `- ${p}`).join("\n")}`
})

export const Article = Flow.make("hello/Article", {
  payload: { topic: Schema.String },
  success: Schema.Struct({ article: Schema.String, wordCount: Schema.Number }),
  error: AgentAction.AgentFailure,
  body: ({ topic }) =>
    Research.call({ topic }).pipe(
      Node.andThen((research) => Write.call({ keyPoints: research.keyPoints, summary: research.summary }))
    )
})
```

A model call is an ordinary action. `AgentAction.make` declares the seat, the
system teaching, the prompt built from the payload, and an `output` schema the
runtime enforces: it renders the schema into the system teaching as JSON Schema,
decodes the final answer with it, and spends one bounded correction re-prompt
before failing `StructuredOutputFailure`. An author never writes `toLayer` for a
model call; its implementation ships with the declaration as `.layer`.

Related skills: `schema-author` for designing the output schema,
`prompt-author` for the prompt itself, `risk-reviewer` for gating side effects.

## Durability, retries, and waits

- **Retry deliberately.** `Action.retry(action, { times: 2 })`. Give an
  `irreversible` action an idempotency key before you allow any retry, because a
  retry re-runs it and nothing rolls it back.
- **Wait durably.** `DurableClock.sleep` records a wake time. `DurableDeferred`
  suspends until another process completes its token. `DurableQueue.process`
  offers persisted work and awaits its result. All three survive the process
  that started them.
- **Ask a person.** `HumanTask.action.call({ name, kind, prompt })` with kind
  `ask`, `confirm`, `select`, or `json`. The run parks; a later process replays
  the recorded answer.
- **Compose known shapes.** `@smthrs/patterns` ships `Loop`, `ReviewLoop`,
  `MapReduce`, `Escalation`, `Saga`, `WithApproval`, `WithRetry`, `WithCache`,
  `TryCatchFinally`, and more. Reach for one before hand-rolling topology.

## The command surface

Global flags: `--json`, `--quiet`, `--remote <url>`, `--credential <token>`,
`--mcp-config <path>`. Exit codes: `0` success, `1` unsupported or error, `2`
usage, `3` parked on an approval, `130` interrupted, `143` terminated.

| Command | What it does |
| --- | --- |
| `plan <flow> [k=v...] [--data <json>]` | Compiles the plan, prints the plan card and the approval payload. |
| `approve <payload> [--scope once\|run\|remembered]` | Approves a plan or a node-level `ask`. The principal is stamped server-side. |
| `deny <payload>` | Denies. A denied plan can never launch. |
| `run <payload>` | Runs an approved plan; blocks until it settles when this process owns the executor. |
| `run --resume <run-id>`, `resume <run-id>` | Joins or claims a parked run. |
| `up <flow> [--data <json>] [--root <dir>] [-d] [--json]` | Plan, approve with scope `run`, run. `-d` detaches. |
| `ls` | Project flows discovered under `flows/`. `workflow list` is an alias. |
| `ps [--flow <id>] [--status <status>]` | Run listing. Status is one of `accepted`, `running`, `parked`, `waiting-approval`, `cancelled`, `completed`, `failed`. |
| `status [run-id]` | Diagnosis card for one run, or the listing. `inspect` and `why` are aliases. |
| `logs [run-id] [--follow] [--json]` | Transcript, or the raw event stream. `events` is an alias of `logs --json`. |
| `output <run-id> <node-id>` | The registered output of one node. |
| `cancel <run-id>` | Durable, cross-process cancellation. |
| `signal <run-id> <json>` | Delivers a named signal to a flow parked on a wait. |
| `steer <run-id> --message <text>` | Durable, attributed steer, drained at the agent's next turn close. |
| `down` | Cancels every non-terminal run. |
| `serve [--host] [--port] [--listen] [--credential]` | Hosts the control server. Loopback by default; a non-loopback bind needs `--listen` and a token. `gateway` is an alias. |
| `init [name]` | Scaffolds `flows/<name>/flow.mdx` and adds `.flows/` to `.gitignore`. |
| `doctor` | Discovery warnings, database paths, Node version, provider keys, and any 0.x state found. |
| `docs [--full]` | Prints the bundled `llms.txt` or `llms-full.txt`. |
| `migrate [path]` | Runs the 0.x to 1.0 migration flow. Refuses while live 0.x runs exist. |
| `gc [--older-than <duration>] [--dry-run]` | Deletes terminal runs older than the threshold and compacts the journal. |
| `memory list\|get\|set\|rm` | Namespaced facts in the control database. |
| `skills add\|list` | Writes this skill into detected agent directories. |
| `mcp add --agent <id>`, `smithers --mcp` | The MCP server over stdio. |
| `claude tick\|node-wait\|monitor\|subscribe\|unsubscribe` | The Claude Code plugin mirror protocol. |
| `update`, `bug`, `completions`, `--version`, `--help` | Version check, bug report, shell completion, help. |

### Removed in 1.0

These are gone. Each exits `1` with a migration message; do not look for a
workaround.

`replay`, `rewind`, `fork`, `timetravel`, `snapshots`, `restore`, `revert`,
`retry-task`, `tree`, `graph`, `timeline`, `diff`, `worktrees` (time travel is a
library API, `@smthrs/time-travel`, and worktree lanes are deferred);
`hijack`, `pause` (use `steer`, `signal`, `approve`, `deny`, `cancel`,
`run --resume`); `ui`, `gui`, `monitor`, `gateway status|stop` (use
`smithers serve`); `supervise`, `top`; `eval`, `optimize`, `scores`; `chat`,
`ask`, `what`; `agents`, `usage`, `openapi`, `token`, `cron`, `alerts`,
`listeners`, `observability` (moved to the plugins repository or deferred);
`make-workflow`, `starters`, `share`, `packs`, `add`, `remove`, `eject`,
`upgrade`, `workflow run|create|inspect` (`smithers migrate` replaces
`upgrade`); `human list|resolve`, `ask-human`; `node`, `tail`; `docs-full`
(now `docs --full`).

The `--backend pglite|postgres` flag is removed: rc.0 is SQLite only.
`--backend sqlite` is accepted and does nothing.

## MCP tools

The server exposes 21 tool names. Eleven work: `list_workflows`,
`run_workflow`, `list_runs`, `get_run`, `watch_run`, `get_run_events`,
`explain_run`, `list_pending_approvals`, `resolve_approval`, `get_node_detail`,
`get_chat_transcript`. Ten keep their names and return
`{ ok: false, error: { code: "unsupported" } }`: `revert_attempt`, `fork_run`,
`replay_run`, `rewind_run`, `restore_checkpoint`, `list_snapshots`,
`get_timeline`, `time_travel`, `list_artifacts`, `ask_human`.

## Operating a run

```sh
smithers ps --status waiting-approval    # parked on a decision
smithers status <run-id>                 # what happened, and why it stopped
smithers logs <run-id> --json            # the raw event stream
smithers output <run-id> <node-id>       # one node's recorded output
smithers cancel <run-id>                 # stop it durably
smithers up <flow> --json                # start another, detached with -d
```

Read state before you act on it. A parked run is a row, not a held process, so
`ps` and `status` are cheap and always current. When a run fails, `status` gives
the diagnosis card computed from the run's own events; reach for `logs --json`
only when you need the raw stream.

## After every command, tell the user what happened

State the result, the run id, and the single next action. Do not paste raw JSON
at a person. When a run parks on an approval, say what is being approved and
what happens on each answer before you ask.

## Do it, do not describe it

If the user asked for the work, run it. Do not print the commands you would run
and stop. The exception is an irreversible or outward-facing action: gate that
behind a decision, as `skills/risk-reviewer/SKILL.md` describes.

## Repair-loop discipline

When a run fails, read `status` first and fix the cause. Do not re-run the same
flow with the same input hoping for a different answer, and do not widen a
schema to make a decode error go away. A decode error usually means the prompt
and the schema disagree; a step key that changed unexpectedly usually means an
identity string moved. Both have one correct fix and many wrong ones.

## Full reference

`llms-full.txt` sits next to this file. It is the complete docs bundle,
generated from the documentation site. Read it before writing flow code, and
prefer it to guessing at an API. Offline, `smithers docs --full` prints the same
bundle.
