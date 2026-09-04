---
title: "@smthrs/observability"
description: "The telemetry exporter the rest of Smithers deliberately leaves out: one OTLP layer for logs, metrics, and traces, plus the logger, metric, and OpenTelemetry resource layers a host installs around it."
---

`@smthrs/observability` is the exporter for a Smithers process, and the small
set of Effect layers a host installs around it.

Every other package is already instrumented. The stores open spans through
Effect's tracer and update their own metric handles on their hot paths:
`JournalMetrics`, `RunStoreMetrics`, `CacheStoreMetrics`, `ArtifactStoreMetrics`,
`DatabaseMetrics`. What none of them does is ship a signal off the process.
That is this package, and in the common case it is one layer:

```ts
import * as Otlp from "@smthrs/observability/Otlp"
import * as Effect from "effect/Effect"

const telemetry = Otlp.layerFetch({
  baseUrl: "http://localhost:4318",
  serviceName: "deploy-status"
})

// `program` is your durable run, unchanged from its non-telemetry form.
const outcome = program.pipe(Effect.provide(telemetry), Effect.scoped)
```

Nothing in the flow body or the rest of the composition changes. Deleting the
`Effect.provide(telemetry)` line removes telemetry and changes nothing else.

`Otlp` composes only what `effect` itself ships, so it pulls in no
OpenTelemetry SDK and bundles for a browser. The host-specific SDK wirings,
`NodeOtel` and `BrowserOtel`, are reachable by subpath and are deliberately
absent from the root entry point.

## Who uses this package

Host and CLI authors install the exporter, a logger, and, for a control-plane
run, the journal forwarder. Operators read the result: spans and metric series
in a collector, `telemetry.log` rows on a run's journal. Package authors inside
Smithers use `Metric` to update a shared runtime handle, and update nothing
else here.

## Install

```bash
pnpm add @smthrs/observability
```

For the Effect version, the import forms, and the browser rule, see
[Installation](./installation.md).

## The package at a glance

The root entry point exports these namespaces, and each is also importable from
`@smthrs/observability/<Module>`:

| Namespace       | What it is                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `Otlp`          | The default exporter: one layer that posts logs, metrics, and traces to a collector, no SDK involved. |
| `Endpoint`      | The validated collector endpoint every OTLP builder decodes before it exports anything.               |
| `Resource`      | The validated service identity attached to every exported signal.                                     |
| `Logger`        | Effect logger layers: pretty for development, one JSON object per line for production, and silence.   |
| `JournalLogger` | A bounded, drop-on-overflow forwarder that mirrors log records into a run's durable journal.          |
| `Metric`        | The four runtime metric handles other Smithers packages update, and their exported identifiers.       |
| `Otel`          | The provider-neutral bridge for an OpenTelemetry SDK the application already built.                   |

Two more modules are subpath-only, because each resolves a host-specific
OpenTelemetry SDK:

| Import                              | What it is                                                              |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `@smthrs/observability/NodeOtel`    | Node OTLP/HTTP wiring over the OpenTelemetry SDK. Node only.            |
| `@smthrs/observability/BrowserOtel` | Browser OpenTelemetry wiring over processors and readers you construct. |

Every export, with signatures and failure types, is on the
[API reference](./api.md).

## Where to go next

- [Installation](./installation.md): requirements, import forms, and which
  packages a real composition adds.
- [Quickstart](./quickstart.md): export a trace, a log record, and a metric
  series to a collector you can watch, in about thirty lines.
- Guides: [export to a collector](./guides/export-to-a-collector.md),
  [wire an OpenTelemetry SDK](./guides/wire-an-opentelemetry-sdk.md),
  [forward logs to the journal](./guides/forward-logs-to-the-journal.md),
  [install a logger](./guides/install-a-logger.md),
  [read the runtime metrics](./guides/read-runtime-metrics.md), and
  [test telemetry without a collector](./guides/testing.md).
- Concepts: [instrumentation and export](./concepts/instrumentation-and-export.md),
  [the layer map](./concepts/layer-map.md), and
  [validation at layer acquisition](./concepts/validated-acquisition.md).
- [Troubleshooting](./troubleshooting.md): the typed refusals this package
  reports, and the silent cases that are not refusals at all.
