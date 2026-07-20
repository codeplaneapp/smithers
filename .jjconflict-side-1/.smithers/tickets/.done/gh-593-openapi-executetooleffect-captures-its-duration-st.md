# 🧹 openapi: executeToolEffect captures its duration start at Effect construction instead of execution

GitHub: https://github.com/smithersai/smithers/issues/593

**What happens**
`executeToolEffect` (packages/openapi/src/tool-factory/_helpers.js:259-268) runs `const started = nowMs()` when the function is called — outside the Effect — and later records `openApiToolDuration` as `nowMs() - started` via `Effect.ensuring`.

**Why it matters**
An Effect is a re-runnable description: if the returned effect is ever run later than it was built, or run more than once, the recorded duration includes the construction-to-run gap and grows on each rerun. Today this is harmless — the sole caller (`createToolFromOperation`, line 358) does `Effect.runPromise(executeToolEffect(...))` immediately — but the API invites incorrect metrics for any future caller that stores or retries the effect. The tool-factory README also freezes this surface, so the wart persists.

**Expected**
Capture the start inside the effect (e.g. `Effect.sync(() => nowMs())` at the head of the gen block, or a Metric timing combinator) so duration measures execution only.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).


> Closed by ticket-fleet: landed on main in 730e349d3f3e93698682f41eac6a171faf004b49.
