# No real-backend e2e: e2e.test.js mocks globalThis.fetch

> Decomposed from #306 — test-coverage epic (`.smithers/tickets/.epics/0052-audit-test-coverage-gaps.md`)
> Resolved 2026-07-08: covered by packages/openapi/tests/e2e.test.js (verified against this tree).
> Priority: P2
> Target: `packages/openapi/tests/e2e.test.js:4-22, packages/openapi/tests/execution.test.js, packages/openapi/tests/execution-escaping.test.js`

## Task

Add the missing test coverage described below, then make it pass.

**Finding:** No real-backend e2e: e2e.test.js mocks globalThis.fetch

**Detail:** No real-backend e2e against an actual HTTP server; e2e.test.js still mocks fetch

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing test style/conventions in the same package; put the test beside the sibling tests for that file.
- Keep `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one commit. Do not refactor unrelated code.

## Done when

- A test exists that exercises the cited code path/branch(es) against real behavior.
- The package's test suite and root typecheck pass.
