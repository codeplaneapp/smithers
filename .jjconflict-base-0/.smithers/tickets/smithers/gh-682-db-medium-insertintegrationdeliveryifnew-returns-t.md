# 🐛 db: [medium] insertIntegrationDeliveryIfNew returns true for the Postgres ON CONFLICT loser — duplicate delivery despite its dedupe contract

GitHub: https://github.com/smithersai/smithers/issues/682

_via ultracode review — hand-verified (codex pass-2's auto-dedup false-flagged this as #667; it is distinct)_

## Summary
`insertIntegrationDeliveryIfNew` promises (JSDoc, `adapter.js:3210`) that "concurrent redeliveries cannot both claim 'first'". On **Postgres** it can: two concurrent transactions both return `true` for the same `(source_id, dedupe_key)`, so the same external event is delivered twice. SQLite is unaffected.

## Root cause
- `packages/db/src/adapter.js:3216` wraps the check-then-insert in `withTransactionEffect`.
- `packages/db/src/adapter.js:3217-3222` — `SELECT ... WHERE source_id=? AND dedupe_key=?`; returns `false` only if a row is **already visible**.
- `packages/db/src/adapter.js:3223-3229` — otherwise `insertIgnore(...)` then unconditionally `return true`, **without checking whether the insert actually inserted a row**.
- `packages/db/src/dialect.js:179-181` — `beginTransactionSql` uses plain `BEGIN` on Postgres (READ COMMITTED) vs `BEGIN IMMEDIATE` (write lock) on SQLite.
- `insertIgnore` compiles to `INSERT ... ON CONFLICT DO NOTHING` on Postgres (`sql-message-storage.js` ~552/993), which silently no-ops on conflict instead of erroring.

## Failure scenario (Postgres backend)
1. Two Smithers processes (or two gateway workers) receive the same webhook/integration redelivery concurrently, sharing one Postgres DB.
2. Under READ COMMITTED, both transactions run the `SELECT` before either commits — both see no existing row.
3. Both call `insertIgnore`. One inserts; the other conflicts and does nothing — **but does not raise**.
4. Both `insertIntegrationDeliveryIfNew` calls `return true`, so both callers treat themselves as the first delivery and both fire downstream side effects (duplicate `signalRun`, duplicate workflow resume, duplicate external action).

On SQLite, `BEGIN IMMEDIATE` serializes the two writers, so the second sees the committed row and correctly returns `false` — hence this is a Postgres-only correctness divergence.

## Why it matters
This helper is the idempotency gate for integration delivery; its explicit contract is exactly the concurrent-redelivery case it fails. The bug is invisible on the default local (sqlite/PGlite single-connection) backends and only manifests on the multi-process Postgres deployments the control plane targets.

## Fix direction
Make the insert authoritative rather than the prior SELECT: `INSERT ... ON CONFLICT DO NOTHING RETURNING 1` on Postgres (return `true` only when a row is returned) and an affected-rows check on SQLite/PGlite; or run this transaction at SERIALIZABLE isolation with a retry path.

