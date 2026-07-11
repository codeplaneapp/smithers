# Docs pipeline and LLM bundles

> **Status:** Partial | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Learn & integrate | **Tier:** Reference

Mintlify docs, generated `API/reference` material, llms-\*.txt bundles, docs checks, and public-surface coverage tests keep human and agent documentation in sync with the published packages.

## What you can do

Read current docs as a human, or hand compact LLM bundles to agents so they use the real public API.

## Capabilities

### Mintlify docs

docs/ contains install, quickstart, concepts, components, workflows, integrations, deployment, RPC, and reference pages.

### LLM bundles

scripts generate llms.txt, llms-full.txt, and opt-in fragments for core, events, memory, openapi, observability, integrations, and Effect.

### Coverage gates

check-docs, check-llms, docs-public-surface-coverage, docs-cli-overview-coverage, and docs examples smoke tests catch drift.

## Endpoints and commands

- `CLI smithers docs` ([docs](docs/cli/overview.mdx))
- `CLI smithers docs-full` ([docs](docs/cli/overview.mdx))
- `SCRIPT pnpm docs:llms` ([docs](README.md))

## Related docs

- [Docs index](docs/index.mdx)
- [LLMS](docs/llms.txt)
- [Full LLMS](docs/llms-full.txt)

## Test cases

- `scripts/check-docs.mjs`
- `scripts/check-llms.mjs`
- `apps/cli/tests/docs-command.test.js`
- `apps/cli/tests/docs-cli-overview-coverage.test.js`
- `apps/cli/tests/docs-public-surface-coverage.test.js`
- `apps/cli/tests/docs-examples-smoke.test.js`
- `apps/cli/tests/docs-watch-and-steer.test.js`

## Observability

- Docs checks fail CI on drift rather than emitting runtime telemetry.
- CLI docs commands expose concise and full bundles for agent consumption.

## Debugging

- After docs changes, run `pnpm docs:llms`, then `pnpm test or the specific check-docs/check-llms scripts`.
- Use docs-public-surface-coverage tests when adding package exports or CLI commands.

## Architecture

- `package.json` test script gates check-docs, check-llms, check-sota, check-dts, and `pnpm -r test`.
- docs/ contains the source docs; package `docs/llms` bundles and skills copies are generated artifacts.
- `apps/cli/src/docs-command.js` resolves bundled docs for `smithers docs/docs-full`.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- 2026-07-06 adversarial review: downgraded from fixed to partial; node `scripts/check-docs.mjs`, node `scripts/check-llms.mjs`, and `apps/cli/tests/docs-cli-overview-coverage.test.js` passed, but `apps/cli/tests/docs-examples-smoke.test.js` failed.
- `docs/**/*.mdx`
- `scripts/generate-llms.ts`
- `scripts/check-docs.mjs`
- `scripts/check-llms.mjs`
- `apps/cli/src/docs-command.js`
- `skills/smithers/llms-full.txt`

## Open gaps

- 2026-07-06 review: `bun test --timeout`=120000 --max-concurrency=1 `apps/cli/tests/docs-examples-smoke.test.js` fails for `docs/examples/workflow-ui-react.mdx#2` with `GRAPH_FAILED/Object.entries` on undefined input.
- Keep docs-pipeline partial until the docs examples smoke gate passes together with `check-docs/check-llms` and CLI overview coverage.
