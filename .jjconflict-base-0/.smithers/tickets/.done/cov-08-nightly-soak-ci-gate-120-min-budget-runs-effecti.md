# Nightly soak CI gate (120-min budget) runs effectively one fabricated-transport test; cases 29 and 30 are permanently skipped

> Decomposed from #306 — test-coverage epic (`.smithers/tickets/.epics/0052-audit-test-coverage-gaps.md`)
> Resolved 2026-07-08: covered by e2e/faults/case28-soak-live-stream-rss.test.ts; e2e/faults/case29-soak-cron-2h-no-stuck.test.ts; e2e/faults/case30-soak-jjhub-long-lived.test.ts; .github/workflows/faults-nightly.yml (verified against this tree).
> Priority: P1
> Target: `e2e/faults/case28-soak-live-stream-rss.test.ts:4,86,212; e2e/faults/case29-soak-cron-2h-no-stuck.test.ts:7; e2e/faults/case30-soak-jjhub-long-lived.test.ts:7; .github/workflows/faults-nightly.yml`

## Task

Add the missing test coverage described below, then make it pass.

**Finding:** Nightly soak CI gate (120-min budget) runs effectively one fabricated-transport test; cases 29 and 30 are permanently skipped

**Detail:** Soak gate still effectively one fabricated-transport test; cases 29 and 30 remain skip-only stubs blocked on jjhub/0002

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing test style/conventions in the same package; put the test beside the sibling tests for that file.
- Keep `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one commit. Do not refactor unrelated code.

## Done when

- A test exists that exercises the cited code path/branch(es) against real behavior.
- The package's test suite and root typecheck pass.
