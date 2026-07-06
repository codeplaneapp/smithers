# Observability and tracing

> **Status:** Partial | **Priority:** P2 | **Owner:** smithers-maintainers | **Group:** Operate deployments | **Tier:** Platform

`apps/observability` exports Smithers metrics, structured logging, trace/span helpers, OTLP layers, Prometheus rendering, agent-trace normalization, correlation context, and a local Docker observability stack.

## What you can do

See run, node, agent, gateway, sandbox, scorer, DB, memory, VCS, and OpenAPI behavior in the same metrics/logging/tracing stack as the rest of production.

## Capabilities

### Metrics registry

Core metrics cover runs, nodes, approvals, timers, tools, tokens, gateway, DB, sandbox, scorers, memory, VCS, supervisor, and OpenAPI.

### OTLP layers

createSmithersObservabilityLayer, createSmithersOtelLayer, and runtime layers integrate with Effect and OpenTelemetry exporters.

### Agent trace normalization

Agent session events are normalized/redacted into Smithers events and OTLP log records.

### Local stack

smithers observability can start Prometheus/Grafana/Tempo/OTLP Collector assets from `apps/observability`.

## Endpoints and commands

- `API createSmithersObservabilityLayer` ([docs](docs/llms-observability.txt))
- `API renderPrometheusMetrics` ([docs](docs/deployment/production-hardening.mdx))
- `CLI smithers observability` ([docs](docs/cli/overview.mdx))
- `HTTP /metrics` ([docs](docs/deployment/production-hardening.mdx))

## Related docs

- [Observability LLM fragment](docs/llms-observability.txt)
- [Production hardening](docs/deployment/production-hardening.mdx)

## Test cases

- `apps/observability/tests/observability.test.js`
- `apps/observability/tests/observability-options.test.js`
- `apps/observability/tests/observability-prometheus.test.js`
- `apps/observability/tests/otlp-entry-points.test.js`
- `apps/observability/tests/agentTrace.test.js`
- `apps/observability/tests/correlation.test.js`
- `apps/cli/tests/observability-package.test.js`

## Observability

- This package is the observability surface; metric names are exported as definitions and Prometheus text can be rendered in-process.
- Trace redaction and agent trace capability detection protect logs from leaking secrets while retaining correlation context.

## Debugging

- Run smithers observability up to start the local stack, then inspect /metrics from a serving gateway.
- Use `apps/observability/tests/sessionFileResolvers.test.js` and trace-event-normalizers tests when changing agent trace capture paths.

## Architecture

- `apps/observability/src/index.js` exports observability layers, metrics, logging, tracing, Prometheus helpers, agent trace helpers, and correlation utilities.
- `apps/observability/docker-compose.otel.yml`, prometheus, tempo, loki, and collector configs ship the local stack assets.
- `packages/smithers/src/index.js` re-exports observability through smithers-orchestrator/observability.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- `apps/observability/src`
- `apps/observability/tests`
- `apps/observability/docker-compose.otel.yml`
- `docs/llms-observability.txt`
- `apps/cli/src/index.js` observability command

## Open gaps

- OTLP exporter installation into real reference deployments is uneven; prove a production export path per deployment target.
- Metrics coverage exists, but dashboards/alerts are not a fully versioned product surface in this repo.
