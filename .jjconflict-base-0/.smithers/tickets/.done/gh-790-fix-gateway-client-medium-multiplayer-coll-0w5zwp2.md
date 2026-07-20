# 🐛 fix(gateway-client): [medium] multiplayer collections ignore request filters and expose ticket tombstones

GitHub: https://github.com/smithersai/smithers/issues/790

_via 2026-07 full-codebase audit_

## Summary

Collection request fields participate in cache keys but are not translated into equivalent Electric predicates. Several multiplayer collections return rows excluded by their matching RPC contract.

## Where

- `packages/gateway-client/src/data/createSmithersCollections.ts:297-305 — run filters ignored`
- `packages/gateway-client/src/data/createSmithersCollections.ts:349-357 — approval filters ignored`
- `packages/gateway-client/src/data/createSmithersCollections.ts:394-443 — doc, score, ticket, and cron filters diverge`

## Failure scenario / repro

Examples include scores for every node despite a nodeId filter, deleted ticket rows presented as live, omitted ticket kind forced to ticket, and workflow/status filters ignored.

## Impact

Local and multiplayer modes return different or deleted/cross-workflow data for the same public API.

## Suggested fix

Compile every supported request field into validated Electric predicates, enforce live-row conditions, and fall back to RPC-backed query collections when Electric cannot represent semantics safely.

## Tests

- Seed one dataset and assert local/multiplayer parity for every documented filter
- Cover omitted/explicit ticket kind and tombstones

## Dedupe notes

No matching issue in the live corpus.


> Closed by ticket-fleet sync: Implemented in packages/gateway-client/src/data/createSmithersCollections.ts:179-289 and wired at lines 497-707. Tests in collectionsFilterParity.test.ts, collectionsDocsTicketsParity.test.ts, and collectionsWhereFilters.test.ts cover predicate parity, tombstones, ticket kinds, fallbacks, and Electric wiring. `pnpm -C packages/gateway-client test` passes 153 tests; package typecheck also passes.
