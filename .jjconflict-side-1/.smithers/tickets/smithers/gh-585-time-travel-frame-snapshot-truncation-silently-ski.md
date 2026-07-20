# 🐛 time-travel: frame/snapshot truncation silently skipped when every frame postdates the target attempt (revert + timetravel)

GitHub: https://github.com/smithersai/smithers/issues/585

**What happens**
Both cleanup blocks compute `lastValidFrameNo` as the newest frame with `createdAtMs <= attempt.startedAtMs`, then guard the truncation with `if (lastValidFrameNo >= 0)`:
- packages/time-travel/src/revert.js:99-129
- packages/time-travel/src/timetravel.js:186-201 (inside the time-travel transaction)

When every frame was created after the target attempt started, `lastValidFrameNo` stays `-1` and `deleteFramesAfter` / `deleteSnapshotsAfter` / `deleteVcsTagsAfter` are skipped entirely.

**Why it's wrong / failure scenario**
That is exactly the case where ALL frames should be discarded. Reverting/time-traveling to the first attempt of a run is a realistic trigger: frame commits happen as execution progresses, so every frame can postdate the first attempt's start. Result: VCS is rewound (and in timetravel.js nodes are reset to pending and the run set back to running) while the DB keeps every frame, snapshot, and vcs-tag from the discarded timeline — a later fork/replay/timeline read can resurrect reverted state, the inconsistency the surrounding comments say this code prevents.

**Expected behavior**
When `lastValidFrameNo === -1`, truncate everything (e.g. `deleteFramesAfter(runId, -1)` and matching snapshot/vcs-tag deletes), or document why full history is intentionally preserved in this edge. revert.js and timetravel.js should agree.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
