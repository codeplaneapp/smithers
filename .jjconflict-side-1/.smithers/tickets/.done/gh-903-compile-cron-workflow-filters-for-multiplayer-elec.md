# Compile cron workflow filters for multiplayer Electric

GitHub: https://github.com/smithersai/smithers/issues/903

Make the multiplayer crons collection honor CronListRequest.filter.workflow, using a validated workflow predicate or RPC fallback. Add a local/multiplayer parity test showing unrelated workflow schedules are excluded.


> Closed by ticket-fleet sync: Implemented in packages/gateway-client/src/data/createSmithersCollections.ts:281-289 via cronsWhere, wired into multiplayer Electric collections at lines 687-707, with RPC fallback for inexpressible workflow values. packages/gateway-client/tests/data/collectionsWhereFilters.test.ts:65-147 validates compilation, Electric wiring, and fallback; lines 197-275 seed unrelated schedules and verify local/multiplayer parity. Targeted package tests passed: 153 pass, 0 fail.
