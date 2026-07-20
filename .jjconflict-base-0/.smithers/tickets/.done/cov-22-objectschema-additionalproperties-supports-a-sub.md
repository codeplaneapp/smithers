# objectSchema(additionalProperties) supports a sub-schema type per JsonSchema, but no definition ever uses it and the OpenAPI generator/validator paths for it are untested

> Decomposed from #306 — test-coverage epic (`.smithers/tickets/.epics/0052-audit-test-coverage-gaps.md`)
> Resolved 2026-07-08: covered by packages/gateway/tests/rpc-contract.test.ts (verified against this tree).
> Priority: P2
> Target: `packages/gateway/src/rpc/index.ts:276-287`

## Task

Add the missing test coverage described below, then make it pass.

**Finding:** objectSchema(additionalProperties) supports a sub-schema type per JsonSchema, but no definition ever uses it and the OpenAPI generator/validator paths for it are untested

**Detail:** The objectSchema additionalProperties sub-schema path is still unused, and the generator/validator paths for it are untested

## Rules (non-negotiable — this repo's "No mocks" policy)

- Use **real backends/data**. Do NOT introduce `mockGateway`, `page.route`/`routeWebSocket` data fabrication, hand-rolled SQL schema, or hardcoded/fallback stand-ins. A test that mocks the thing it claims to exercise does not count.
- Follow the existing test style/conventions in the same package; put the test beside the sibling tests for that file.
- Keep `pnpm typecheck` green and the touched package's `bun test` green (`pnpm -C <pkg> test`).
- Scope to THIS finding only — one focused change, one commit. Do not refactor unrelated code.

## Done when

- A test exists that exercises the cited code path/branch(es) against real behavior.
- The package's test suite and root typecheck pass.
