# P0: convert one fabricated-schema fault case to a real-product e2e

> Target repo: **smithers** (this repo)
> Source: GitHub issue [#299](https://github.com/smithersai/smithers/issues/299)
> Priority: **P0** · multi-week umbrella — do ONE case per run

## Problem

~17 of the 30 `e2e/faults/` cases fabricate their own SQL schema and reimplement
the feature in-test, so they validate a mock of the contract, not the product
(`e2e/faults/case12-rewind-reverts-vcs.test.ts:160-221`, `case14-gateway-rpc-roundtrip.test.ts:196-485`, plus case03/04/05/07/10/11/13/17/18/24/26/27, etc.). This is genuinely multi-week e2e-infrastructure work — **do not attempt all of it in one pass.**

## Task (single case)

Pick **one** still-fabricated fault case (start with `case14-gateway-rpc-roundtrip` or `case12-rewind-reverts-vcs`) and rewrite it to drop the hand-rolled SQL schema + in-test feature reimplementation. Instead: stand up the **real** Gateway server + workspace DB the case targets (mirror the pattern in `case25-approval-scope-denial.test.ts`, which already boots the real gateway), seed deterministic real data, drive the actual RPC/rewind/reconnect product code path, and assert on real product behavior under fault injection. It must NOT re-introduce mocks (that re-introduces the exact defect flagged).

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing code/test style and conventions in the same package; put any test beside the sibling tests for that file.
- Keep root `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one atomic emoji+conventional commit. Do not refactor unrelated code.
- If the task is genuinely too large to complete and keep the gate green in one focused change, do the largest safe, self-contained slice that is fully green and commit only that — never commit half-broken or stubbed work.

## Done when

- [ ] Exactly one fault case is converted to boot real product infrastructure (no fabricated SQL schema, no in-test feature reimplementation).
- [ ] The converted case injects its fault against the real product path and asserts real behavior.
- [ ] `pnpm -C e2e test` (or `pnpm -C e2e test:faults`) passes for the converted case; root `pnpm typecheck` green.
