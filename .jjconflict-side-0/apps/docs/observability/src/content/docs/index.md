---
title: "@smthrs/observability"
description: "Observability for flows: default OTLP export wiring plus Effect-native logger, metric, and OpenTelemetry SDK layers"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/observability/docs/README.md"
---

Install with the exact Effect release used by Smithers rc.0:

```sh
pnpm add @smthrs/observability effect@4.0.0-rc.108
```

Use the Effect-only OTLP path on Node 22 or in a browser:

```ts
import * as Otlp from "@smthrs/observability/Otlp"

const Telemetry = Otlp.layerFetch({
  baseUrl: "http://localhost:4318",
  serviceName: "my-service"
})
```

`Otlp` exports logs, metrics, and traces over the host's global `fetch` and
does not import an OpenTelemetry SDK. The package root also exposes validated
resource metadata, Effect logger layers, provider-neutral SDK bridges, and a
bounded journal-forwarding logger. Import
`@smthrs/observability/NodeOtel` only in Node and
`@smthrs/observability/BrowserOtel` only in browser bundles.

See the [API reference](/reference/api/) for validation,
backpressure, shutdown, retry, and platform contracts.
