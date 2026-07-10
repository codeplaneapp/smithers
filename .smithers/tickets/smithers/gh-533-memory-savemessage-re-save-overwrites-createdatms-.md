# 🐛 memory: saveMessage re-save overwrites createdAtMs, breaking message ordering on crash-resume/replay

GitHub: https://github.com/smithersai/smithers/issues/533

**What happens**
`packages/memory/src/store/MemoryStoreLive.js:229-258`: `saveMessageEffect` computes `createdAtMs = msg.createdAtMs ?? nowMs()` and includes `createdAtMs` in the `onConflictDoUpdate` set.

**Why it's wrong / failure scenario**
The comment (lines 233-236) says re-saving the same message id on crash-resume, deterministic replay, or fork/restore "must be a safe no-op upsert". But if the re-save omits `createdAtMs` (the field is optional in the signature), the conflict update stamps a NEW `nowMs()` onto the existing row — a replayed old message jumps to the end of `listMessages` (ordered by `createdAtMs`, line 272), corrupting conversation order and downstream summarization windows (Summarizer slices oldest-first).

**Expected behavior**
Exclude `createdAtMs` from the conflict-update set so the original insert timestamp is preserved — making the upsert actually idempotent as documented.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
