# Retargeted: SmithersDataClient auth-error SSE branches

> Decomposed from #306 — test-coverage epic (`.smithers/tickets/.epics/0052-audit-test-coverage-gaps.md`)
> Resolved 2026-07-08: covered by packages/gateway-client/tests/data/dataClientStream2.test.ts; packages/gateway-client/tests/data/dataClientApi.test.ts (verified against this tree).
> Priority: P2
> Status 2026-07-02: **retargeted**. The cited React sync `isAuthError`
> helper was removed with the legacy sync stack. Replacement coverage belongs
> on the current `SmithersDataClient` HTTP/SSE auth handling and how
> `createSmithersCollections` responds to authenticated local-mode failures.
> Target: `packages/gateway-client/src/data/createSmithersDataClient.ts`;
> `packages/gateway-client/src/data/createSmithersCollections.ts`

## Task

Add the missing test coverage described below, then make it pass.

**Finding:** Retargeted auth-error handling for SmithersDataClient

**Detail:** do not add tests for the deleted `isAuthError` helper. Cover real
401/403 and auth-code failures through the replacement `SmithersDataClient`
request/stream paths and assert the resulting collection lifecycle behavior.

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing test style/conventions in the same package; put the test beside the sibling tests for that file.
- Keep `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one commit. Do not refactor unrelated code.

## Done when

- A test exists that exercises the cited code path/branch(es) against real behavior.
- The package's test suite and root typecheck pass.
