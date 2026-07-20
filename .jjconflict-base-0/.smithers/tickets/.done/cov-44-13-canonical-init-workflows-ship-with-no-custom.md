# 13 canonical init workflows ship with no custom UI (violates the 'every built-in workflow has a UI' bar)

> Decomposed from #306 — test-coverage epic (`.smithers/tickets/.epics/0052-audit-test-coverage-gaps.md`)
> Resolved 2026-07-08: covered by apps/cli/tests/workflow-pack-ui-coverage.test.js (verified against this tree).
> Priority: P2
> Target: `apps/cli/src/workflow-pack.js:1651 (UI_WORKFLOWS) vs the 30 workflows emitted by renderTemplateFiles`

## Task

Add the missing test coverage described below, then make it pass.

**Finding:** 13 canonical init workflows ship with no custom UI (violates the 'every built-in workflow has a UI' bar)

**Detail:** UI buildout substantial (17 UIs + all-UI e2e) but the bar is not fully met (23 templates vs 17 UIs) and is unguarded

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing test style/conventions in the same package; put the test beside the sibling tests for that file.
- Keep `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one commit. Do not refactor unrelated code.

## Done when

- A test exists that exercises the cited code path/branch(es) against real behavior.
- The package's test suite and root typecheck pass.
