# Tier 2: agent-memory tool (Mem0/Zep over cross-run memory)

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#222](https://github.com/smithersai/smithers/issues/222)
> Priority: **Tier 2 primitive** · decomposed from #222

## Task

**Finding:** Smithers has internal cross-run memory, but the Mem0/Zep-style agent-memory TOOL primitive on top of it was not shipped for this catalog. Expose cross-run memory as an agent-callable tool (save/recall/forget facts) backed by the existing memory store, with real tests.

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing code/test style and conventions in the same package; put any test beside the sibling tests for that file.
- Keep root `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one atomic emoji+conventional commit. Do not refactor unrelated code.
- If the task is genuinely too large to complete and keep the gate green in one focused change, do the largest safe, self-contained slice that is fully green and commit only that — never commit half-broken or stubbed work.

## Done when

- [ ] Cross-run memory is exposed as an agent-callable save/recall tool backed by the real memory store; real tests cover it; typecheck + tests green.
