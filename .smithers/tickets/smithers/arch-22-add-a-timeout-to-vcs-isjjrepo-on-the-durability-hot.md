# Add a timeout to vcs isJjRepo on the durability hot path

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#300](https://github.com/smithersai/smithers/issues/300)
> Priority: **P2** · decomposed from #300 (`.smithers/tickets/.epics/0047-audit-ci-architecture-systemic.md`)

## Task

**Finding (file: `packages/vcs/src/jj.js:167-171 ; packages/engine/src/startDurability.js:84`):** isJjRepo runs on the durability-startup hot path with no timeout, while getJjPointer/captureWorkspaceSnapshot have one. Wrap isJjRepo with the same timeout policy so a hung jj cannot stall durability startup; add a test.

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing code/test style and conventions in the same package; put any test beside the sibling tests for that file.
- Keep root `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one atomic emoji+conventional commit. Do not refactor unrelated code.
- If the task is genuinely too large to complete and keep the gate green in one focused change, do the largest safe, self-contained slice that is fully green and commit only that — never commit half-broken or stubbed work.

## Done when

- [ ] isJjRepo has a bounded timeout consistent with the other jj calls; a test covers the timeout path; vcs tests + typecheck green.
