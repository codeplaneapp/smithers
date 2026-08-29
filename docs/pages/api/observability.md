---
description: "Default OTLP export wiring for Smithers telemetry, over Effect's own observability modules."
---

# @smthrs/observability

Default OTLP export wiring for Smithers telemetry. The store packages define their metric handles and open spans but deliberately ship no exporter; this package is that exporter. It composes Effect's own OTLP logger, metrics exporter, and tracer (`effect/unstable/observability`) into one layer with the Smithers service identity as the default resource. It depends on `effect` alone, with no OpenTelemetry SDK, and resolves no `node:` built-in, so the package root bundles for the browser.

```ts
import * as Otlp from "@smthrs/observability/Otlp"

const Telemetry = Otlp.layerFetch({ baseUrl: "http://localhost:4318" })
```

## Entry points

| Import | Source | Platform |
| --- | --- | --- |
| `@smthrs/observability` | [src/index.ts](https://github.com/smithersai/smithers/blob/main/packages/observability/src/index.ts) | any |

## Otlp

[src/Otlp.ts](https://github.com/smithersai/smithers/blob/main/packages/observability/src/Otlp.ts)

| Export | Kind | Notes |
| --- | --- | --- |
| `Options` | interface | `baseUrl`, `serviceName`, `serviceVersion`, `attributes`, `headers`, `exportInterval`, `shutdownTimeout` |
| `defaultServiceName` | constant | `"flows"`, the `service.name` installed when the caller supplies none |
| `defaultServiceVersion` | constant | the workspace release version, the `service.version` default |
| `layer` | layer | logs, metrics, and traces to `/v1/{logs,metrics,traces}` below `baseUrl`; requires an `HttpClient` |
| `layerFetch` | layer | `layer` over the host's global `fetch`; the default for Node 22 and every browser |
| `layerNoop` | layer | provides nothing, so wiring code switches layers rather than branches |

[Telemetry](/telemetry) shows application wiring and tables the counters that arrive; [Observability](/observability) lists the spans.
