# Seeded workflow eval suites

`smithers init` ships eleven workflows. Until now none of them had a regression
suite, so prompt edits shipped unmeasured. This spec adds eval suites for the
four most assertable seeded workflows, runs them with the in-repo `smithers
eval` harness, and uses the numbers to drive (and then protect) a round of
workflow improvements.

## What ships

- `.smithers/evals/route-task.jsonl` and friends: one JSONL suite per covered
  workflow, run with `smithers eval <workflow> --cases <suite>`.
- `.smithers/evals/fixtures/seed-triage-fixtures.ts`: seeds deterministic
  failed/stuck runs into the local `smithers.db` so `triage-run` cases have
  real runs to diagnose. Fixture workflows use compute nodes only; seeding
  costs zero agent calls.
- Prompt and structure fixes to the seeded workflows, measured before and
  after with the same suites.

## Covered workflows

| Suite | Cases | What it checks |
| --- | --- | --- |
| route-task | classification + routing | `mode`, `durable`, `recommendedWorkflow` against labeled tasks |
| backpressure-plan | criteria extraction + gate planning | gate matrix structure: verification methods, gate types, approval flags |
| context-doctor | deterministic checks + advise | exact issue severities and score; fix-to-check pairing |
| triage-run | failure diagnosis | `recommendedAction` and command shape per seeded failure fixture |

Not covered, and why:

- `create-workflow`, `create-skill`: minutes-long tool runs per case; their
  compile-render verify loop already gates quality. Candidates for a later
  nightly suite.
- `monitor-smithers`: classification depends on wall-clock run ages, so cases
  are not reproducible without freezing time. Its prompts still get the
  data-delivery fix below.
- `context-engineer`: end-to-end needs a human in the grill step. Its
  classify/route stages share route-task's catalog and fixes.
- `report-slideshow`, `extract-skill`, `eval-author`: partially assertable;
  deferred to keep this round affordable.

## Case design

Cases live one JSON object per line. `input` is the workflow input, `expected`
uses the harness assertion kinds (`status`, `outputContains`, `errorContains`).
Assertions pin only load-bearing fields: enums, booleans, ids. Free-prose
fields (`reason`, `why`, `summary`) are never asserted, so phrasing changes
cannot flip a case.

Each suite has two splits, marked in `metadata.split`:

- `dev`: used while iterating on the workflows.
- `holdout`: run only at baseline and once at the end. Catches improvements
  that overfit the dev cases.

Cases that assert a tightened contract (for example `advise.fixes` pairing
each fix to its check id) carry `metadata.tier: "contract-v2"`. Reported
stats separate them from like-for-like cases so the before/after comparison
stays honest.

## Improvement rules

Improvements must generalize. Allowed: delivering data the prompt already
claims to deliver, schema tightening (enum over free string), decision
rubrics and worked examples, null-input handling, deterministic verification
nodes. Not allowed: hardcoding suite phrasing, special-casing eval inputs,
weakening assertions to make a case pass.

## Found by the first smoke run

The very first eval case surfaced a systemic defect: MDX does not evaluate
expressions inside fenced code blocks, so every seeded prompt that passes
structured data via

    ```json
    {JSON.stringify(props.workflows, null, 2)}
    ```

sends the literal template text to the model. route-task's classifier never
saw the workflow catalog; monitor-smithers' classifier never saw the run
snapshot; eval-author's run command ships a literal `{props.evalsDir}`. The
fix (interpolate via a single MDX expression that builds the fenced block as
a string) is part of this change and is exactly the class of bug eval suites
exist to catch.

## Running

```bash
# one suite
bun apps/cli/src/index.js eval .smithers/workflows/route-task.tsx \
  --cases .smithers/evals/route-task.jsonl --suite route-task \
  --report .smithers/evals/reports/route-task.json --force --root /tmp/smithers-eval-root

# triage fixtures first, then the triage suite
bun .smithers/evals/fixtures/seed-triage-fixtures.ts
```

Run IDs are deterministic per suite and case; rotate `--run-label` between
sweeps against the same database.

## Results

Recorded in the PR description: per-suite pass rates at baseline and after
the improvement round, dev and holdout reported separately.
