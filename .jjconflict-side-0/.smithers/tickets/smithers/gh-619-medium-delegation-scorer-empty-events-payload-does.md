# [medium] Delegation scorer: empty {events:[]} payload doesn't fall back to context

GitHub: https://github.com/smithersai/smithers/issues/619

**Severity:** Medium · **Feature:** delegation-chain scorers · **File:** `packages/scorers/src/delegationEvents.js:28`

## Problem
In `toPayload`, the bare-array branch (`line 22`) returns `null` when the filtered array is empty, letting `extractDelegationEvents` fall back to `input.context`. The object branch (`line 28`) returns `{ events: [...], nodes }` **unconditionally** — even when the filtered events array is empty. This contradicts the documented contract ("Returns null when neither carries events") and the symmetric bare-array behavior.

## Impact
With `output = { events: [] }` and real events in `context`:
- `pocJudgmentScorer` scores the **empty output** (returns `0.75`/correctNegative from output node-metadata) instead of the `falseNegative`/`0` the real context events warrant.
- `planSolidityScorer` returns score `1` **without** `meta.skipped`, so `weightedScore` (`aggregate.js:137`, which only excludes `result.meta?.skipped === true`) does **not** exclude it — it contributes a full `1.0` at weight `0.25`, inflating `delegationRunScore`.

## Failure scenario
```js
pocJudgmentScorer().score({
  output:  { events: [], nodes: [{ id: 'c1', kind: 'chunk' }] },
  context: { events: [{ t: 'NODE_INVALIDATED', node: 'c1' }] },
})
```
Returns `0.75` ("1 correctNegative") from the empty output, ignoring the real context event that should classify `c1` as a `falseNegative` (score `0`). The bare-array form `output: []` with the same context correctly falls back and scores `0`.

## Suggested fix
Return `null` from the object branch when the filtered `events` array is empty (symmetric with the bare-array branch), so `extractDelegationEvents` falls back to `context`.

## Verification
Reproduced exactly via `node` against `src/index.js`: the empty-object output suppresses the context event; `resolvePlanningNodes` still derives `c1` from `nodes` metadata so the `length===0` skip is not hit; `classifyNode` with empty events returns `correctNegative`. Tests cover the bare-array empty case (`delegation.test.js:38`) but not the object case.

---
*Found in the pre-0.28.0 review of `v0.27.0..HEAD` (@0ed2c28710), adversarially verified against the code. Part of the `pre-0.28-review` batch.*
