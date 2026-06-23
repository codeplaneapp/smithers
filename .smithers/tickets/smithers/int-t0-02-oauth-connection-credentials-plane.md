# Delegated per-user OAuth connection/credentials plane

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#222](https://github.com/smithersai/smithers/issues/222)
> Priority: **Tier 0 substrate** · decomposed from #222 (`.smithers/tickets/.epics/0056-integrations-tool-catalog.md`)

## Task

**Finding:** THE load-bearing gap: no delegated per-user OAuth (auth-code + PKCE), no encrypted credential storage, no single-flight refresh, no per-tenant scoping. accounts.json is plaintext and AccountProvider is a closed union of LLM engines. Design + implement the connection/credentials plane (or a thin vault abstraction over Nango/Composio/Arcade). This is a large, hand-designed change — do the largest safe, fully-green slice (e.g. the encrypted-storage + refresh abstraction first).

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing code/test style and conventions in the same package; put any test beside the sibling tests for that file.
- Keep root `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one atomic emoji+conventional commit. Do not refactor unrelated code.
- If the task is genuinely too large to complete and keep the gate green in one focused change, do the largest safe, self-contained slice that is fully green and commit only that — never commit half-broken or stubbed work.

## Done when

- [ ] A connection/credentials abstraction exists with encrypted storage and single-flight refresh (at minimum); typecheck + tests green; no plaintext regression.
