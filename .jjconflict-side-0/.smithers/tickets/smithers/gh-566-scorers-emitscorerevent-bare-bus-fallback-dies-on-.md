# 🐛 scorers: emitScorerEvent bare-bus fallback dies on a throwing bus.emit, aborting scoring despite its contract

GitHub: https://github.com/smithersai/smithers/issues/566

**What happens**
`emitScorerEvent` (packages/scorers/src/run-scorers.js:71-75) wraps the bare-bus fallback in `Effect.sync(() => bus.emit("event", event))` and relies on `Effect.ignore` to satisfy its contract comment: "Persistence failure must never abort scoring." `Effect.sync` converts a synchronous throw into a DEFECT (die), and `Effect.ignore` suppresses only typed failures — defects propagate.

**Why it's wrong / failure scenario**
A third-party EventBus that exposes only `emit()` and whose emit throws: the defect escapes `emitScorerEvent`, and the downstream `Effect.catchAll` fallbacks in `runScorersAsync` (run-scorers.js:256) and `runScorersBatch` (run-scorers.js:278) also handle only typed SmithersError failures — so the forked fiber dies (async path) or the entire `runScorersBatch` promise rejects (batch path), aborting scoring in exactly the way the comment promises cannot happen.

**Expected**
Wrap the fallback in `Effect.try` (typed, ignorable error) or ignore the full cause (e.g. `Effect.catchAllCause`/`Effect.exit`). The `emitEventWithPersist` branch is fine (typed error channel, ignored).

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
