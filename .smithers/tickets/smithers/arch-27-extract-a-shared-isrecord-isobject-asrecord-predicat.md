# Extract a shared isRecord/isObject/asRecord predicate package

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#300](https://github.com/smithersai/smithers/issues/300)
> Priority: **P2** · decomposed from #300 (`.smithers/tickets/.epics/0047-audit-ci-architecture-systemic.md`)

## Task

**Finding (file: `(systemic)`):** The isRecord / isObject / asRecord predicate family is re-implemented across 7+ packages with divergent bodies, alongside 99 inline error-message extractions. Create one shared predicate utility and migrate at least the diverging copies to it (largest safe slice).

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing code/test style and conventions in the same package; put any test beside the sibling tests for that file.
- Keep root `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one atomic emoji+conventional commit. Do not refactor unrelated code.
- If the task is genuinely too large to complete and keep the gate green in one focused change, do the largest safe, self-contained slice that is fully green and commit only that — never commit half-broken or stubbed work.

## Done when

- [ ] A shared predicate utility exists and at least several packages import it instead of re-implementing; typecheck + affected tests green.
