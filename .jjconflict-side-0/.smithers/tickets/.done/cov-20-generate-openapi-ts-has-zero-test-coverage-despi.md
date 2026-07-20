# generate-openapi.ts has zero test coverage despite emitting the published contract artifact and shipping in `files`

> Decomposed from #306 — test-coverage epic (`.smithers/tickets/.epics/0052-audit-test-coverage-gaps.md`)
> Resolved 2026-07-08: covered by packages/gateway/tests/generate-openapi.test.ts (verified against this tree).
> Priority: P2
> Target: `packages/gateway/scripts/generate-openapi.ts:1-265`

## Task

Add the missing test coverage described below, then make it pass.

**Finding:** generate-openapi.ts has zero test coverage despite emitting the published contract artifact and shipping in `files`

**Detail:** scripts/generate-openapi.ts still has zero test coverage

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing test style/conventions in the same package; put the test beside the sibling tests for that file.
- Keep `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one commit. Do not refactor unrelated code.

## Done when

- A test exists that exercises the cited code path/branch(es) against real behavior.
- The package's test suite and root typecheck pass.
