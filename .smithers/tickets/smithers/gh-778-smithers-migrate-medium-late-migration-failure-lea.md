# 🐛 smithers(migrate): [medium] late migration failure leaves a target that cannot be retried

GitHub: https://github.com/smithersai/smithers/issues/778

_via 2026-07 full-codebase audit_

## Summary

SQLite-to-PGlite/Postgres migration commits each table independently, but a retry rejects any non-empty target. A failure after the first commit leaves a partial destination that the same command cannot resume or restart.

## Where

- `packages/smithers/src/migrateSmithersStore.js:292-313 — non-empty targets are rejected`
- `packages/smithers/src/migrateSmithersStore.js:324-405 — each table commits independently`
- `packages/smithers/src/migrateSmithersStore.js:1184-1199 — later tables, indexes, and verification can still fail`

## Failure scenario / repro

Make an early table copy succeed and a later target insert fail. The first run leaves earlier rows committed; the identical retry immediately refuses the non-empty target. A throwing post-commit progress callback has the same result.

## Impact

A transient late failure requires manual database recovery and leaves an incomplete target without resumable status.

## Suggested fix

Use one migration-wide transaction where possible, or add a durable migration ID/checkpoint and idempotent resume/restart semantics. Keep callbacks outside commit boundaries.

## Tests

- Inject a late failure after an early table commits for PGlite and Postgres-wire paths
- Retry and assert rollback or successful resume
- Cover a throwing post-commit progress callback

## Dedupe notes

No matching issue or PR. Closed #549 covers backend-inference probing, not partial-copy retry.
