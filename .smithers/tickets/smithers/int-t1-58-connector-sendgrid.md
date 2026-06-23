# Tier 1 connector: SendGrid

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#222](https://github.com/smithersai/smithers/issues/222)
> Priority: **Tier 1 connector** (Marketing & transactional email) · decomposed from #222

## Task

Add a curated, agent-callable **SendGrid** connector — i.e. a small set of ergonomic tools an agent can call (not a node a human drags), following the repo's integration substrate (MCP / `smithers openapi` / generic HTTP tool / scoped token broker).

Prefer building on the existing substrate (e.g. `smithers openapi` over SendGrid's REST API, or the generic HTTP tool) rather than a bespoke SDK. Connectors that need delegated user OAuth are blocked on the connection/credentials plane ([`int-t0-02`]); if so, implement the parts that work with a static API token/key now and clearly mark the OAuth-dependent surface as deferred. Add a real-backend test gated on credentials (skip cleanly when absent).

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing code/test style and conventions in the same package; put any test beside the sibling tests for that file.
- Keep root `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one atomic emoji+conventional commit. Do not refactor unrelated code.
- If the task is genuinely too large to complete and keep the gate green in one focused change, do the largest safe, self-contained slice that is fully green and commit only that — never commit half-broken or stubbed work.

## Done when

- [ ] A curated SendGrid connector exposes at least one real agent-callable tool built on the integration substrate; a credential-gated real test covers it (skips cleanly without creds); typecheck + tests green.
- [ ] OAuth-dependent surface (if any) is cleanly deferred to the credentials plane, not stubbed/mocked.
