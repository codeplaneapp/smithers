# Obsolete: deleted sync connection observer transitions

> Decomposed from #306 — test-coverage epic (`.smithers/tickets/.epics/0052-audit-test-coverage-gaps.md`)
> Resolved 2026-07-08: covered by packages/gateway-client/tests/data/dataClientStream2.test.ts; packages/gateway-react/tests/collectionHooks.test.ts (verified against this tree).
> Priority: P2
> Status 2026-07-02: **obsolete**. The cited React sync connection observer
> stack was removed with the legacy sync provider. Replacement connection
> coverage is tracked through `SmithersDataClient` SSE state and
> `SmithersCollectionsProvider` local/multiplayer collection creation.
> Target: `packages/gateway-client/src/data/createSmithersDataClient.ts`;
> `packages/gateway-react/src/SmithersCollectionsProvider.ts`

## Task

Add the missing test coverage described below, then make it pass.

**Finding:** Obsolete sync connection observer transitions

**Detail:** `markConnecting`, `markOffline`, and `reconnectingSince` belonged to
the deleted sync observer. Do not add tests for the removed files; add any new
coverage against real SSE lifecycle behavior and provider creation in the
replacement TanStack DB collection surface.

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing test style/conventions in the same package; put the test beside the sibling tests for that file.
- Keep `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one commit. Do not refactor unrelated code.

## Done when

- A test exists that exercises the cited code path/branch(es) against real behavior.
- The package's test suite and root typecheck pass.
