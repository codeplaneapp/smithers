---
name: smithers-observability
description: Start the local observability stack (Grafana, Prometheus, Tempo, OTLP Collector) via Docker Compose. Run `smithers observability --help` for usage details.
requires_bin: smithers
command: smithers observability
---

# smithers observability

Start the local observability stack (Grafana, Prometheus, Tempo, OTLP Collector) via Docker Compose.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--detach` | `boolean` | `false` | Run containers in the background |
| `--down` | `boolean` | `false` | Stop and remove the observability stack |
