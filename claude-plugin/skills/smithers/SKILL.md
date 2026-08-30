---
name: smithers
description: >
  Drive Smithers, a durable control plane for long-running coding agents, from
  Claude Code. Use for multi-step, long-running, crash-safe, or
  human-in-the-loop work ("orchestrate agents", "run a flow", "implement this
  and review it", "keep iterating until tests pass"). YOU run Smithers on the
  user's behalf. HARD RULE 0, if SMITHERS_INSIDE_RUN is set you are already a
  worker inside a Smithers step, so never launch or steer a run; do the step's
  task with your ordinary tools. HARD RULE 1, right-size the route first:
  handle any clear single-goal ask directly however large, and reserve a flow
  for ordered stages, durability, approvals, loops, or reuse. HARD RULE 2, run
  long-running work through a durable flow, not Task/Agent subagents or /loop;
  the native Workflow tool has one sanctioned use, launching the plugin's
  smithers-run.mjs mirror so the run shows live in /workflows. HARD RULE 3, a
  flow is built from Flow.make, Action.make, and Effect; there is no JSX API,
  and read https://smithers.sh/llms-full.txt first.
---

# Smithers (from Claude Code)

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
routing rule below. Do the step's task directly with your ordinary tools (Read,
Edit, Bash) and finish your turn.

- Never launch or steer a run from inside a step: no `smithers up`, no
  `smithers plan`, no `/workflows` mirror, no status-poll-and-sleep loop, and
  none of the Smithers MCP tools that start or watch runs.
- The prompt you were handed IS the work. It is never a request to orchestrate,
  even when it reads like one ("review this diff", "implement this feature").
- If you are blocked, say so and stop. There is no escalate-upward verb in 1.0:
  a step that needs a person is declared by the flow as a `HumanTask`.

## Right-size the route first

1. **Ambiguous goal or acceptance criteria.** Ask the user. Do not build.
2. **One clear goal, however large.** Do it directly with your ordinary tools. A
   repo-wide rename is a single goal. Neither task size nor a worry about your
   context window justifies a flow.
3. **Ordered stages with real gates, durability across a crash, human approval,
   a bounded loop, or something worth reusing.** That is a flow.
4. **Already a flow in `flows/`.** Run it. Do not write a new one.

## Use Smithers, not Claude Code's own orchestration

Long-running, multi-step, or background work goes through a Smithers flow, not
through Task or Agent fan-outs, `/loop`, or a hand-written Workflow script.
Smithers records each step, resumes after a crash, retries on failure, and parks
on approvals. Native subagents lose all of that when the turn ends.

Native tools stay right for a short, single-shot lookup that finishes inside this
turn: a quick search, reading a few files. Anything durable, multi-step, or
backgroundable belongs in a flow.

## The /workflows mirror

Every Smithers run you start from Claude Code gets a live `/workflows` mirror
with no per-flow setup.

1. **Launch and mirror in one step.** Invoke the native Workflow tool with the
   plugin's mirror script. The SessionStart context gives you its path; the
   fallback glob is `~/.claude/plugins/**/smithers*/workflows/smithers-run.mjs`.

   ```
   Workflow({
     scriptPath: "<plugin>/workflows/smithers-run.mjs",
     args: { flow: "<flow-id>", data: { ... } }
   })
   ```

   The script launches the detached run with `smithers up <flow> -d`, logs the
   run id, then mirrors it: phases, one row per node, outputs on completion, and
   approval banners.

2. **Attach to an existing run** with `args: { runId: "<run-id>" }`: after a
   session restart, when the user asks about a run you did not start, or when
   the SessionStart context reports non-terminal runs. Pass `cwd` when the run's
   workspace is not this session's directory, because run state lives in that
   workspace's `.flows/`.

3. **The mirror is a view, not the run.** Stopping it never stops the run;
   re-attach any time. To stop a run, use `smithers cancel <run-id>`.

4. **It scales itself.** Fan-outs and loop rounds appear as they materialize,
   and very large runs collapse to per-phase summaries.

5. **React to what it surfaces.** Relay a pending approval to the human, collect
   the decision in chat, and resolve it yourself. On a failure, run
   `smithers status <run-id>` and report what it says.

The mirror speaks the versioned `smithers claude tick` and `smithers claude
node-wait` protocol, `claudeMirrorContract` 2. On a contract mismatch, update
both the plugin and `@smthrs/cli`, then re-attach.

## You drive it, the human does not

The human asks for an outcome ("implement rate limiting, do not stop until the
tests pass"). You plan the flow, approve it, run it, watch it, clear its gates,
and report back. Smithers spawns the worker agents inside the run, and that is
where the implementation happens.

Run every Smithers command yourself. Never tell the human to run one. When a run
parks on an approval, relay it in plain language, collect the decision in chat,
and call `resolve_approval` or `smithers approve` yourself.

### Do it, do not describe it

The most common failure is narrating instead of acting. When asked to create or
run or fix a flow, use your tools now: write `flows/<name>/flow.ts`, run the
`smithers` CLI or the MCP tools. Do not paste the flow as a code block and stop.
The files on disk are the answer.

## After every command, guide the user

1. **State the result, the run id, and the single next action.** Do not paste
   raw JSON at a person.
2. **Ask before you build.** Ask a few clarifying questions (goal, inputs, the
   "done" condition, where a human should approve), then write the flow, plan it
   so the user can see the plan card, and run it together.
3. **Offer the live view every time.** The `/workflows` mirror is the default.
   `smithers logs <run-id> --follow` is the terminal equivalent, and
   `smithers serve` hosts the control server for a browser client.

## The core loop

1. `list_workflows` or `smithers ls`: see what the project offers.
2. Author or pick a flow at `flows/<name>/`. Fetch
   https://smithers.sh/llms-full.txt first and write against it.
3. `smithers plan <flow> --data '{...}'`: compile the plan and show the plan
   card. Nothing has run yet.
4. **Launch through the mirror**: the Workflow tool plus `smithers-run.mjs` with
   `args: { flow, data }`. The run starts detached and appears live in
   `/workflows`.
5. Watch the mirror, clear gates the moment it surfaces them, feed failures back
   in with `smithers status <run-id>`, and report evidence from the mirror's
   return value.

A park on an approval is waiting, not failure. The CLI exits `3` on a park, and
that is expected.

## Authoring reference (hard rule)

Fetch https://smithers.sh/llms-full.txt before creating or editing any flow, and
write against it rather than from memory. It is the complete current contract
for `Flow`, `Action`, `AgentAction`, nodes, patterns, durable waits, approvals,
and outputs. Offline, `smithers docs --full` prints the same bundle.

Three narrower skills go deeper where it matters: `schema-author` for the output
schema, `prompt-author` for the prompt, and `risk-reviewer` for gating side
effects.

## Migrating a 0.x project

If the project still depends on `smthrs` or `smithers-orchestrator`, has a
`.smithers/workflows/` pack, or sets `jsxImportSource` to `smthrs`, it is a
Smithers 0.x project. Do not hand-translate it. Run `smithers migrate` and read
the `migrate-smithers-v1` skill.
