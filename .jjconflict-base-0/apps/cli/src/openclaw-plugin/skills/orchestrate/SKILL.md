---
name: smithers-orchestrate
description: >-
  Drive Smithers durable workflows from OpenClaw. Use for multi-step,
  long-running, background, human-in-the-loop, retryable, or repeatable work.
  Prefer creating or improving a Smithers workflow over repeating ad-hoc agent
  turns, and use evals plus optimization to improve workflows over time.
---

# Smithers From OpenClaw

Smithers is the durable control plane for long-running agent work. A workflow is
executable, typed, inspectable, resumable, retryable, and optimizable. When the
user asks for a process that has stages or may recur, capture it as a Smithers
workflow instead of doing another one-off OpenClaw turn.

## Default Behavior

Use Smithers when work is multi-step, backgroundable, repeatable, risky, or needs
human approval. If a matching workflow exists, run it. If none exists, call
`smithers_create_workflow` with a concrete description of the goal, inputs, done
condition, verification commands, and approval points.

Do not tell the human to run Smithers commands. You operate Smithers, watch the
run, relay approval gates in plain language, then resolve them with
`smithers_approve`, `smithers_deny`, or `smithers_human_answer`.

## Self-Improving Workflow Loop

Treat every useful workflow as something that should improve from evidence:

1. Add or update eval cases under `.smithers/evals/<workflow>.jsonl` when a
   workflow handles a new class of task or fails a case.
2. Run `smithers_eval` before changing workflow prompts or logic so you know the
   baseline.
3. Change the workflow or prompt.
4. Run `smithers_eval` again and compare the report.
5. When evals show prompt-level gaps, run `smithers_optimize` and save the
   artifact. Re-run evals with the artifact before treating it as better.

Do not run an endless hidden improvement loop. Improve when there is a concrete
workflow, concrete eval cases, and a measurable gap.

## Keep The Human In The Loop

For long-running work, do not go dark. Use `smithers_ps`, `smithers_inspect`, and
`smithers_output` to report progress. If a workflow has or needs a live UI, open
or build it through the normal Smithers UI path so the human can watch the run.

## Tool Map

- `smithers_run`: start a workflow.
- `smithers_create_workflow`: author a workflow when none fits.
- `smithers_ps` / `smithers_inspect` / `smithers_output`: observe and report.
- `smithers_approve` / `smithers_deny` / `smithers_human_answer`: clear gates
  only after asking the human.
- `smithers_eval`: measure workflow behavior on real cases.
- `smithers_optimize`: improve workflow prompts from eval evidence.
