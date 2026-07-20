# Implement transactional recursive cancellation for run subtrees

GitHub: https://github.com/smithersai/smithers/issues/971

Parent: smithers/gh-884-implement-cascading-cancellation-and-orphan-proces.md

Context: Run rows already store parentRunId, but cancellation currently updates only the requested run and the available ancestry query walks upward. Implement a public cancellation operation that resolves a root run and every recursive descendant.

Acceptance criteria:
- A single idempotent SQLite/Postgres operation covers the root and all descendants, with cycle and depth protection.
- Live, waiting-approval, waiting-event, waiting-timer, waiting-quota, paused, stale, and ownerless descendants are handled correctly; terminal rows are not regressed.
- Active descendants receive durable cancel requests, while parked/stale descendants converge to cancelled with consistent attempts, timer state, owners, heartbeats, and RunCancelled/TimerCancelled events.
- Public HTTP/RPC cancellation uses this operation and returns a complete cancellation result without affecting unrelated runs.
