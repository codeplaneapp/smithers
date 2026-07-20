# Honor run and approval filters in multiplayer collections

GitHub: https://github.com/smithersai/smithers/issues/1014

Parent: smithers/gh-790-fix-gateway-client-medium-multiplayer-coll-0w5zwp2.md

Context: Electric-backed runs and approvals collections do not match their RPC filters. Implement validated predicates for status/workflow/runId where safe, and use RPC-backed query collections when limit or other semantics cannot be represented safely. Acceptance criteria: multiplayer and local collections return identical rows for every documented run and approval filter; status, workflow, runId, and limit are enforced; regression tests use a seeded dataset and verify excluded rows are absent.


> Closed by ticket-fleet sync: Implemented by commit 4d3df0227f. createSmithersCollections.ts lines 159-208 validate and compile run status and approval runId predicates, while lines 536-613 route workflow, limit, and unsafe filters through RPC-backed query collections. collectionsFilterParity.test.ts seeds PGlite rows, compares Electric and RPC results, verifies excluded statuses, decided approvals, and unrelated run IDs are absent, and checks workflow/limit forwarding and local parity. The gateway-client suite passed 153 tests; package typecheck also passed.
