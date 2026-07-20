# 🐛 fix(db): [high] Postgres event/signal seq allocation can silently drop rows

GitHub: https://github.com/smithersai/smithers/issues/681

via /codex review (pass 2)

### File refs
- `packages/db/src/adapter.js:2208` and `packages/db/src/adapter.js:2524` serialize the fallback allocators with `acquireTransactionTurn()`, which is process-local.
- `packages/db/src/adapter.js:2234` / `packages/db/src/adapter.js:2553` read the current last signal/event seq, then `packages/db/src/adapter.js:2240` / `packages/db/src/adapter.js:2559` insert `seq = lastSeq + 1`.
- `packages/db/src/sql-message-storage.js:188` and `packages/db/src/sql-message-storage.js:285` make `(run_id, seq)` the primary key for signals/events.
- `packages/db/src/sql-message-storage.js:552` and `packages/db/src/sql-message-storage.js:993` implement `insertIgnore` as `ON CONFLICT DO NOTHING` and return no row count.

### Failure scenario
Two independent Smithers processes target the same Postgres/PGlite-backed run at the same time, for example a gateway process appending a live event while a CLI/MCP process submits a signal. Both enter the non-bun fallback allocator, both read the same current max `seq`, and both try to insert the same next `(run_id, seq)`. Postgres rejects one insert via `ON CONFLICT DO NOTHING`, but the adapter does not observe that and still returns the allocated `seq` to the caller.

The process-local turn only protects fibers sharing the same adapter object. It does not coordinate two gateway/CLI processes, and the fallback path only starts an explicit transaction when request-scoped txid capture is active.

### Why it matters
The loser event/signal is silently absent from the durable log while the caller believes it was written. Replay, live-stream catch-up, signal delivery, and crash resume all depend on `_smithers_events` / `_smithers_signals` being append-only and gap-free per run. This needs a backend-atomic allocator, such as a DB sequence/table lock/advisory lock, serializable retry loop, or an insert that detects conflict and retries instead of ignoring it.

