# Six fault cases are empty skip-only stubs — entire feature areas have zero fault/e2e coverage

> Decomposed from #306 — test-coverage epic (`.smithers/tickets/.epics/0052-audit-test-coverage-gaps.md`)
> Priority: P1
> Target: `e2e/faults/case19,case20,case21,case22 (each line 5-7); e2e/faults/case02-kill-sandbox-engine-alive.test.ts:189`

## Task

Add the missing test coverage described below, then make it pass.

**Finding:** Six fault cases are empty skip-only stubs — entire feature areas have zero fault/e2e coverage

**Detail:** Six fault cases (19,20,21,22 + case02 dual-heartbeat + the soak stubs) remain empty skip-only stubs

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing test style/conventions in the same package; put the test beside the sibling tests for that file.
- Keep `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one commit. Do not refactor unrelated code.

## Done when

- A test exists that exercises the cited code path/branch(es) against real behavior.
- The package's test suite and root typecheck pass.
