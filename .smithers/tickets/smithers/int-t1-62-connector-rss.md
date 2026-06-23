# Tier 1 connector: RSS

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#222](https://github.com/smithersai/smithers/issues/222)
> Priority: **Tier 1 connector** (Universal triggers) · decomposed from #222

## Task

Add a curated, agent-callable **RSS** connector — i.e. a small set of ergonomic tools an agent can call (not a node a human drags), following the repo's integration substrate (MCP / `smithers openapi` / generic HTTP tool / scoped token broker).

RSS is a universal trigger — ship it early. Implement a real RSS poll/trigger tool that fetches and parses a feed and surfaces new items, with a real-feed test.

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing code/test style and conventions in the same package; put any test beside the sibling tests for that file.
- Keep root `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one atomic emoji+conventional commit. Do not refactor unrelated code.
- If the task is genuinely too large to complete and keep the gate green in one focused change, do the largest safe, self-contained slice that is fully green and commit only that — never commit half-broken or stubbed work.

## Done when

- [ ] A real RSS trigger/poll tool fetches + parses a feed and surfaces new items; a real-feed test covers it; typecheck + tests green.
