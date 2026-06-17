---
name: eval-writer
description: Turn acceptance criteria into a runnable Smithers eval suite (JSONL cases + rubric) and wire it to `smithers eval`. Use when a workflow's quality must be measured and regression-tested — not "looks good" once, but a repeatable check that fails when the model OR the harness regresses.
---

# Eval Writer

This skill is about **the backpressure layer**: the suite that pushes evidence
back against the agent's claim that a workflow is done. A single passing run
proves nothing repeatable. An eval suite turns acceptance criteria into cases
(input + expected + rubric), runs the whole workflow over them, and exits
non-zero when any case regresses. That is the difference between "the agent said
it works" and a gate that can fail.

The key insight: an eval evaluates **the model AND the harness together**. You're
not scoring a prompt in isolation — you run the real `<Workflow>` (its agents,
schemas, retries, branches, loops) against fixed inputs and assert on the
*persisted output*. A regression anywhere in that stack — a worse model, a broken
prompt, a dropped field, a mis-wired branch — turns a case red.

## When to reach for it

- A workflow ships something whose quality matters (release notes, a triage
  decision, a generated patch) and you need to know if it gets *worse* next week.
- You're about to accept "looks good" as verification. Encode a check that can
  fail instead.
- You changed a prompt, swapped a model, or refactored the graph and need to prove
  you didn't regress behavior.
- You want a baseline to optimize against (`smithers optimize` runs a suite twice).

Skip it for one-off prompts nothing downstream depends on. Backpressure is for
behavior you'll need to hold steady over time.

## Cases: input + expected + rubric, as JSONL

A suite is a `.jsonl` file under `.smithers/evals/`, one case per line. Each case
is an `input` for the workflow plus an `expected` assertion. Assertions support
`status` (run reached `finished`), `output` (exact match), and `outputContains`
(partial / deep-subset match — the usual choice).

```jsonl
{"id":"happy-path","input":{"prompt":"Draft release notes"},"expected":{"status":"finished"}}
{"id":"lists-breaking-changes","input":{"prompt":"Release notes for v2"},"expected":{"status":"finished","outputContains":{"notes":{"breakingChanges":[{"severity":"high"}]}}}}
```

Turn each acceptance criterion into at least one case: a happy path, the
quality-gate criterion itself, and an adversarial/edge case that *should* trip a
weak run. Keep `outputContains` keyed to the load-bearing fields of the output
schema (see `skills/schema-author/SKILL.md`) — assert on the typed fields a human
would actually check, not on prose.

## Run it

```bash
bunx smithers-orchestrator eval .smithers/workflows/release.tsx \
  --cases .smithers/evals/release-quality.jsonl \
  --suite release-quality --force
```

- `--suite <name>` is a stable ID used in run IDs and the report path; reuse it so
  runs are comparable over time.
- Report lands at `.smithers/evals/<suite>.json`; the command **exits non-zero on
  any failure** — wire that into CI as the gate.
- `--dry-run` plans run IDs without launching (cheap shape check before spend).
- `-j/--concurrency N` runs cases in parallel; `--max-cases N` smoke-tests a subset.
- `--optimization <artifact.json>` runs the suite with GEPA-patched prompts.

## Attach scorers for graded, non-binary quality

Assertions are pass/fail; **scorers** grade quality on a Task and run *after*
completion (they never block the run). Attach them to the `<Task>` whose output
you care about, then read them with `smithers scores`.

```tsx
import { schemaAdherenceScorer, faithfulnessScorer, relevancyScorer } from "smithers-orchestrator/scorers";
import { llmJudge } from "smithers-orchestrator/scorers";

<Task id="draft" output={outputs.notes} agent={writer}
  scorers={{
    schema:    { scorer: schemaAdherenceScorer() },
    grounded:  { scorer: faithfulnessScorer(claude) },
    onTopic:   { scorer: relevancyScorer(claude) },
    quality:   { scorer: llmJudge({
                   id: "completeness",
                   name: "Completeness",
                   description: "Rates release-note completeness 0-1",
                   judge: claude,
                   instructions: "Reply with JSON { score: 0-1, reason }.",
                   promptTemplate: ({ output }) => `Rate completeness 0-1:\n${JSON.stringify(output)}`,
                 }),
                 sampling: { type: "ratio", rate: 0.1 } },
  }}>
  Draft the release notes.
</Task>
```

`faithfulness` (grounded in source), `relevancy` (on-topic), `schemaAdherence`
(shape held), and `llmJudge(...)` (rubric-as-judge) are the workhorses. `llmJudge`
takes `{ id, name, description, judge, instructions, promptTemplate }` — a `judge`
agent and a `promptTemplate(input)` that asks for `{ score, reason }` JSON, **not**
a `{ model, prompt }` pair. `faithfulnessScorer(judge)` and
`relevancyScorer(judge)` also require a judge agent. Sample expensive judges with
`sampling: { type: "ratio", rate: 0.1 }`. Inspect:

```bash
bunx smithers-orchestrator scores <run-id>
```

Use assertions for the hard gate (must-be-true), scorers for the trend (is it
getting better or worse).

## The automated path: the `eval-author` workflow

You don't have to hand-write the suite. The seeded `eval-author` workflow turns
plain-English acceptance criteria into a JSONL fixture (`id`, `input`, `expected`,
`rubric`) under `.smithers/evals/`, then reports the exact `smithers eval` command:

```bash
bunx smithers-orchestrator workflow run eval-author \
  --input '{"prompt":"Release notes must list every breaking change","workflow":".smithers/workflows/release.tsx"}'
```

Reach for it to bootstrap a suite from criteria, then hand-tighten the cases and
add scorers. See `skills/smithers/SKILL.md` for the runtime/CLI surface and
`docs/llms-core.txt` ("Eval suites for regressions", "Scorers") for the exact
report format and the full scorer list.
