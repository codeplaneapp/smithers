# 🐛 time-travel: fork resetNodes never resets downstream dependents, contradicting expandResetSet's documented contract

GitHub: https://github.com/smithersai/smithers/issues/584

**What happens**
`expandResetSet` (packages/time-travel/src/fork/_helpers.js:1-28) documents that it computes "the full transitive set including all downstream dependents" and resets "every node whose iteration >= the minimum iteration of the reset set". The implementation only collects snapshot keys whose base nodeId is in `resetNodeIds` (with an exact-key fallback) — no dependent expansion, no iteration threshold. `forkRunEffect` (packages/time-travel/src/fork/forkRunEffect.js:94-104) uses this to decide which nodes to reset on a fork.

**Why it's wrong / failure scenario**
Forking with `resetNodes: ['A']` re-runs A but restores the finished output of node B (which consumed A's output) from the parent snapshot, so the forked run proceeds with stale downstream state. Anyone building on the docstring's promise ships exactly this bug. Already recorded as item 91 in `.smithers/specs/bug-audit-2026-06-25.md`.

**Expected behavior**
Either implement the documented dependent/iteration expansion, or fix the docstring to state the real contract (only explicitly named nodes are reset, across their iterations) and make fork callers list dependents explicitly. Current behavior is pinned by `packages/time-travel/tests/rewindAuditHelpers.test.ts`, so this is a deliberate contract decision, not a comment tweak.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
