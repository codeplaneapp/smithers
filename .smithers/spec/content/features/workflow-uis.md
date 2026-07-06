# Custom workflow UIs and monitor surfaces

> **Status:** Partial | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Run & observe

Workflow-owned `.smithers/ui/*.tsx` browser dashboards are declared with <UI>, served by `smithers ui`/gateway, backed by gateway-client/gateway-react hooks, and complemented by monitor/gui/TUI run inspectors.

## What you can do

Give a workflow a purpose-built live dashboard without building a separate product web app.

## Capabilities

### Gateway hooks

gateway-react hooks bind UI components to live run state.

### Seeded UIs

Init pack workflows ship pre-built UIs via generated ui sources.

### Declarative UI declarations

Workflows declare <UI entry=...>; gateway resolves the entry relative to the workflow file and serves it for that run.

### React hooks

gateway-react provides hooks for runs, events, approvals, workflows, prompts, memory facts, scores, tickets, and actions.

### Resilient clients

gateway-client handles typed RPC, abortable calls, reconnect/resume streams, backoff, extension streams, and local/electric collection options.

### Operator monitors

`smithers monitor`, ui, gui, and TUI modes provide zero-setup run views over the same gateway data.

## Endpoints and commands

- `CLI smithers ui <runId>` ([docs](docs/integrations/custom-ui.mdx))
- `CLI smithers monitor <runId>` ([docs](docs/cli/overview.mdx))
- `API useGatewayRun(runId)` ([docs](docs/integrations/custom-ui.mdx))
- `API SmithersGatewayClient.streamRunEventsResilient` ([docs](docs/integrations/custom-ui.mdx))

## Related docs

- [Custom UI guide](docs/integrations/custom-ui.mdx)
- [Gateway React reference](docs/reference/gateway-react.mdx)
- [UI component](docs/components/ui.mdx)

## Test cases

- `packages/gateway-react/tests/gateway-react.test.ts`
- `packages/gateway-react/tests/SmithersGatewayProvider.test.ts`
- `packages/gateway-react/tests/gatewayReactBehavior.test.ts`
- `packages/components/tests/components.test.js`
- `packages/components/tests/schema-validation.test.jsx`
- `packages/components/tests/react-hooks.test.jsx`
- `apps/cli/tests/ui-command.test.js`
- `apps/cli/tests/local-ui-server.test.js`
- `apps/cli/tests/local-ui-gateway-csrf.test.js`
- `apps/cli/tests/workflow-ui-all.e2e.test.js`
- `apps/cli/tests/workflow-pack-ui-coverage.test.js`
- `.smithers/tests/docs-driven-development-ui.e2e.test.tsx`
- `.smithers/tests/open-code-review-ui.e2e.test.ts`

## Observability

- Custom UIs receive pushed run events, approval rows, node outputs, diffs, scores, memory facts, tickets, and workflow metadata through gateway streams/RPC.
- CLI monitor modes expose tree, graph, logs, timeline, and hijack views over the same backend state.

## Debugging

- If `smithers ui` reports NO\_UI, verify the workflow declares <UI entry=...>; creating `.smithers/ui/`<workflow>.tsx alone is insufficient.
- Editing UI source is safe for an existing run; editing the workflow file that declares UI changes its resume hash and requires a fresh run or fork.

## Architecture

- `packages/gateway-react/src/index.ts` exports provider components, collection hooks, run tree folding, connection status, and action hooks.
- `packages/gateway-client/src/index.ts` exports SmithersGatewayClient, typed RPC maps, resilient streams, and data collection helpers.
- `apps/cli/src/localUiServer.js` and workflowUiSources.js serve local workflow UI bundles.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- 2026-07-06 adversarial review: downgraded from fixed to partial after cited UI/graph proof failed.
- `packages/gateway-react/src`
- `packages/gateway-client/src`
- `apps/cli/src/localUiServer.js`
- `apps/cli/src/workflowUiSources.js`
- `.smithers/ui/*.tsx`

## Open gaps

- 2026-07-06 review: `bun test` --timeout=120000 --max-concurrency=1 `apps/cli/tests/ui-command.test.js` fails; the `smithers ui` autostart case times out waiting for the local Gateway.
- 2026-07-06 review: `bun test` --timeout=120000 --max-concurrency=1 `apps/cli/tests/docs-examples-smoke.test.js` fails for `docs/examples/workflow-ui-react.mdx#2` with GRAPH\_FAILED/Object.entries on undefined input.
