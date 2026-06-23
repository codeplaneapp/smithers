# Stop openapi committed d.ts drift; point subpath types at real declarations

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#300](https://github.com/smithersai/smithers/issues/300)
> Priority: **P2** · decomposed from #300 (`.smithers/tickets/.epics/0047-audit-ci-architecture-systemic.md`)

## Task

**Finding (file: `packages/openapi/package.json:7-23 ; packages/openapi/src/index.d.ts ; packages/openapi/tsup.config.ts`):** The generated openapi index.d.ts is committed and can drift; the `./*` and `./metrics` subpaths point their types at the full bundle. Add a drift guard and/or point subpath types at correct per-subpath declarations.

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing code/test style and conventions in the same package; put any test beside the sibling tests for that file.
- Keep root `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one atomic emoji+conventional commit. Do not refactor unrelated code.
- If the task is genuinely too large to complete and keep the gate green in one focused change, do the largest safe, self-contained slice that is fully green and commit only that — never commit half-broken or stubbed work.

## Done when

- [ ] openapi subpath types resolve to correct declarations and a guard fails on committed-d.ts drift; passes on current main.
