# Long tail: any OAuth SaaS action via Composio/Arcade/Nango catalog

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#222](https://github.com/smithersai/smithers/issues/222)
> Priority: **Long tail** · decomposed from #222

## Task

**Finding:** Not implemented; blocked on the missing delegated-OAuth plane. Once the credentials plane exists (int-t0-02), wire one catalog provider (Composio/Arcade/Nango) so arbitrary OAuth SaaS toolkits are agent-callable. If the OAuth plane is not yet present, implement the catalog adapter against the vault abstraction interface only (no live OAuth), fully typed + unit-tested.

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing code/test style and conventions in the same package; put any test beside the sibling tests for that file.
- Keep root `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one atomic emoji+conventional commit. Do not refactor unrelated code.
- If the task is genuinely too large to complete and keep the gate green in one focused change, do the largest safe, self-contained slice that is fully green and commit only that — never commit half-broken or stubbed work.

## Done when

- [ ] A catalog-provider adapter exists against the credentials/vault interface (live if the plane is ready, else interface-level + unit-tested); typecheck + tests green.
