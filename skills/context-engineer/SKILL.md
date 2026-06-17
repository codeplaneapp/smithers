---
name: context-engineer
description: The concierge proxy — turn a vague user script ("I need the agent to help me do X") into a context contract, route it to the right skills/workflows, add backpressure (tests/evals/reviews/approvals), execute, and report. Use when a request is multi-step, durable, or human-in-the-loop and you'd otherwise hand-roll the orchestration; skip it for a single prompt → single answer.
---

# Context Engineer

`context-engineer` is the flagship Smithers **concierge**: a proxy agent that
takes a user's half-formed request and produces an executable, durable,
observable run. It is a real seeded workflow
(`.smithers/workflows/context-engineer.tsx`), not a planning doc.

## The job

The user says *"I need the agent to help me do X."* They do **not** know — and
never need to know — what "context engineering" is. Your job is to convert that
script into five concrete things:

1. **a context contract** — goal, non-goals, assumptions, inputs (+ where each
   comes from), constraints, risks, desired artifacts, success criteria;
2. **a route** — the smallest sufficient path: one task, a set of skills, or a
   durable sub-workflow;
3. **a backpressure plan** — every success criterion mapped to a verification
   gate (schema / test / eval / review / approval / trace);
4. **executed artifacts** — the work actually carried out (or dispatched), looped
   until the gates pass;
5. **a report** — a legible, self-contained HTML slideshow of what happened.

The differentiator is the proxy layer: the user answers business/domain
questions; you (and Smithers) answer all the agent-engineering ones.

## The layered model

Think of an agent as a control system, not a prompt. **Prompt** (instructions,
examples, output format) → **context** (what info/tools/memory/schema enters each
step) → **harness** (runtime, tools, permissions, retries, fresh-context loops) →
**workflow** (graph, parallelism, review loops, approvals, resumability) →
**backpressure** (every desired behavior gets a gate). The user owns only the
prompt's intent; **Smithers owns the outer four layers** — context lives in the
workflow graph + memory, the harness in `agents.ts`/sandboxes/`repoCommands`, the
workflow in the runtime, and backpressure in the gate matrix. `context-engineer`
is the agent that fills those layers for the user.

## The operating loop

This mirrors the workflow's `<Sequence>` — classify → inventory → grill → route →
backpressure → approve → execute → report.

- **Intake & classify** (`classify-script`): read the script, name the modes it
  touches (research / planning / implementation / debug / report), and decide
  `durable` — does it earn a real workflow, or is it one task?
- **Build a context inventory** (`inventory-context`): scan the repo, available
  tools/commands, `.smithers/skills`, and memory to draft the contract. Fill gaps
  with explicit `assumptions`; list what's truly `missingInputs`.
- **Grill — only to reduce risk** (`context-engineer:grill`, the `<GrillMe>`
  component): ask **one question at a time**, each with a **recommended answer +
  the reason**, and stop the moment the remaining ambiguity no longer changes the
  plan. **Never ask what's discoverable** from repo/docs/tools/memory — auto-answer
  those yourself. Every ambiguity resolves to *assumption | question | deferred
  decision*.
- **Maintain a visible contract**: the contract is the shared artifact. Keep it
  current so the human can read goal/non-goals/criteria at any point.
- **Backpressure** (`build-backpressure`): turn each success criterion into ≥1
  gate with a `verificationMethod` (`schema` | `unit_test` | `integration_test` |
  `eval` | `review` | `approval` | `trace` | `manual_check`) and a `gateType`
  (`blocking` | `warning` | `informational`). The contract is not "ready" until
  every blocking criterion names a verification method.
- **Approve** (`approve-contract`): a durable `<Approval>` gate so a human signs
  off on contract + route + gates before any side effects.
- **Execute** (`execute:loop`, a `<Ralph>`): run or dispatch the routed work,
  looping until the gates pass; on repeated failure, revise context/harness, not
  just the prompt.
- **Report** (`report`): emit the HTML slideshow from run state.

## How to run it

```bash
# Launch the concierge on a vague script. --review true (default) inserts the
# approval gate; --review false runs straight through.
bunx smithers-orchestrator workflow run context-engineer \
  --prompt "I need the agent to help me harden our rate limiting and prove it works"

# Watch it
bunx smithers-orchestrator ps                       # active / paused / recent runs
bunx smithers-orchestrator logs <run-id> -f         # follow the event stream
bunx smithers-orchestrator inspect <run-id>         # full run state (contract, route, gates)
bunx smithers-orchestrator why <run-id>             # why is it paused?

# Clear the design-approval gate once you've read the contract
bunx smithers-orchestrator approve <run-id> --node approve-contract --by <name>
bunx smithers-orchestrator deny <run-id> --node approve-contract   # send it back

# Bail out
bunx smithers-orchestrator cancel <run-id>
```

The run **pauses durably** at `approve-contract` — a suspended run is a row, not a
process, so it costs nothing while it waits for you. After approval it proceeds to
execute and report.

**Cheaper / adjacent paths:**

- **`route-task`** — the degenerate concierge for "just run one task." It
  classifies a script and either runs it as a single task or recommends the right
  durable workflow. Reach for it when the work is clearly one-shot; a single task
  is a first-class outcome, not a routing failure.
- **`create-workflow`** / **`create-skill`** — authoring, not execution. When the
  route is "we need a new durable workflow / a new reusable skill," dispatch these
  to build it (clarify → provision → design → approve → scaffold → verify →
  document), then run the result.

## When to use vs. skip

- **Single prompt → single answer, or a one-off edit you can just do:** skip the
  concierge and answer directly. The overhead buys nothing.
- **Clearly one task, just find the right home for it:** use **`route-task`**.
- **Multi-step, needs ordering / crash-recovery / a human gate / loop-until-true,
  or the user wants work to keep going while they're away:** use
  **`context-engineer`**. That's exactly the case where a contract + route +
  backpressure + durable execution + report pays off.

## Reference

`context-engineer` composes `GrillMe`, the inventory/route/backpressure prompts in
`.smithers/prompts/context-engineer-*.mdx`, an `<Approval>` gate, and a `<Ralph>`
execute loop. Read `skills/smithers/SKILL.md` for the runtime mental model and the
full CLI catalog, and `docs/llms-core.txt` for the exact component/CLI surface.
