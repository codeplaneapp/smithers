---
description: "Learned suspected edges that may propose, defer, or order work, and never decide what is cached or correct."
---

# Probabilistic Selection

:::note
The source spec, `docs/specs/Concepts/Probabilistic Selection.md`, is `status: draft`.
:::

The engine's exact-dependency graph knows which files a step read and which
inputs it declared, and that is enough to know what must re-run and what is
safe to skip for builds and tests. It is not enough for a flow like "update
the engine docs when the engine changes": no declared input connects the docs
flow to the engine source, so that flow otherwise runs on every change, or on
none.

Probabilistic Selection closes that gap without weakening the exact graph. It
learns which changed paths tend to affect which flows, and lets those guesses
do three things: suggest extra work, postpone low-risk sink work, and order the
queue.

:::warning[The rule this rests on]
A guess may schedule work. Only a real dependency edge decides what is cached,
correct, or up to date.
:::

## The motivating picture

The spec illustrates the idea with a plan card. You edit
`packages/engine/src/PlanScheduler.ts` and plan a review.

Today:

```
cached    read-pr
run       build
run       engine-tests
run       lint-docs            - runs every time; failed 3x in two years
                                (and update-engine-docs is not here at all:
                                 no file dependency reaches it)
```

With selection informing the plan:

```
cached    read-pr
run       build
run       engine-tests
deferred  lint-docs            fail likelihood 0.03 - runs in the guess-free pass
proposed  update-engine-docs   engine/** changes preceded doc edits in 41 of 50 merges
```

`deferred` is not run now; it is recorded as debt and repaid by a later
guess-free pass. `proposed` is extra work a guess suggests, not work silently
added to the plan. v2 ships the pure card renderer for these rows; attaching
that renderer to a CLI or other product UI is outside `engine-store`.

## The three allowed actions

| Action | What it means | Worst case when wrong |
| --- | --- | --- |
| **Propose** | Record a candidate row for a flow no real dependency reaches | An unneeded suggestion sits unapproved |
| **Defer** | Postpone a low-risk sink to a later guess-free pass | The failure surfaces late; the miss becomes the training signal |
| **Order** | Run likely-to-fail steps first, inside the scheduler's existing priority | A worse order; the scheduler's built-in aging still prevents starvation |

`Selection` ships `Admit`, `Defer`, and `Propose` verdicts. `Order` rides the
plan's existing `priority` field rather than a fourth verdict.

## Why only sinks are deferrable

A sink is a node nothing else in the plan depends on: a test, a lint pass, a
doc check. Deferring a step something depends on would block or corrupt its
consumers, so the scheduler only offers selection verdicts to sink candidates.
A `Defer` or `Propose` verdict that violates the plan's shape is ignored and
journaled as an inconsistency observation rather than executed as a silent
no-op.

## Store and training

`SelectionStore` is the durable suspected-edge store. `upsert(edges)` inserts
or replaces by `(scope, affects)`, `list()` returns every stored edge, and
`snapshot()` returns a `BeliefSnapshot` pinned at the injected clock's current
time. The clock pin matters: planning is a pure function of the snapshot it was
given, not of `Date.now()`.

Training is also deliberately small. `train(observations)` updates only
matching stored edges and ignores unknown `(scope, affects)` pairs. Every
observation is appended to the edge's evidence list. A hit moves confidence to
`confidence + 0.05 * (1 - confidence)`; a miss halves it. The asymmetry is the
negative-regret rule: harm decays confidence faster than usefulness accrues it.
Training only moves confidence; it never creates edges and never writes
journal records.

## Recertification debt

A deferred step is a debt, not a decision. It is journaled with the guess that
caused it, and `Selection.debt(runId)` lists the open entries for that run:
node, plan key, edge, likelihood, and journal provenance.

The default query is still the v1 same-run fold. A
`flows.engine.selection-deferred` record opens debt under its plan key, and a
later `flows.engine.node-settled` record in that same run closes it only when
the outcome is `built`, `clean`, or `failed`. `skipped` never closes debt,
because the work did not run.

v2 adds explicit cross-run repayment:
`Selection.debt(deferringRunId, { repaidBy: [freshRunId] })`. Opens still come
only from the deferring run's `selection-deferred` records. Closes may also
come from any listed repaying run's `node-settled` records when the plan key
matches and the outcome is `built`, `clean`, or `failed`. Omitting `repaidBy`
keeps the v1 result byte-for-byte.

`PlanScheduler.recertify(input)` is the primitive a scheduled full pass can build
on. It re-drives the compiled plan through `PlanScheduler` under the caller's
fresh run id with selection fully overridden, then returns that repaying run id
and the remaining debt computed with `repaidBy`. The deferring run's journal is
left untouched. The scheduled cadence itself remains future work: nightly,
per-merge, or trunk policy is a product/system-flow concern, not an
`engine-store` primitive.

## Card and risk

`Selection.card(input)` renders the plan-card rows from plain data. The row
grammar is fixed by tests:

```
  cached    <node>
  run       <node>
  deferred  <node>    fail likelihood <l> - recert <cadence>
  proposed  <flow>    suspected edge <confidence> - <scope> touched
  risk      <level> - <reasons joined with '; '>
```

The risk row is optional and comes from `Selection.risk({ changed, beliefs })`.
`high` means at least one live matching edge has confidence `>= 0.7`, `medium`
means at least one has confidence `>= 0.4`, and `low` means no live matching
edge reaches that bar.

:::warning
Risk is an annotation, never a gate. Approval routing from that level is
intentionally outside this package.
:::
Reasons name contributing edges as `<scope> -> <affects> (<confidence>)`.

`Selection.proposeReadSet({ beliefs, flow, paths })` is the related helper for
agent steps. It returns workspace paths that match the scope of any live edge
whose `affects` names the flow, deduplicated in input order. It is the pure
feeder for `boundaryMode: "expected"`; wiring it into agent execution is out of
scope here.

## Heuristic selection

`layerNoop` admits everything and is the default. `layerHeuristic` is pure and
deterministic: it glob-matches changed paths against live suspected edges and
uses the best matching edge confidence as likelihood. A `Candidate` may also
carry `stats?: { failures: number; runs: number }`; the likelihood becomes the
maximum of the best live edge confidence and `failures / max(runs, 1)`.

Stats alone never defer. Deferral still requires a live edge naming the sink.
The stats path exists so failure history can keep a flaky sink running inline
where v1's low-confidence edge would have deferred it.

## Prior art

Every production system that does this keeps a deterministic dependency graph
and puts the learned model above it, where it can only select, order, or flag,
never decide correctness.

| System | The model decides | Correctness kept by |
| --- | --- | --- |
| Meta Predictive Test Selection | Which tests, among those the build graph already says are affected, to run now | Skipped tests still run later on trunk; misses retrain the model |
| Meta Diff Risk Score | How likely a change is to cause an incident | Advisory only, human-overridable |
| Uber SubmitQueue | Which merge builds to start speculatively, in what order | The queue's deterministic serialization; a wrong guess only wastes compute |

Probabilistic Selection follows the same split: a deterministic core below,
with learned advice above it. One deviation from Meta's design is `Propose`:
flows can suggest work the exact graph cannot see, because for agentic flows a
guess is sometimes the only edge that exists at all.

## What ships

- `Selection.select`, a pure function of a pinned `BeliefSnapshot`: `Admit`,
  `Defer`, and `Propose` verdicts that never touch a step key or cache row.
- `SelectionStore`, with `upsert`, `list`, `snapshot`, and asymmetric
  `train`.
- `layerNoop` and `layerHeuristic`, including optional candidate failure
  stats.
- `PlanScheduler` integration for sink-only deferral, proposal journaling, and
  the selection full override.
- `Selection.debt(runId, options?)`, including cross-run repayment through
  explicit `repaidBy` run ids.
- `PlanScheduler.recertify(input)`, the guess-free repayment primitive.
- `Selection.card`, `Selection.risk`, and `Selection.proposeReadSet` as pure
  helpers.

See `packages/engine-store/README.md` for the package API and
`docs/reference/engine-store.md` for the terser reference contract.

## Future work

- A model-backed `Selection` layer. `engine-store` must not grow a model
  dependency; model-backed selection belongs in a separate layer.
- CLI verbs. No CLI package exists in this repo.
- Approval routing from risk levels. The risk helper annotates; approval
  machinery is not part of this package.
- Automatically appending a `Propose` verdict as a plan node. That design is
  pending human review.
- Scheduled recertification cadence. The primitive ships, but nightly or
  per-merge cadence belongs to product/system flows.
