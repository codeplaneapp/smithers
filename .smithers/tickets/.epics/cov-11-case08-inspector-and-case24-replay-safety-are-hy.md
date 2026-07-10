# case08 inspector and case24 replay-safety are hybrids: real predicate called against fabricated storage

> Decomposed from #306 — test-coverage epic (`.smithers/tickets/.epics/0052-audit-test-coverage-gaps.md`)
> Priority: P2
> Target: `e2e/faults/case08-inspector-never-idle.test.ts:3,62,277; e2e/faults/case24-replay-unsafe-approval.test.ts:3,189-248,443`

## Task

Add the missing test coverage described below, then make it pass.

**Finding:** case08 inspector and case24 replay-safety are hybrids: real predicate called against fabricated storage

**Detail:** case08 and case24 remain hybrids — real predicate against fabricated in-memory storage; not booted through the real product path

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing test style/conventions in the same package; put the test beside the sibling tests for that file.
- Keep `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one commit. Do not refactor unrelated code.

## Done when

- A test exists that exercises the cited code path/branch(es) against real behavior.
- The package's test suite and root typecheck pass.
