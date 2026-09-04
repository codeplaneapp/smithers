---
title: "Wire an OpenTelemetry SDK"
description: "Use NodeOtel, BrowserOtel, or Otel when a collector endpoint is not enough: the Node OTLP/HTTP layer, browser processors you construct, and bridging providers an application already built."
sidebar:
  order: 2
---

[`Otlp`](./export-to-a-collector.md) covers a collector endpoint and nothing
else. Three builders exist for the cases it does not cover: existing
OpenTelemetry instrumentation you must feed, a vendor exporter that is not
OTLP/HTTP JSON, and a provider a framework hands you already constructed.

All three attach the same validated `Resource`, so `service.name` means the
same thing whichever one you pick.

## Node: build the SDK for me

`NodeOtel.layerOtel` allocates the whole Node OpenTelemetry SDK: a
`BatchSpanProcessor`, a `BatchLogRecordProcessor`, and a
`PeriodicExportingMetricReader`, each behind its own OTLP/HTTP exporter.

```ts
import * as NodeOtel from "@smthrs/observability/NodeOtel"
import * as Effect from "effect/Effect"

const telemetry = NodeOtel.layerOtel({
  endpoint: "http://localhost:4318",
  resource: { serviceName: "deploy-status", serviceVersion: "2.4.1" },
  exportIntervalMillis: 60_000,
  shutdownTimeout: "10 seconds"
})

const outcome = program.pipe(Effect.provide(telemetry), Effect.scoped)
```

The exporters are created when the scoped layer is built, not when the module
is imported, so holding the builder costs nothing. Closing the scope
force-flushes both batch processors and collects the metric reader once, which
makes release, rather than the interval, the deterministic flush.

The endpoint option is named `endpoint` here and `baseUrl` on `Otlp`; each
refusal names the option it arrived on, so the message points at your own
field.

Import `NodeOtel` only from code that runs on Node. See
[the layer map](../concepts/layer-map.md) for why it is absent from the root
entry point.

## Browser: bring your own processors

`BrowserOtel.layerOtel` builds the web SDK around processors and readers the
application constructs. That keeps browser exporter policy, and every exporter
package a bundle would have to carry, in the application rather than in this
one.

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import * as BrowserOtel from "@smthrs/observability/BrowserOtel"

const telemetry = BrowserOtel.layerOtel({
  resource: { serviceName: "console-ui" },
  spanProcessor: new BatchSpanProcessor(
    new OTLPTraceExporter({ url: "https://otlp.example.com/v1/traces" })
  )
})
```

Every processor field is optional, and a layer with none still builds: it
provides the resource and bridges nothing. Pass an array to install several
processors for one signal.

If all you need in a browser is OTLP delivery, use `Otlp.layerFetch` instead.
It is smaller, needs no SDK, and is browser-safe by construction.

## Bridge providers you already hold

`Otel.layerOtel` allocates no exporter at all. It takes an OpenTelemetry
`TracerProvider`, `LoggerProvider`, and metric readers you already have, and
bridges Effect's tracer, logger, and metrics onto them:

```ts
import * as Otel from "@smthrs/observability/Otel"

const telemetry = Otel.layerOtel({
  resource: { serviceName: "deploy-status" },
  tracerProvider,
  loggerProvider,
  metricReader,
  metricTemporality: "cumulative"
})
```

Each of the three is optional and each is bridged only when supplied, so a
composition with a tracer and no meter installs only the tracer bridge. An
empty `metricReader` array is treated as no metrics at all rather than as a
misconfigured reader.

Two options control merge behavior: `loggerMergeWithExisting` keeps the ambient
Effect loggers alongside the OpenTelemetry logger, and `metricTemporality`
selects the temporality preference the metric bridge reports.

`Otel.layerNoop` is the explicit empty slot for a composition that wants the
option without the wiring.

## Provide only the resource

`Resource.layer` provides the validated OpenTelemetry resource by itself, for a
composition that assembles the rest of the SDK on its own:

```ts
import * as Resource from "@smthrs/observability/Resource"

const resource = Resource.layer({
  serviceName: "deploy-status",
  attributes: { "deployment.environment.name": "production" }
})
```

`Resource.configToAttributes` is the pure projection of the same configuration
into OpenTelemetry attributes, for code that needs the attribute record rather
than a layer. It reads no environment variables: every attribute is one you
passed.
