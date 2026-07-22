---
name: eval-writer
description: Turn acceptance criteria into a runnable Smithers eval suite (JSONL cases + rubric) and wire it to `smithers eval`. Use when a workflow's quality must be measured and regression-tested — not "looks good" once, but a repeatable check that fails when the model OR the harness regresses.
---

# Eval Writer

This skill is the backpressure layer: a suite that tests the claim a workflow
is done, since one passing run proves nothing repeatable. It turns acceptance
criteria into cases, runs the whole workflow, and exits non-zero on any
regression: a gate that can fail, not just "the agent said it works."

It evaluates the model and harness together: it runs the real `<Workflow>`
(agents, schemas, retries, branches, loops) against fixed inputs and asserts
on the *persisted output*, never a prompt scored alone. Any regression in
that stack (a worse model, a broken prompt, a dropped field, a mis-wired
branch) reds out a case.

## When to reach for it

- The workflow ships something quality-sensitive (release notes, a triage
  decision, a generated patch) and you need to catch it getting *worse*.
- You're about to accept "looks good" as verification: encode a failing check
  instead.
- You changed a prompt, swapped a model, or refactored the graph and need
  proof of no regression.
- You want a baseline to optimize against (`smithers optimize` runs a suite twice).

Skip it for one-off prompts nothing depends on: backpressure is for behavior
you need steady over time.

## Cases: input + expected + rubric, as JSONL

A suite is a `.jsonl` file under `.smithers/evals/`, one case per line: an
`input` plus an `expected` assertion. Assertions: `status` (run `finished`),
`output` (exact match), `outputContains` (partial/deep-subset match, the
usual choice), `errorContains` (run failed with a matching error substring,
for adversarial cases).

```jsonl
{"id":"happy-path","input":{"prompt":"Draft release notes"},"expected":{"status":"finished"}}
{"id":"lists-breaking-changes","input":{"prompt":"Release notes for v2"},"expected":{"status":"finished","outputContains":{"notes":{"breakingChanges":[{"severity":"high"}]}}}}
```

Turn each acceptance criterion into ≥1 case: a happy path, the quality-gate
criterion itself, and an adversarial/edge case that *should* trip a weak run.
Key `outputContains` to the output schema's load-bearing fields (see
`skills/schema-author/SKILL.md`): assert on typed fields a human would check,
not prose.

## Run it

```bash
bunx smithers-orchestrator eval .smithers/workflows/release.tsx \
  --cases .smithers/evals/release-quality.jsonl \
  --suite release-quality --force
```

- `--suite <name>`: a stable ID for run IDs and the report path; reuse it for
  comparable runs.
- Report lands at `.smithers/evals/<suite>.json`; the command **exits
  non-zero on any failure**, wire it into CI as the gate.
- `--dry-run` plans run IDs without launching (cheap shape check before spend).
- `-j/--concurrency N` runs cases in parallel; `--max-cases N` smoke-tests a subset.
- `--optimization <artifact.json>` runs the suite with GEPA-patched prompts.

## Attach scorers for graded, non-binary quality

Assertions are pass/fail; **scorers** grade quality on a Task, after
completion, without blocking it. Attach to the `<Task>` whose output
matters; read via `smithers scores`.

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
(shape held), and `llmJudge(...)` (rubric-as-judge) are the workhorses.
`llmJudge` takes `{ id, name, description, judge, instructions, promptTemplate }`:
a `judge` agent plus a `promptTemplate(input)` asking for `{ score, reason }`
JSON, **not** `{ model, prompt }`. `faithfulnessScorer` and `relevancyScorer`
also take a judge agent. Sample expensive judges via
`sampling: { type: "ratio", rate: 0.1 }`. Inspect:

```bash
bunx smithers-orchestrator scores <run-id>
```

Use assertions for the hard gate (must-be-true), scorers for the trend
(better or worse).

## The automated path: the `eval-author` workflow

Skip hand-writing the suite: copy the archived `eval-author` workflow from
`examples/init-pack/` with its dependency closure, or ask `create-workflow`
to build an equivalent. Once installed, it turns plain-English acceptance
criteria into a JSONL fixture (`id`, `input`, `expected`, `rubric`) under
`.smithers/evals/` and reports the exact `smithers eval` command:

```bash
bunx smithers-orchestrator workflow run eval-author \
  --input '{"prompt":"Release notes must list every breaking change","workflow":".smithers/workflows/release.tsx"}'
```

Reach for it to bootstrap a suite, then hand-tighten cases and add scorers.
See `skills/smithers/SKILL.md` for the runtime/CLI surface and
`docs/llms-core.txt` ("Eval suites for regressions", "Scorers") for the exact
report format and the full scorer list.
