# Add a CI drift guard for the 28 committed generated index.d.ts files

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#300](https://github.com/smithersai/smithers/issues/300)
> Priority: **P1** · decomposed from #300 (`.smithers/tickets/.epics/0047-audit-ci-architecture-systemic.md`)

## Task

**Finding (file: `(systemic)`):** 28 packages commit a generated bundled src/index.d.ts that ships as the exports `types` and can drift; a drift guard exists only at publish, not in CI. Add a single CI check that regenerates and diffs all committed generated d.ts files (fail on drift).

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing code/test style and conventions in the same package; put any test beside the sibling tests for that file.
- Keep root `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one atomic emoji+conventional commit. Do not refactor unrelated code.
- If the task is genuinely too large to complete and keep the gate green in one focused change, do the largest safe, self-contained slice that is fully green and commit only that — never commit half-broken or stubbed work.

## Done when

- [ ] A CI check fails when any committed generated index.d.ts drifts from regenerated output; passes on current main.
