# 🐛 engine: duration timer stalls forever when its waiting-timer attempt metaJson is unparseable (snapshot re-anchored to now on every pass)

GitHub: https://github.com/smithersai/smithers/issues/538

**What happens**
In `resolveTimerTaskStateBridge` (`packages/engine/src/effect/deferred-state-bridge.js:652-666`), when the latest attempt is `waiting-timer` but `parseTimerSnapshot(latest.metaJson)` returns null (missing/corrupt/legacy meta), the fallback is `buildTimerSnapshot(desc, now)`. For a duration timer that computes `firesAtMs = now + delayMs` (deferred-state-bridge.js:458-470), so `snapshot.firesAtMs > now` is always true, the waiting branch is taken, and the rebuilt snapshot is NOT persisted (only the node row is upserted).

**Why it's wrong / failure scenario**
Every scheduler pass rebuilds the snapshot anchored at the current time, so the deadline recedes forever: the node is a permanent liveness stall with no error surfaced. Absolute (`until`) timers escape because their firesAtMs is fixed.

**Expected**
Fall back once and persist: re-anchor from `latest.startedAtMs` (or persist the rebuilt snapshot into the attempt's metaJson inside the waiting branch) so subsequent passes see a fixed `firesAtMs`.

Related: #502 (scheduler-side duration-deadline drift) and possibly the silent-stall symptom in #494, but this is a distinct engine-bridge path.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
