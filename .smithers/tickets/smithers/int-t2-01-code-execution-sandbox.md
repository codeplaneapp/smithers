# Tier 2: code-execution sandbox (write-run-observe behind <Sandbox>)

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#222](https://github.com/smithersai/smithers/issues/222)
> Priority: **Tier 2 primitive** · decomposed from #222

## Task

**Finding:** The Sandbox primitive exists but the differentiated managed-cloud code-execution backing (E2B/Daytona/Modal) with a write-run-observe loop is not implemented. Implement the write-run-observe loop on top of the managed sandbox backing (coordinate with int-t0-01).

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing code/test style and conventions in the same package; put any test beside the sibling tests for that file.
- Keep root `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one atomic emoji+conventional commit. Do not refactor unrelated code.
- If the task is genuinely too large to complete and keep the gate green in one focused change, do the largest safe, self-contained slice that is fully green and commit only that — never commit half-broken or stubbed work.

## Done when

- [ ] A write-run-observe code-execution loop works on top of a managed sandbox backing; a credential-gated real test covers it; typecheck + tests green.
