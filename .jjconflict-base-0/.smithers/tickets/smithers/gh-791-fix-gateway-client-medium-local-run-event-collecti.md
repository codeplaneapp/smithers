# 🐛 fix(gateway-client): [medium] local run-event collections stop advancing after 10,000 rows

GitHub: https://github.com/smithersai/smithers/issues/791

_via 2026-07 full-codebase audit_

## Summary

The local run-event collection always requests the first 10,000 ascending events and then keeps the tail of that page. Runs beyond 10,000 refetch the same old page forever.

## Where

- `packages/gateway-client/src/data/createSmithersCollections.ts:57-58 — fixed 10,000 fetch size`
- `packages/gateway-client/src/data/createSmithersCollections.ts:482-493 — no cursor/tail semantics`
- `packages/db/src/sql-message-storage.js:1077-1083 — ORDER BY seq ASC LIMIT`

## Failure scenario / repro

Seed seq 0..10000. The collection receives 0..9999 and never observes seq 10000 or anything later, even after invalidation.

## Impact

Long-lived workflows silently stop updating in collection-backed UIs while the run continues.

## Suggested fix

Add an explicit newest/tail query or page from the last observed sequence. Preserve ascending presentation and the memory bound.

## Tests

- Seed at least 10,001 real events and assert the latest is present
- Add another event, invalidate, and assert max sequence advances

## Dedupe notes

#750 covers seq 0 and #698 covers TUI ring eviction, not this first-page ceiling.
