# Back <Sandbox> with a managed cloud sandbox (E2B/Daytona/Modal)

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#222](https://github.com/smithersai/smithers/issues/222)
> Priority: **Tier 0 substrate** · decomposed from #222 (`.smithers/tickets/.epics/0056-integrations-tool-catalog.md`)

## Task

**Finding:** The <Sandbox> primitive + provider abstraction exist, but no managed cloud sandbox backing (E2B / Daytona / Modal) is implemented. Add a real provider implementation behind the existing <Sandbox> abstraction for one provider (e.g. E2B), with a real-backend integration test gated on credentials being present (skip cleanly otherwise).

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing code/test style and conventions in the same package; put any test beside the sibling tests for that file.
- Keep root `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one atomic emoji+conventional commit. Do not refactor unrelated code.
- If the task is genuinely too large to complete and keep the gate green in one focused change, do the largest safe, self-contained slice that is fully green and commit only that — never commit half-broken or stubbed work.

## Done when

- [ ] One managed cloud sandbox provider backs <Sandbox> behind the existing abstraction; a credential-gated real test covers it; typecheck + tests green.
