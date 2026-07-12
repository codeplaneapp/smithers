# Persist cancellation attribution on run records

GitHub: https://github.com/smithersai/smithers/issues/1119

Parent: smithers/gh-1063-record-gateway-rpc-cancellation-attribution.md

Context: Run cancellation persistence currently records only cancelRequestedAtMs, so later readers cannot identify who or which request initiated cancellation. Acceptance criteria: add nullable, migration-safe run-record fields for cancellation request ID, transport/source, client identity where available, and client PID when known; update RunRow, validation, adapter APIs, and database migrations; preserve nulls for legacy cancellations; add database persistence tests.
