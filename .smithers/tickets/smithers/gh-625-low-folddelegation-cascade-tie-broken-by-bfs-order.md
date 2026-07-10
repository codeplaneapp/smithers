# [low] foldDelegation cascade tie broken by BFS order, not explicit precedence

GitHub: https://github.com/smithersai/smithers/issues/625

**Severity:** Low · **Feature:** delegation flux store · **File:** `packages/gateway-react/src/delegation/foldDelegation.ts:454`

## Problem
`cascadeStage` resolves a node reachable via BOTH a redeclared-parent reaffirm-path and a dependency-cascade path by whichever BFS path visits it first — an arbitrary (though input-order-stable) choice, rather than a defined precedence rule.

The per-source BFS uses a single `seen` set, so the first visit wins, and the `via` tag on that first visit selects the branch: `line 454-459` (parent-redeclaration → skip/reaffirm) vs `line 460-463` (cascade → derisk). A node X registered as a dependent of both its plan-parent A (redeclared) and a gate-dep B (cascade victim) gets its final status decided by whichever of A/B is dequeued first from the `dependents.get(source)` Set.

## Failure scenario
Invalidated source S has dependents A and B. A was replanned and re-declares child X (parent-path hits the redeclaration skip). B is an unreaffirmed cascade victim whose dependents include X. X is reachable only transitively from both A (skip) and B (mark). Dequeue via A → X skipped (no derisking); via B → X derisking + subtree cascaded. The winner depends on Set iteration order.

## Why low
Fully deterministic per input (does not break the order-insensitivity contract), requires a deeply contrived graph, and only affects a cosmetic UI status label. No crash/data loss/wrong result on any realistic path. (The `nondeterministic-semantics` framing is a slight misnomer — it's deterministic, just implicit.)

## Suggested fix
Define explicit precedence between redeclaration-reaffirm and cascade-derisk (e.g. resolve all reaffirm-skips before cascade marks, or tag by rule not traversal order), and add a test for the dual-reachable node.

## Verification
Traced `cascadeStage` (`421-468`): X registered as dependent of both A and B; single `seen` set; `materializeStage:534` turns `cascadeRound !== undefined` into "derisking" with no later override. Could not refute; benign latent-precedence gap.

---
*Found in the pre-0.28.0 review of `v0.27.0..HEAD` (@0ed2c28710), adversarially verified against the code. Part of the `pre-0.28-review` batch.*
