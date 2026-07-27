---
name: eval-driven-development
description: How this repo does eval-driven development (EDD) for Smithers workflows — write the failing suite first, build until green, validate on a holdout, then optimize. Use when adding evals to a workflow, changing a prompt/model/graph that has a suite, setting up a dev/holdout split, or wiring eval gates into CI. For suite-authoring mechanics see skills/eval-writer/SKILL.md; this skill is the loop and the discipline.
---

# Eval-Driven Development

One passing run proves nothing. EDD is the loop that makes a workflow's
quality *repeatable*: encode acceptance criteria as a failing eval suite
before building, go green, and never tune against the holdout. A change to a
prompt, model, schema, or graph edge is "done" when the suite says so, not
when a run looks good.

## The loop

1. **Red first.** Before building or changing the workflow, write cases from
   the acceptance criteria and run the suite. It must fail (or lack coverage)
   — that failure is the spec. If it passes already, your cases are too weak:
   add the adversarial one that trips a weak run.
2. **Build until green.** Change the prompt, schema, agent, or graph. Re-run
   the dev suite. Iterate against the report, not against vibes.
3. **Validate on the holdout.** Once dev is green, run the `*-holdout` suite.
   Holdout cases are never used to tune prompts, pick models, or accept an
   optimization — they exist to catch overfitting to the dev split.
4. **Optimize (optional).** `smithers optimize` runs the dev suite twice
   (baseline + GEPA-patched) and writes an artifact. Accept it only if the
   holdout suite, run with `--optimization <artifact.json>`, does not
   regress.
5. **Gate in CI.** The `eval` command exits `0` when all cases pass, `1` on
   any failure, `4` for an invalid case file. Wire the non-zero exit into CI;
   a suite nobody runs is documentation.

## Repo conventions

Suites live in `.smithers/evals/` as JSONL, one case per line:

- `<suite>.jsonl` — the **dev** split; tune against this.
- `<suite>-holdout.jsonl` — the **holdout** split; validate only.
- Every case carries `metadata`: `split` (`dev`/`holdout`), `category` (the
  behavior class, e.g. `durable-routing`), and `criterion` (the plain-English
  acceptance criterion the case encodes).
- Reports land at `.smithers/evals/<suite>.json` by default; sweep runs go to
  `.smithers/evals/reports/<label>/`.
- `.smithers/evals/run-sweep.sh <label> [concurrency]` runs every seeded
  suite (dev + holdout) and prints a per-suite pass summary — the pattern for
  a full regression check before shipping a harness change.

Case shape:

```jsonl
{"id":"etl-silent-row-drop","input":{"prompt":"..."},"expected":{"status":"finished","outputContains":{"recommend":[{"recommendedWorkflow":"debug"}]}},"metadata":{"split":"dev","category":"durable-routing","criterion":"A root-cause defect lands on debug."}}
```

- `expected.status`: `finished`, `failed`, `waiting-approval`, etc.
- `expected.outputContains`: recursive partial match; arrays match by
  containment. **The usual choice** — key it to the output schema's
  load-bearing typed fields, never to prose.
- `expected.output`: exact match (brittle; rare).
- `expected.errorContains`: for adversarial cases that *should* fail.
- `judge`: `{"instructions": "...", "threshold": 0.7}` for semantic checks
  (tone, completeness) where JSON match can't work. Deterministic assertions
  AND the judge must both pass. Select the judge with `--judge-provider` /
  `--judge-model`.

## Adding evals to a workflow

1. List the acceptance criteria. Turn each into ≥1 case: a happy path, the
   quality-gate criterion itself, and an adversarial/edge case.
2. Write `.smithers/evals/<suite>.jsonl` with `metadata.split: "dev"`, and a
   `<suite>-holdout.jsonl` of fresh cases drawn from the same criteria but
   not shared with dev.
3. Dry-run the shape before spending:

   ```bash
   bun apps/cli/src/index.js eval .smithers/workflows/<wf>.tsx \
     --cases .smithers/evals/<suite>.jsonl --suite <suite> --dry-run
   ```

4. Run it (in-repo use `bun apps/cli/src/index.js eval`; consumers use
   `bunx smithers-orchestrator eval`):

   ```bash
   bun apps/cli/src/index.js eval .smithers/workflows/<wf>.tsx \
     --cases .smithers/evals/<suite>.jsonl --suite <suite> \
     --concurrency 4 --force
   ```

5. Read the report at `.smithers/evals/<suite>.json`; fix the workflow, not
   the test — unless the case encodes the criterion wrong, or the failure is
   environmental (see the classify rule below).
6. For graded, non-binary quality, attach scorers (`faithfulness`,
   `relevancy`, `schemaAdherence`, `llmJudge`) to the load-bearing `<Task>`
   and read them with `smithers scores <run-id>`. Assertions are the hard
   gate; scorers are the trend.
7. Add the suite to the sweep script / CI so it runs on every relevant
   change.

## Discipline rules

- **Classify red before acting.** Every failed case is one of three things:
  a product bug (fix the workflow), a wrong case (fix the case, with spec-
  change scrutiny), or a harness/environment fault (fix the harness). The
  report marks known environment faults INCONCLUSIVE and `smithers eval`
  exits `5` (not `1`) when they are the only reds: on that signal repair the
  harness and never touch the workflow. A red that could not have observed
  the workflow (connection refused, TLS failure, network denied, missing
  binary, OOM, rate limit) is not evidence against it.
- **Green ratchet.** If a case that passed in round N fails in round N+1 and
  the only intervening change was to the harness or environment, that is a
  harness regression: revert the harness change. Never widen a suite's
  acceptance criteria while it is red; get back to the last green slice
  first.
- **Circuit breaker.** After 3 consecutive rounds with zero net new green
  cases, stop iterating. Change strategy (gather evidence, widen scope) or
  escalate to a human via `smithers ask-human` with what you know. More
  rounds against the same failure signature is an incident, not progress.
- **Never tune against holdout.** No prompt edits, model picks, or
  optimization acceptance based on holdout results. Green holdout = ship;
  red holdout = your dev split stopped representing the criteria — fix the
  split, not just the workflow.
- **Failed case → first-class bug.** Reproduce with the run ID in the report
  (`smithers inspect <run-id>`, `smithers why <run-id>`), fix, re-run.
- **Suite changes are spec changes.** Editing a case to make a run pass
  rewrites the acceptance criteria; treat it with the same scrutiny as the
  workflow change itself.
- **Keep suites cheap to run.** Use `--max-cases` for smoke checks,
  `--concurrency` for throughput, and `--root` to sandbox tool execution.

## Pointers

- Authoring mechanics (scorer wiring, `eval-author` bootstrap):
  `skills/eval-writer/SKILL.md`
- CLI surface: `smithers-eval` and `smithers-optimize` skills; full option
  list in `docs/guides/evals-quickstart.mdx`
- Scorer API reference: `docs/reference/scorers` (source: `packages/scorers`)
- Eval engine: `packages/engine` + `apps/cli` `eval`/`optimize` commands
