# Split the 6,439-line apps/cli/src/index.js monolith

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#300](https://github.com/smithersai/smithers/issues/300)
> Priority: **P2** · decomposed from #300 (`.smithers/tickets/.epics/0047-audit-ci-architecture-systemic.md`)

## Task

**Finding (file: `apps/cli/src/index.js`):** index.js is a 6,439-line monolith mixing argv parsing, ~60 command bodies, MCP wiring, and helpers. No extraction has been performed; it has grown larger. Extract a cohesive, self-contained slice (e.g. one command group, or the MCP wiring, or the argv layer) into its own module with no behavior change.

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing code/test style and conventions in the same package; put any test beside the sibling tests for that file.
- Keep root `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one atomic emoji+conventional commit. Do not refactor unrelated code.
- If the task is genuinely too large to complete and keep the gate green in one focused change, do the largest safe, self-contained slice that is fully green and commit only that — never commit half-broken or stubbed work.

## Done when

- [ ] A cohesive slice is extracted into its own module(s); `apps/cli` tests + root typecheck stay green; no behavior change.
