---
name: context-engineer
description: The concierge proxy — turn a vague user script ("I need the agent to help me do X") into a context contract, route it to the right skills/workflows, add backpressure (tests/evals/reviews/approvals), execute, and report. Use when a request is multi-step, durable, or human-in-the-loop and you'd otherwise hand-roll the orchestration; skip it for a single prompt → single answer.
---

# Context Engineer

`context-engineer` is an archived Smithers **concierge** example: a proxy agent
turning a half-formed request into an executable, durable, observable run.
Not installed by `init`: copy `examples/init-pack/context-engineer.tsx` and
its dependency closure into a project, or ask the seeded `create-workflow`
to build an equivalent.

## The job

The user says *"I need the agent to help me do X."* They needn't know what
"context engineering" is. Convert that script into five things:

1. **a context contract**: goal, non-goals, assumptions, inputs (+ sources),
   constraints, risks, desired artifacts, success criteria;
2. **a route**: the smallest sufficient path (one task, a set of skills, or a
   durable sub-workflow);
3. **a backpressure plan**: every success criterion mapped to a verification
   gate (schema / test / eval / review / approval / trace);
4. **executed artifacts**: work done (or dispatched), looped until gates pass;
5. **a report**: a self-contained HTML slideshow of what happened.

## The layered model

Model an agent as a control system: **prompt** (instructions, examples,
output format) → **context** (info/tools/memory/schema entering each step) →
**harness** (runtime, tools, permissions, retries, fresh-context loops) →
**workflow** (graph, parallelism, review loops, approvals, resumability) →
**backpressure** (every desired behavior gets a gate). The proxy layer is the
differentiator: the user owns only the prompt's intent (business/domain
questions); **Smithers owns the outer four layers** (all agent-engineering
ones): context in the workflow graph + memory, harness in
`agents.ts`/sandboxes/`repoCommands`, workflow in the runtime, backpressure in
the gate matrix, all filled by `context-engineer`.

## The operating loop

This mirrors the workflow's `<Sequence>`: classify → inventory → grill → route →
backpressure → approve → execute → report.

- **Intake & classify** (`classify-script`): read the script, name the modes
  touched (research / planning / implementation / debug / report), and decide
  `durable`: real workflow, or one task?
- **Build a context inventory** (`inventory-context`): scan the repo, available
  tools/commands, `.smithers/skills`, and memory to draft the contract, filling
  gaps with explicit `assumptions` and listing what's `missingInputs`.
- **Grill, only to reduce risk** (`context-engineer:grill`, the `<GrillMe>`
  component): ask **one question at a time** with a **recommended answer +
  reason**, stopping once ambiguity no longer changes the plan. **Never ask
  what's discoverable** from repo/docs/tools/memory: auto-answer yourself.
  Every ambiguity resolves to *assumption | question | deferred decision*.
- **Maintain a visible contract**: the shared artifact, kept current so the
  human can read goal/non-goals/criteria anytime.
- **Backpressure** (`build-backpressure`): turn each success criterion into ≥1
  gate with a `verificationMethod` (`schema` | `unit_test` | `integration_test` |
  `eval` | `review` | `approval` | `trace` | `manual_check`) and a `gateType`
  (`blocking` | `warning` | `informational`). The contract isn't "ready" until
  every blocking criterion names a verification method.
- **Approve** (`approve-contract`): a durable `<Approval>` gate so a human signs
  off on contract, route, and gates before side effects.
- **Execute** (`execute:loop`, a `<Ralph>`): run or dispatch the routed work,
  looping until the gates pass; on repeated failure, revise context or harness,
  not just the prompt.
- **Report** (`report`): emit the HTML slideshow from run state.

## How to run it

```bash
# Launch the concierge on a vague script. --review true (default) inserts the
# approval gate; --review false runs straight through.
bunx smthrs workflow run context-engineer \
  --prompt "I need the agent to help me harden our rate limiting and prove it works"

# Watch it
bunx smthrs ps                       # active / paused / recent runs
bunx smthrs logs <run-id> -f         # follow the event stream
bunx smthrs inspect <run-id>         # full run state (contract, route, gates)
bunx smthrs why <run-id>             # why is it paused?

# Clear the design-approval gate once you've read the contract
bunx smthrs approve <run-id> --node approve-contract --by <name>
bunx smthrs deny <run-id> --node approve-contract   # send it back

# Bail out
bunx smthrs cancel <run-id>
```

The run **pauses durably** at `approve-contract` (a suspended run is a row,
not a process, so it costs nothing while waiting), then proceeds to execute
and report.

**Cheaper / adjacent paths:**

- **`route-task`**: the degenerate concierge for "just run one task": it
  classifies a script, then runs it as a single task or recommends the right
  durable workflow, for work that's clearly one-shot (a single task is a
  first-class outcome, not a routing failure).
- **`create-workflow`** / **`create-skill`**: authoring, not execution. Dispatch
  these when the route is "we need a new durable workflow / a new reusable
  skill" to build it (clarify → provision → design → approve → scaffold →
  verify → document), then run the result.

## When to use vs. skip

- **Single prompt → single answer, or a one-off edit:** skip the concierge
  and answer directly: the overhead buys nothing.
- **Clearly one task:** use **`route-task`** (above).
- **Multi-step, needs ordering / crash-recovery / a human gate / loop-until-true,
  or the user wants work to keep going while away:** use
  **`context-engineer`**, where a contract + route + backpressure + durable
  execution + report pays off.

## Reference

`context-engineer` composes `GrillMe`, prompts at
`.smithers/prompts/context-engineer-*.mdx`, an `<Approval>` gate, and a
`<Ralph>` loop (above). See `skills/smithers/SKILL.md` for the
runtime mental model and full CLI catalog, and `docs/llms-core.txt` for the
exact component/CLI surface.
