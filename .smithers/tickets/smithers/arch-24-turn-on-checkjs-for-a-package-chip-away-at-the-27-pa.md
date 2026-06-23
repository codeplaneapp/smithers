# Turn on checkJs for a package (chip away at the 27-package gap)

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#300](https://github.com/smithersai/smithers/issues/300)
> Priority: **P1** · decomposed from #300 (`.smithers/tickets/.epics/0047-audit-ci-architecture-systemic.md`)

## Task

**Finding (file: `tsconfig (per package)`):** checkJs is off in all but 1 package: 831 .js source files (503 with JSDoc types) ship unverified types. Turn on checkJs for ONE package, fix the type errors it surfaces, and keep it green. Do not attempt all 27 in one pass.

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing code/test style and conventions in the same package; put any test beside the sibling tests for that file.
- Keep root `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one atomic emoji+conventional commit. Do not refactor unrelated code.
- If the task is genuinely too large to complete and keep the gate green in one focused change, do the largest safe, self-contained slice that is fully green and commit only that — never commit half-broken or stubbed work.

## Done when

- [ ] checkJs is enabled for one previously-unchecked package and that package + root typecheck are green.
