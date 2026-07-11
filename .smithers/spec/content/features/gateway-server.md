# Gateway, RPC, and server

> **Status:** Partial | **Priority:** P0 | **Owner:** smithers-maintainers | **Group:** Run & observe | **Tier:** Platform

The Gateway and server expose versioned `run/workflow/approval/memory/ticket/cron/devtools` RPCs, HTTP routes, WebSocket event streams, scoped bearer auth, local workspace daemon discovery, and serverless `resume/cron` entry points.

## What you can do

Watch and control durable runs from browser UIs, local monitors, webhooks, or remote automation over one typed API.

## Capabilities

### Live events

WebSocket run events power live UIs, including detached runs.

### Serverless tick

`Resume/cron` tick plus run-lease claims for serverless deployment.

### Stable RPC contract

GatewayRpcDefinition freezes v1 methods, schemas, scopes, errors, and examples.

### Live event streams

streamRunEvents and streamDevTools provide bounded replay and gap-resync semantics over WebSocket.

### Scoped auth

Gateway scopes gate run, approval, cron, memory, ticket, observability, and account access.

### Webhook and cron paths

Server integrations can verify signed webhooks, enqueue external events, and drive cron ticks.

## Endpoints and commands

- `RPC launchRun` ([docs](docs/rpc/launch-run.mdx))
- `RPC streamRunEvents` ([docs](docs/rpc/stream-run-events.mdx))
- `RPC getRun` ([docs](docs/rpc/get-run.mdx))
- `RPC listWorkflows` ([docs](docs/rpc/list-workflows.mdx))
- `HTTP /metrics` ([docs](docs/deployment/production-hardening.mdx))

## Related docs

- [Gateway integration](docs/integrations/gateway.mdx)
- [HTTP server](docs/integrations/server.mdx)
- [RPC reference](docs/rpc/launch-run.mdx)

## Test cases

- `packages/gateway/tests/rpc-contract.test.ts`
- `packages/gateway/tests/generate-openapi.test.ts`
- `packages/server/tests/gateway-bounds.test.js`
- `apps/cli/tests/gateway-command.test.js`
- `apps/cli/tests/gateway-runtime.test.js`
- `apps/cli/tests/gateway-root-and-workflow-ui.e2e.test.js`
- `e2e/faults/case14-gateway-rpc-roundtrip.test.ts`
- `e2e/faults/case15-ws-drop-reconnect.test.ts`
- `e2e/faults/case16-n5-subscribers-bounded-memory.test.ts`

## Observability

- Gateway tracks httpRequests, httpRequestDuration, gatewayApprovalDecisionsTotal, gatewaySignalsTotal, gatewayWebhooksVerifiedTotal, and stream backpressure events.
- streamRunEvents retains a bounded event window and reports gap-resync when clients reconnect from outside the window.

## Debugging

- Use `smithers gateway` `status/stop` and the runtime state file identity checks to diagnose local daemon discovery.
- Use `packages/gateway/tests/rpc-contract.test.ts` when changing RPC schemas, scopes, or examples.
- Use e2e websocket drop and bounded subscriber fault cases for stream regressions.

## Architecture

- `packages/gateway/src/rpc/index.ts` defines the stable v1 method union, `request/response` types, schemas, scopes, and errors.
- `packages/server/src/index.js` implements node:http routes, request bounds, webhook verification, metrics, and workflow loading.
- `packages/gateway-client` and `packages/gateway-react` consume the same RPC contract for non-React and React clients.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- `packages/gateway/src/rpc/index.ts`
- `packages/server/src/index.js`
- `packages/server/src/gateway.js`
- `packages/gateway-client/src/SmithersGatewayClient.ts`
- `packages/gateway-react/src/*.ts`

## Open gaps

- Serverless `resume/cron` tick and run-lease claims need broader end-to-end proof beyond `unit/RPC` contract tests.
- Hosted gateway deployments still need explicit production hardening around TLS, token rotation, and multi-tenant boundaries.
