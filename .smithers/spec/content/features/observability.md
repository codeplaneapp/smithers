# Observability

> **Status:** Partial | **Priority:** P2 | **Owner:** smithers-maintainers | **Group:** Platform & delivery | **Tier:** Platform

Metrics, logging, tracing, and OTLP exporters in `apps/observability`, exported as smithers-orchestrator/observability. Integrations exist but exporter installation into real deployments is uneven.

## What you can do

See what every run and agent did in your existing metrics and tracing stack.

## Test cases

- `pnpm -C apps/observability test`

## Open gaps

- OTLP exporter is not installed in the reference deployments; prove a real export path
