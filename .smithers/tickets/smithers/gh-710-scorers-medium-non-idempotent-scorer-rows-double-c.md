# 🐛 scorers: [medium] non-idempotent scorer rows double-count aggregates after rewind/retry

GitHub: https://github.com/smithersai/smithers/issues/710

_via ultracode (Opus multi-agent) review_

## Summary
Persisted scorer rows have no durable-identity uniqueness, so re-executing a node (time-travel rewind, `retry-task`) writes duplicate rows that inflate every aggregate.

## Where
- `packages/scorers/src/run-scorers.js:200` — each row uses `id: crypto.randomUUID()` (fresh per write).
- `packages/db/src/adapter.js:3325` — `insertIgnore("_smithers_scorers", row)` can only ignore a collision on the never-colliding UUID.
- `packages/db/src/internal-schema/smithersScorers.js:4` and `packages/db/src/sql-message-storage.js:353` — `id` is the ONLY unique constraint; no unique index on `(run_id, node_id, iteration, attempt, scorer_id, source)`.
- No `DELETE FROM _smithers_scorers` exists anywhere. `packages/time-travel/src/jumpToFrame.js` deletes `_smithers_attempts` (219–225), resets nodes to pending (233–250), and deletes output rows (279–315) but never removes scorer rows; `retry-task.js` behaves the same.
- `packages/engine/src/engine.js:4597` fires `runScorersAsync` on every task finish.
- `packages/scorers/src/aggregate.js:33-56` groups only by `scorer_id`/`scorer_name`, filtered only by run_id/node_id/scorer_id — never by attempt/iteration.

## Failure scenario
Node N (iteration 0, attempt 0) with scorer S runs and writes a row. A time-travel rewind (`jumpToFrame`) or `retry-task` resets N's attempt/output/node state but leaves the scorer row on disk. N re-executes and `runScorersAsync` inserts a SECOND scorer row (new UUID; `insertIgnore` cannot dedup it). `aggregateScores` then computes `COUNT(*)`, `AVG`, MIN/MAX and in-memory p50/stddev over both rows for scorer S — the single logical score is counted twice, inflating count and skewing mean/p50/stddev.

## Why it matters
The rewind path's whole point is to discard the prior timeline (attempts and outputs are deleted), yet the scorer record — the one durable artifact — accumulates stale rows from the discarded execution. Every aggregate and any threshold gate reading it is silently corrupted, and `insertIgnore` gives false confidence that writes are idempotent. Fix: derive `id` from `(runId,nodeId,iteration,attempt,scorerId,source)` and add a matching unique index so re-writes become a real no-op (or delete prior scorer rows during rewind/retry reset).
