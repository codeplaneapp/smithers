# Retargeted: SSE invalidation re-pull of TanStack DB collections

> Decomposed from #306 — test-coverage epic (`.smithers/tickets/.epics/0052-audit-test-coverage-gaps.md`)
> Priority: P2
> Status 2026-07-02: **retargeted**. The legacy pulser-backed
> `createGatewayCollections` file was removed. Replacement coverage belongs on
> canonical `/v1/api/stream` collection-name invalidation and TanStack DB
> re-pull in `createSmithersCollections`.
> Target: `packages/gateway-client/src/data/createSmithersCollections.ts`;
> `packages/server/src/gateway.js`

## Task

Add the missing test coverage described below, then make it pass.

**Finding:** Retargeted SSE invalidation re-pull for pollable collections

**Detail:** the pulser path no longer exists. The current requirement is that
server-emitted canonical collection names (`runs`, `run_events`, `nodes`,
`node_outputs`, `approvals`, `crons`, `tickets`, `docs`) invalidate only the
matching TanStack DB collection prefixes, causing affected local-mode
collections to re-pull without falling back to a root-wide refresh.

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing test style/conventions in the same package; put the test beside the sibling tests for that file.
- Keep `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one commit. Do not refactor unrelated code.

## Done when

- A test exists that exercises the cited code path/branch(es) against real behavior.
- The package's test suite and root typecheck pass.
