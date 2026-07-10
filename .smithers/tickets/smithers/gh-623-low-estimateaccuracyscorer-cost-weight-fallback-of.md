# [low] estimateAccuracyScorer cost-weight fallback of 1 inverts intent

GitHub: https://github.com/smithersai/smithers/issues/623

**Severity:** Low · **Feature:** delegation-chain scorers · **File:** `packages/scorers/src/estimateAccuracyScorer.js:130`

## Problem
Node weight is `predicted.costUsd` when positive, else `1`. Real per-node costs in a delegation run are typically sub-dollar (cents), so a node **with** a genuine small cost estimate (weight ~0.02) is out-weighed ~50:1 by any node **without** a cost estimate (weight 1). The cost-weighted mean then almost entirely ignores misforecasts on cost-annotated nodes — inverting the scorer's stated "misforecasting big nodes matters more" intent in mixed runs.

## Failure scenario
Node A `estimate {tokens:1000, costUsd:0.02}` / actual `{tokens:2000, costUsd:0.04}` (2× misforecast, ratio 0.5) and node B `estimate {tokens:1000}` (no cost) / actual `{tokens:1000}` (ratio 1). Result: score `0.9902`, because A gets weight `0.02` and B gets weight `1` — A's 50% misforecast is invisible even though A is the node with a real (small) cost.

## Why low
Off the designed happy path: `delegationPrompts.js:39` makes `estimate.costUsd` **required** on every child, and the weight is derived from the predicted/estimate side, so the fallback only fires when the planning LLM violates the required-field instruction on a subset of nodes. Also explicitly documented (docstring `52-54`) and directly tested (`delegation.test.js:528-566`). Affects only an eval scorer (weight `0.15` in `delegationRunScore`), not a runtime path.

## Suggested fix
Use a neutral fallback (e.g. mean of the known positive weights, or a small default) so a node without a cost estimate doesn't dominate the cost-weighted mean.

## Verification
Arithmetic reproduced on current code: `weight = predicted.costUsd` when `>0` else `1`; total `0.5*0.02 + 1*1 = 1.01`, weightSum `1.02`, score `1.01/1.02 = 0.9902`.

---
*Found in the pre-0.28.0 review of `v0.27.0..HEAD` (@0ed2c28710), adversarially verified against the code. Part of the `pre-0.28-review` batch.*
