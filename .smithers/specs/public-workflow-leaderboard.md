# Public community workflow leaderboard

Status: proposal for issue #1367. Date: 2026-08-17.

## Recommendation and decision

Do not launch a permanent "coolest workflow" ranking. Run one bounded,
track-specific competition only after a maintainer approves the track contract,
rubric, operator, moderation policy, and spend cap. The decision required to
close #1367 is: approve the pilot described below with a named operator and
budget, or decline a judged competition and keep `awesome-smithers` as an
unranked showcase.

## What is ranked

Rank an immutable **workflow submission**, not an author and not an individual
run. A submission is this tuple:

`{round, track, repository, commit, pack, workflow id, Smithers version}`

Runs are evidence for that entry. Authors receive attribution and a round badge,
but there is no cross-track or all-time author score. Workflows with different
purposes are not comparable, so every board is scoped to one published input,
output, tool, sandbox, model, and budget contract. A new commit is a new entry.

The original "coolest" idea belongs in a separate community-choice badge. A
human popularity vote can celebrate originality, but it must not be blended
with a benchmark score or presented as objective quality.

## Judging signal

The rank signal is performance on organizer-owned, held-out cases for the
track. The primary metric is declared before submissions open. Cost and latency
are reported and used only as ordered tie-breakers unless the track explicitly
defines a resource-normalized primary metric. Every entry gets the same model,
reasoning effort, task order, sandbox, network policy, retry policy, time limit,
and API-equivalent dollar limit. Report the number of cases and repetitions,
per-case outcomes, mean score, a paired 95% bootstrap interval, cost, wall time,
and infrastructure failures.

Trust comes from this order of evidence:

1. Deterministic tests or labeled outcomes when the task permits them.
2. A frozen rubric and blinded judge panel only for criteria that deterministic
   checks cannot express.
3. A human adjudicator for judge disagreement, conflicts, plagiarism, or an
   appeal. Human decisions are logged and never silently rewrite raw results.

`packages/scorers` and the repository eval machinery are useful but do not
suffice for a public leaderboard by themselves. The scorer package already has
deterministic assertions, LLM judges, batch execution, cost estimation, and
aggregation. `evals/` already has JSONL cases, real workflow execution,
deterministic verification where possible, panel judging, and scorecards. The
seeded-bug review eval is especially reusable: its scorer measures precision,
recall, F1, anchor accuracy, and severity calibration over labeled bugs and
clean controls.

Those components do not provide submission provenance, untrusted-code
isolation, secret holdouts, confidence intervals, moderation, appeals, or
publication receipts. An LLM score for "originality" or "usefulness" is also
too prompt-sensitive and gameable to be the primary public rank. These are
competition policy and runner concerns, not missing generic scorer primitives.

## Submission and abuse policy

Use the existing `smithers share` path as discovery, not as automatic entry.
It already stages a publishable pack, excludes private state, and opens a change
against `smithersai/awesome-smithers`. A leaderboard submission is a second,
explicit pull request containing the immutable tuple above, author identity,
license, track, declared external services, and consent to public artifacts.

Before accepting an entry, the operator must:

- verify the commit and pack manifest, license, installability, and declared
  Smithers version;
- scan the staged closure for secrets, symlinks, generated payloads, vendored
  credentials, and undeclared network or side effects;
- execute without organizer credentials in a disposable sandbox, with network
  disabled unless the track contract requires an allowlist;
- cap CPU, memory, storage, wall time, model calls, and API-equivalent spend;
- reject attempts to read holdouts, evaluator state, other submissions, or
  host services;
- limit one scored entry per author or team per round, with one pre-deadline
  replacement, so money and probing do not buy unlimited holdout feedback; and
- publish disqualifications, conflicts, manual overrides, and appeals in the
  round record.

Holdout labels never enter the entrant container. Give entrants public example
cases and a local validation command. Rotate private cases after each round and
publish retired cases afterward. Similarity review and maintainer judgment deal
with copied submissions; automated similarity alone must not disqualify.

## Hosting and operation

Publish a static round page on the existing `benchmarks.smithers.sh` surface.
`benchmarks/results.json` and `benchmarks/site/make-site.ts` already establish a
reviewable, generated, no-live-database pattern with `n`, subset, status, and
caveat on every row. Add community rounds to that dataset only after the pilot
is authorized. Store the frozen rules, input manifest, run receipts, aggregate
JSON, and generated page in version control. Do not make a live Gateway board
the source of record.

Smithers maintainers operate intake and publication. One named release
maintainer owns each round, two maintainers can adjudicate disputes, and the
project pays model and runner costs. Without those named roles, the round does
not open. Monthly cadence is premature; cadence is decided after the pilot's
operator time and abuse load are known.

## Smallest version worth shipping

Run one invitation-based seeded-bug review round with at most ten entries. It
reuses `evals/review-seeded-bugs` for the output contract and deterministic
scoring. The existing 16 public fixtures become examples and regression tests;
the organizer must author a small private set with the same labeled bug classes
and clean controls before opening submissions. Rank by F1 over planted findings
and false positives, then by API-equivalent cost, then wall time. Use three
repetitions per held-out case and publish all run receipts after the round.

`scoreCorpus` now emits that F1 alongside precision and recall, so a published
rank is recomputable from a committed receipt without a leaderboard-specific
scorer. F1 is also the only one of the three a silent entry cannot game:
reporting no findings at all scores perfect precision under the scorer's
empty-denominator convention, and scores zero F1.

This pilot is worth shipping because every workflow solves the same problem,
the primary score is deterministic, clean controls penalize spam findings, and
the hosting path already exists. A generic all-purpose board, a public page of
uncalibrated judge opinions, or a board with fewer than several independent
held-out cases is not worth shipping.

## Exit criteria

After the pilot, continue only if the operator can reproduce every result from
the committed receipt, no holdout leaked, adjudication affected fewer than 10%
of entries, and at least three unrelated authors completed the submission path.
Otherwise publish the pilot as an experiment and return to an unranked
`awesome-smithers` showcase.
