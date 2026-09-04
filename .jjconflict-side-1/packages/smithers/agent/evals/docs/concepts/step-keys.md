---
title: "Step keys and comparison"
description: "The rule that separates a regression from nondeterminism, and how observations pair with baseline records."
sidebar:
  order: 2
---

One rule decides what a comparison reports, and it is the mental model the
whole package is built around: the step key identifies the work a case
produced.

- A score that dropped at a changed step key is a regression: the target
  produced different work, and the different work graded worse.
- A score that moved at an unchanged step key is nondeterminism: the same work
  graded differently twice.

Both are results, and a gate reads both as red. They are different reds: a
regression points at the target, nondeterminism points at a target or a scorer
that does not repeat itself.

The step key is why the executor contract asks for a key that is stated, not
derived. If the key were a hash of the output, every output change would read
as new work and nondeterminism would be unreportable. If the key never
changed, different work would read as the same work. The executor names the
step; the comparison believes it.

## Pairing

A scorer may fire several times against one case, so comparison cannot zip two
arrays by position. `Regression.compare` groups baseline records and run
observations by `(case, scorer)`, then pairs them:

1. Records and observations that share a step key pair first, lowest score to
   lowest score, so a repeated scorer does not report a move that never
   happened.
2. Whatever is left over pairs in stable `(stepKey, score)` order.
3. An unpaired record on either side is a missing observation, never a silent
   drop. `side: "run"` names a baseline record the run never reproduced;
   `side: "baseline"` names a score no baseline record accounts for.

A score that improved at a changed step key is not reported: the comparison
exists to catch deterioration, and an improvement at a changed key is new work
that graded better.

## Tolerances

A move is reported only when it exceeds both tolerances: the absolute
difference and the difference relative to the baseline score. Either one alone
is enough to silence a move, and both default to 0, which reports every move.
The relative check divides by the baseline score guarded away from zero, so a
baseline score of exactly 0 cannot make a later move look infinitely large or
infinitely small.

## What comparison preserves

Inconclusive observations decide nothing, and the comparison carries them
through untouched rather than dropping them: a gate has to see them, because a
scorer that could not answer is an environment fault, not a measurement.
Failed cases never reach the comparison at all. They live on the run's case
results, and the gate reads them from there.
