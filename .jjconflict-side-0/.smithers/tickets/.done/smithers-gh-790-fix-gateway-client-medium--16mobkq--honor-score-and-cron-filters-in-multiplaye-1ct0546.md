# Honor score and cron filters in multiplayer collections

GitHub: https://github.com/smithersai/smithers/issues/1016

Parent: smithers/gh-790-fix-gateway-client-medium-multiplayer-coll-0w5zwp2.md

Context: Multiplayer scores ignore nodeId and crons ignore workflow, despite both fields participating in collection cache keys and RPC requests. Compile runId/nodeId and cron workflow into safe Electric predicates or fall back to RPC-backed collections. Acceptance criteria: scores return only the requested run and optional node; crons return only the requested workflow; local and multiplayer results match on a seeded multi-row dataset; regression tests cover filtered and unfiltered requests.


> Closed by ticket-fleet sync: Implemented in packages/gateway-client/src/data/createSmithersCollections.ts:261-288 and 648-707: scores compile run_id plus optional node_id, crons compile workflow_path predicates, and unsafe values fall back to RPC-backed collections. packages/gateway-client/tests/data/collectionsWhereFilters.test.ts:118-146 verifies collection wiring and fallback; lines 197-275 compare filtered and unfiltered Electric SQL results with local adapter results on seeded multi-row PGlite data. The targeted tests passed: 23 tests, 0 failures. packages/gateway-client typecheck also passed.
