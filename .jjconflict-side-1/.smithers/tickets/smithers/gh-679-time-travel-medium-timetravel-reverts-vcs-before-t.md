# 🐛 time-travel: [medium] timeTravel reverts VCS before the DB txn with no needs_attention guard on failure

GitHub: https://github.com/smithersai/smithers/issues/679

_via ultracode (Opus multi-agent) review_

**Summary:** `timeTravel()` reverts the working copy before its DB transaction and, unlike its siblings, writes no durable marker if the transaction fails or the process crashes — leaving an inconsistent DB/filesystem state with no corruption signal.

**Locations:**
- `packages/time-travel/src/timetravel.js:143` — `revertToJjPointer` rewinds the working copy.
- `packages/time-travel/src/timetravel.js:186` — `withTransaction("time-travel", …)` truncates frames/snapshots/vcs-tags and resets nodes, and is NOT wrapped in try/catch (no `markRunNeedsAttention`, no rewind-audit row).
- Contrast: `packages/time-travel/src/revert.js:118-134` wraps the same VCS-then-DB sequence and calls `markRunNeedsAttention` on DB-cleanup failure; `jumpToFrame.js` writes an `in_progress` audit + has `recoverRewindAuditsAtStartup`.
- CLI: `apps/cli/src/index.js:7205-7207` only prints `TIMETRAVEL_FAILED`; sets no attention flag.

**Failure scenario:** User runs `smithers timetravel --vcs` on a stopped run. `revertToJjPointer` succeeds and rewinds the working copy to the target attempt's revision, but the subsequent `withTransaction` throws (transient DB error) or the process is killed between line 143 and the commit. The transaction rolls back, so post-target frames/nodes/snapshots stay in the DB while the filesystem sits at the OLD revision. No `needs_attention` flag is set. On resume the engine sees those later nodes as `done` and skips them, though their on-disk work no longer exists — silently lost work with no signal.

**Why it matters:** `smithers timetravel` is a reachable CLI path and is strictly less durable than `revertToAttempt`/`jumpToFrame` for the identical VCS-then-DB hazard. A partial failure yields an inconsistent working-copy/DB state with no operator-visible marker.

**Fix:** Wrap the `withTransaction` at timetravel.js:186 in try/catch and call the same `markRunNeedsAttention` compensation used in revert.js when the VCS revert already succeeded (`vcsRestored === true`).
