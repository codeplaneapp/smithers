---
title: "The layer map"
description: "The five telemetry layer builders this package ships, what each one allocates, and the rule that keeps the root entry point free of Node modules."
sidebar:
  order: 2
---

Five builders produce a telemetry layer, and they differ in one thing: how much
they allocate for you.

## The five builders

| Builder                 | Allocates                                                                  | Reach for it when                                                                 |
| ----------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `Otlp.layerFetch`       | Effect's three OTLP exporters, plus the host's global `fetch`              | You have a collector and no other OpenTelemetry requirement. This is the default. |
| `Otlp.layer`            | Effect's three OTLP exporters. You provide the `HttpClient`                | You need a specific HTTP client, such as Undici on Node.                          |
| `NodeOtel.layerOtel`    | The Node OpenTelemetry SDK: three OTLP/HTTP exporters and their processors | Node code that must run through the OpenTelemetry SDK.                            |
| `BrowserOtel.layerOtel` | The web OpenTelemetry SDK around processors and readers you construct      | Browser code that must run through the OpenTelemetry SDK.                         |
| `Otel.layerOtel`        | Nothing. It bridges providers and readers you already hold                 | The application, or a vendor package, already built an SDK.                       |

Each has an explicit do-nothing counterpart: `Otlp.layerNoop` and
`Otel.layerNoop` both provide nothing and export nothing, so wiring code
switches layers instead of branching around a missing one.

## Why `Otlp` is the default

`Otlp` composes only `effect/unstable/observability/Otlp`, so it adds no
OpenTelemetry SDK to the process, and it delivers over Effect's `HttpClient`
rather than a platform transport. That makes it the cheapest wiring and the
only one that runs unchanged in Node, in Bun, and in a browser.

Reach past it when something other than a collector endpoint is in play: an
existing OpenTelemetry instrumentation you must feed, a vendor exporter that is
not OTLP/HTTP JSON, or a provider a framework hands you.

## Why the root entry point stops at `Otel`

The root entry point exports `Otlp`, `Endpoint`, `JournalLogger`, `Logger`,
`Metric`, `Otel`, and `Resource`. It stops there because those seven resolve
nothing host-specific.

`NodeOtel` does. It reaches `@effect/opentelemetry/NodeSdk` and
`@opentelemetry/sdk-trace-node`, and the latter pulls
`@opentelemetry/context-async-hooks`, which imports the bare specifier
`async_hooks`. A browser bundler cannot resolve that, so re-exporting `NodeOtel`
from the root would break the root's browser bundle for every consumer,
including those that never wanted an SDK. `BrowserOtel` is kept beside it for
symmetry: a module that binds one host belongs on a subpath.

The guarantee is tested, not asserted. A test bundles `src/index.ts` for the
browser and fails on any `node:` import or `require("node:...")` in the output.

## `Resource` sits under all of them

Every builder decodes the same `Resource.Configuration` and attaches the same
attributes, so `service.name`, `service.version`, and your extra attributes mean
the same thing whichever wiring you chose. `Resource.layer` provides that
resource on its own, for a composition that assembles the rest itself.

`Otlp` is the one builder with defaults: `Otlp.defaultServiceName` is `flows`
and `Otlp.defaultServiceVersion` is this package's release version. Name your
own service in production, so a collector holding several Smithers processes
can tell them apart.
