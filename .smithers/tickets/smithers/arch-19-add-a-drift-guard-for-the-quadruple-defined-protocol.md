# Add a drift guard for the quadruple-defined protocol error contract

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#300](https://github.com/smithersai/smithers/issues/300)
> Priority: **P1** · decomposed from #300 (`.smithers/tickets/.epics/0047-audit-ci-architecture-systemic.md`)

## Task

**Finding (file: `packages/protocol/src/errors/index.js ; src/errors.ts ; src/errors/*.ts ; src/index.d.ts`):** The protocol error contract is defined four times (runtime .js arrays, a second runtime+type copy in errors.ts, type unions in errors/*.ts, and the generated index.d.ts) with no drift guard. Add a test that asserts the runtime arrays and the type unions agree, so they cannot silently diverge.

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing code/test style and conventions in the same package; put any test beside the sibling tests for that file.
- Keep root `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one atomic emoji+conventional commit. Do not refactor unrelated code.
- If the task is genuinely too large to complete and keep the gate green in one focused change, do the largest safe, self-contained slice that is fully green and commit only that — never commit half-broken or stubbed work.

## Done when

- [ ] A test fails when the runtime error arrays and the type-union copies disagree; it passes on current main.
