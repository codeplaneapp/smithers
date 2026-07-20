# Retargeted: SmithersDataClient SSE error/auth/reconnect branches

> Decomposed from #306 — test-coverage epic (`.smithers/tickets/.epics/0052-audit-test-coverage-gaps.md`)
> Resolved 2026-07-08: covered by packages/gateway-client/tests/data/dataClientStreamError.test.ts; packages/gateway-client/tests/data/collectionsCoverage.test.ts (verified against this tree).
> Priority: P2
> Status 2026-07-02: **retargeted**. The cited `createGatewayCollection`
> sync stack was removed. Replacement coverage belongs on
> `packages/gateway-client/src/data/createSmithersDataClient.ts` and
> `packages/gateway-client/src/data/createSmithersCollections.ts`, covering
> `/v1/api/stream` reconnect behavior, auth failures, reset frames, and
> invalidation re-pull through TanStack DB collections.
> Target: `packages/gateway-client/src/data/createSmithersDataClient.ts`;
> `packages/gateway-client/src/data/createSmithersCollections.ts`

## Task

Add the missing test coverage described below, then make it pass.

**Finding:** Retargeted SmithersDataClient SSE error/auth/reconnect branches

**Detail:** the deleted sync collection's onError/reconnect branches no longer
exist. Keep this ticket open only for the replacement surface: real
`SmithersDataClient` `/v1/api/stream` reconnect/auth handling and the resulting
collection invalidation behavior.

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing test style/conventions in the same package; put the test beside the sibling tests for that file.
- Keep `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one commit. Do not refactor unrelated code.

## Done when

- A test exists that exercises the cited code path/branch(es) against real behavior.
- The package's test suite and root typecheck pass.
