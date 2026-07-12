# Fix multiplayer ticket kind defaults and tombstones

GitHub: https://github.com/smithersai/smithers/issues/902

Make the multiplayer tickets collection match ListTicketsRequest semantics: omitted kind must list every kind, explicit kind must filter that kind, and soft-deleted docs must never appear. Add tests for omitted and explicit kinds and for deleted ticket rows.


> Closed by ticket-fleet sync: packages/gateway-client/src/data/createSmithersCollections.ts:235-242 makes omitted kind return deleted_at_ms IS NULL and explicit kind add kind filtering; lines 669-676 wire this predicate into multiplayer tickets. packages/gateway-client/tests/data/collectionsDocsTicketsParity.test.ts:100-121 verifies omitted kinds, explicit ticket/plan kinds, seeded tombstones, and soft-deletion parity against the real pglite-backed adapter. Lines 141-144 assert the compiled predicates directly. The package test suite passed: 153 tests, 0 failures.
