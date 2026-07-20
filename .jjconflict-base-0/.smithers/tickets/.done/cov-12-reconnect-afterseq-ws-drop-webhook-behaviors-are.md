# Reconnect-afterSeq / ws-drop / webhook behaviors are fabricated in e2e/faults but exist as real (non-e2e) tests elsewhere — duplicate-but-fake instead of promoting the real ones

> Decomposed from #306 — test-coverage epic (`.smithers/tickets/.epics/0052-audit-test-coverage-gaps.md`)
> Resolved 2026-07-08: covered by e2e/faults/case09-reconnect-afterseq.test.ts; e2e/faults/case15-ws-drop-reconnect.test.ts; e2e/faults/case17-webhook-bad-signature.test.ts (verified against this tree).
> Priority: P2
> Target: `e2e/faults/case09-reconnect-afterseq.test.ts; case15-ws-drop-reconnect.test.ts; case17-webhook-bad-signature.test.ts; e2e/budgets/latency.json`

## Task

Add the missing test coverage described below, then make it pass.

**Finding:** Reconnect-afterSeq / ws-drop / webhook behaviors are fabricated in e2e/faults but exist as real (non-e2e) tests elsewhere — duplicate-but-fake instead of promoting the real ones

**Detail:** case09 and case15 reconnect/ws-drop behaviors are still fabricated in e2e/faults rather than promoting the real non-e2e tests

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing test style/conventions in the same package; put the test beside the sibling tests for that file.
- Keep `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one commit. Do not refactor unrelated code.

## Done when

- A test exists that exercises the cited code path/branch(es) against real behavior.
- The package's test suite and root typecheck pass.
