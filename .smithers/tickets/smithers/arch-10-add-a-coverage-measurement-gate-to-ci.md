# Add a coverage measurement + gate to CI

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#300](https://github.com/smithersai/smithers/issues/300)
> Priority: **P1** · decomposed from #300 (`.smithers/tickets/.epics/0047-audit-ci-architecture-systemic.md`)

## Task

**Finding (file: `.github/workflows/ci.yml:59`):** No coverage measurement or gate exists anywhere in CI, so the ~100% bar is unenforced. Wire workspace coverage collection into CI and add a threshold gate (start at the current measured baseline to avoid a red wall, ratcheting up).

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing code/test style and conventions in the same package; put any test beside the sibling tests for that file.
- Keep root `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one atomic emoji+conventional commit. Do not refactor unrelated code.
- If the task is genuinely too large to complete and keep the gate green in one focused change, do the largest safe, self-contained slice that is fully green and commit only that — never commit half-broken or stubbed work.

## Done when

- [ ] CI measures coverage and fails below a configured threshold; the threshold is set to a baseline that passes on current main.
