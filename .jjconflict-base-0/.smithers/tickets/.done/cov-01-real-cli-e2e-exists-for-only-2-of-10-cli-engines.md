# Real-CLI e2e exists for only 2 of 10 CLI engines (OpenCode, Vibe); the other 8 are proven only via fake-binary subprocess tests

> Decomposed from #306 — test-coverage epic (`.smithers/tickets/.epics/0052-audit-test-coverage-gaps.md`)
> Priority: P2
> Target: `packages/agents/tests/opencode-e2e.test.js, packages/agents/tests/vibe-agent-e2e.test.js`

## Task

Add the missing test coverage described below, then make it pass.

**Finding:** Real-CLI e2e exists for only 2 of 10 CLI engines (OpenCode, Vibe); the other 8 are proven only via fake-binary subprocess tests

**Detail:** No real-CLI e2e added for the other 8 engines (amp, antigravity, claude, codex, gemini, forge, pi, kimi/hermes); they remain fake-binary subprocess only

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing test style/conventions in the same package; put the test beside the sibling tests for that file.
- Keep `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one commit. Do not refactor unrelated code.

## Done when

- A test exists that exercises the cited code path/branch(es) against real behavior.
- The package's test suite and root typecheck pass.
