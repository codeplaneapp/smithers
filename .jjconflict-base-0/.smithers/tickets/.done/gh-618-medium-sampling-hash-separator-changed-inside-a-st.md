# [medium] Sampling-hash separator changed inside a "stylistic cleanup" commit (breaks replay determinism)

GitHub: https://github.com/smithersai/smithers/issues/618

**Severity:** Medium · **Feature:** refactor sweep (mislabeled) · **File:** `packages/scorers/src/run-scorers.js:36` · **Commit:** `2a94e790a4` ("refactor(scorers): stylistic cleanup + folder READMEs")

## Problem
A commit that claims to be a **behavior-preserving stylistic cleanup** actually changed runtime behavior. `samplingValue()`'s SHA-256 seed join changed from a space to a NUL byte:

```diff
-    ].join(" ");
+    ].join("\0"); // NUL separator keeps field boundaries unambiguous even if ids contain spaces.
```

The joined array is the exact input to `crypto.createHash('sha256').update(seed)`. Changing the delimiter changes the digest → changes the `[0,1)` value → changes the `samplingValue(binding, ctx) < sampling.rate` run/skip decision in `shouldRun()` for **every ratio-sampled scorer**.

## Why it matters
This **breaks the deterministic-replay invariant the function's own docstring promises** ("makes the same run/skip decision on the original execution and on every replay/fork of that checkpoint"). A scorer that ran on the original execution is now skipped on replay/fork of a pre-change checkpoint (or vice versa), changing persisted scoring output across the version boundary.

## Failure scenario
A scorer bound with `sampling:{type:'ratio', rate:r}` over `(runId,nodeId,iteration,attempt,scorerId)`. Empirically: seed `["run-abc","node-1",0,0,"scorer-x"]` hashes to `0.7212…` with a space separator and `0.5099…` with NUL. At `rate:0.7` the decision flips (`false`→`true`) for identical inputs.

## Suggested fix
Decide intent. If determinism across the release boundary matters, keep the space separator. If the NUL change is genuinely wanted (disambiguating ids with spaces), that's fine — but it must ship as an explicit, documented behavior change, **not** as "stylistic cleanup," and the replay-determinism docstring should note the version discontinuity.

## Verification
Confirmed via `git show 2a94e790a4^:` vs `2a94e790a4:` that this is the only substantive hunk in the commit; it is the only call site and nothing is left undefined (not a broken rename). This was the single real behavior change found across all 40 "stylistic cleanup" commits.

---
*Found in the pre-0.28.0 review of `v0.27.0..HEAD` (@0ed2c28710), adversarially verified against the code. Part of the `pre-0.28-review` batch.*


> Closed by ticket-fleet: landed on main in 36434bd0f052de2a479464a63be4267e91008756.
