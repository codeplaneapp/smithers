# `@smthrs/observability`

The flows store packages open spans through Effect's tracer and update `Metric` counters on their hot paths, and deliberately ship no exporter. This package is the exporter: one layer that installs Effect's own OTLP logger, metrics exporter, and tracer (`effect/unstable/observability`) against a collector endpoint, with the flows service identity as the default resource. It depends on `effect` alone — no OpenTelemetry SDK.

```typescript
import * as Otlp from "@smthrs/observability/Otlp"

// Node host or browser: export over the global fetch.
const Telemetry = Otlp.layerFetch({ baseUrl: "http://localhost:4318" })

// No collector: the explicit no-op.
const NoTelemetry = Otlp.layerNoop
```

| Export                       | What it does                                                 |
| ---------------------------- | ------------------------------------------------------------ |
| `Otlp.layer`                 | OTLP logs + metrics + traces layer; requires an `HttpClient` |
| `Otlp.layerFetch`            | `Otlp.layer` over the host's global `fetch`                  |
| `Otlp.layerNoop`             | exports nothing                                              |
| `Otlp.defaultServiceName`    | `"flows"`, the default `service.name`                        |
| `Otlp.defaultServiceVersion` | the default `service.version`                                |

See `docs/pages/telemetry.md` for full wiring, including the per-package metric handles the layer exports.
