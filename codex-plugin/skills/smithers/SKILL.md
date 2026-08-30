---
name: smithers
description: >-
  Drive Smithers, a durable control plane for long-running coding agents, from
  Codex. Use for multi-step, long-running, crash-safe, or human-in-the-loop
  work ("orchestrate agents", "run a flow", "implement this and review it",
  "keep iterating until tests pass", "plan then build"). YOU run Smithers on
  the user's behalf; it is not a GUI the human clicks. HARD RULE 0, if
  SMITHERS_INSIDE_RUN is set you are already a worker inside a Smithers step,
  so never launch or steer a run; do the step's task with your ordinary tools.
  HARD RULE 1, right-size the route first: handle a clear single-goal task
  directly, and reserve a flow for work that needs ordered stages, durability,
  approvals, loops, or reuse. HARD RULE 2, a flow is TypeScript or Markdown
  built from Flow.make, Action.make, and Effect; there is no JSX API and no
  .smithers pack, and you must read https://smithers.sh/llms-full.txt before
  writing flow code.
---

# Smithers (from Codex)

Smithers is a durable control plane for long-running coding agents. A flow is
ordinary TypeScript built from `Flow.make`, `Action.make`, and Effect. It runs
for minutes or days and survives crashes: every completed action is recorded, so
a restart replays the record and resumes at the frontier. Retries, approvals,
durable waits, and cancellation live in one place.

Smithers 1.0 is a clean break from 0.x. There is no JSX authoring API, no `<Task>`, no `createSmithers`, and no `.smithers/` pack.
Project flows live in `flows/<name>/`, and run state lives in `.flows/`.

## Rule 0: if you are already inside a Smithers run, do not use Smithers

**Check this before anything else.** If `SMITHERS_INSIDE_RUN` is set in your
environment, you ARE a worker agent executing one step of a Smithers run.
Smithers sets that variable on every agent it spawns. This rule overrides every
routing rule below. Do the step's task directly with your ordinary tools (read,
edit, shell) and finish your turn.

- Never launch or steer a run from inside a step: no `smithers up`, no
  `smithers plan`, no status-poll-and-sleep loop, and none of the Smithers MCP
  tools that start or watch runs.
- The prompt you were handed IS the work. It is never a request to orchestrate,
  even when it reads like one ("review this diff", "implement this feature").
- If you are blocked, say so and stop. There is no escalate-upward verb in 1.0:
  a step that needs a person is declared by the flow as a `HumanTask`.

## Right-size the route first

1. **Ambiguous goal or acceptance criteria.** Ask the user. Do not build.
2. **One clear goal, however large.** Do it directly with your ordinary tools.
3. **Ordered stages with real gates, durability across a crash, human approval,
   a bounded loop, or something worth reusing.** That is a flow.
4. **Already a flow in `flows/`.** Run it. Do not write a new one.

Native subagent fan-outs lose every step when the turn ends. A flow does not.

## The mental model

**Flow.** A named durable unit with typed `payload`, `success`, and `error`
schemas.

**Action.** A named side effect with a tier (`sealed`, `compensable`,
`irreversible`), an idempotency identity, and a result the engine records.
Actions are the only place effects belong.

**Node.** The plan-time graph. `Action.call` records a node; it runs nothing.
`Node.andThen`, `Node.map`, `Node.branch`, and `Node.all` compose topology the
plan carries, so both arms of a branch exist before either runs.

**Plan.** The compiled graph with every step key computed, inert until run. You
see it, and a person approves it, before anything executes.

**Step key.** The identity that makes replay work. Same key means the recorded
result is reused. A changed key means the step runs again.

The body re-runs from the beginning after every wake, and completed actions
return recorded results, so everything before the frontier must be deterministic.
Read the clock, the filesystem, and the network inside actions, never around
them.

## The core loop

```sh
smithers ls                                   # what this project offers
smithers plan <flow> --data '{...}'           # compile the plan; nothing runs
smithers approve '<payload>' --scope run      # approve exactly what you saw
smithers run '<payload>'                      # run it
smithers up <flow> --data '{...}' --json      # all three at once, -d to detach
smithers ps                                   # runs and their status
smithers status <run-id>                      # the diagnosis card
smithers logs <run-id> --follow               # the live transcript
smithers output <run-id> <node-id>            # one node's recorded output
smithers cancel <run-id>                      # stop it durably
```

A park on an approval is waiting, not failure. The CLI exits `3` on a park.

## MCP tools

Eleven tools work: `list_workflows`, `run_workflow`, `list_runs`, `get_run`,
`watch_run`, `get_run_events`, `explain_run`, `list_pending_approvals`,
`resolve_approval`, `get_node_detail`, `get_chat_transcript`. Ten more keep
their names and answer `{ ok: false, error: { code: "unsupported" } }`:
`revert_attempt`, `fork_run`, `replay_run`, `rewind_run`,
`restore_checkpoint`, `list_snapshots`, `get_timeline`, `time_travel`,
`list_artifacts`, `ask_human`.

## You drive it, the human does not

The human asks for an outcome. You plan the flow, approve it, run it, watch it,
clear its gates, and report back. Run every Smithers command yourself; never
tell the human to run one. When a run parks on an approval, relay it in plain
language, collect the decision in chat, and resolve it yourself.

### Do it, do not describe it

When asked to create or run or fix a flow, use your tools now: write
`flows/<name>/flow.ts` and run the `smithers` CLI or the MCP tools. Do not paste
the flow as a code block and stop. The files on disk are the answer.

## Authoring reference (hard rule)

Read https://smithers.sh/llms-full.txt before creating or editing any flow, and
write against it rather than from memory. Offline, `smithers docs --full` prints
the same bundle.

Three narrower skills go deeper: `schema-author` for the output schema,
`prompt-author` for the prompt, and `risk-reviewer` for gating side effects.

## Migrating a 0.x project

If the project still depends on `smthrs` or `smithers-orchestrator`, has a
`.smithers/workflows/` pack, or sets `jsxImportSource` to `smthrs`, it is a
Smithers 0.x project. Do not hand-translate it. Run `smithers migrate` and read
the `migrate-smithers-v1` skill.
