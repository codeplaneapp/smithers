## Runtime and platform contract

The package is tested with `effect@4.0.0-rc.108`. `Otlp`, `Logger`,
`JournalLogger`, `Metric`, `Otel`, and `Resource` are reachable from the root
barrel. `Otlp.layerFetch` uses Effect's HTTP exporter and the host's global
`fetch`, so that subpath is browser-safe and does not require an OpenTelemetry
SDK.

The package as a whole is not Effect-only. `Otel` and `Resource` bridge the
OpenTelemetry API, while `NodeOtel` and `BrowserOtel` use the SDK packages
declared in this package's manifest. `NodeOtel` reaches Node-specific SDK code
and must not enter a browser graph. `BrowserOtel` accepts processors and
readers created by the application and contains no Node built-in.

## Resource validation

Every public OTEL builder uses the same `Resource.Configuration` decoder.
Invalid input fails layer acquisition with `InvalidResourceConfiguration`,
code `invalid_resource_configuration`, and a stable issue path. Rejected
values are not retained in the error.

- Service name and version are non-empty, well-formed strings of at most 1,024
  UTF-16 code units.
- There may be at most 256 resource attributes. Keys are non-empty,
  well-formed strings of at most 1,024 code units.
- Values are finite numbers, booleans, strings of at most 65,536 code units,
  or homogeneous arrays of one of those scalar types.
- NUL and unpaired UTF-16 surrogates are refused. Valid astral Unicode is
  preserved.

## Journal forwarding

`JournalLogger.layerJournalForwarding` snapshots, bounds, and redacts a log
record synchronously before placing it on an asynchronous queue. Caller
mutation after the log call cannot change the queued record. The runtime schema
`TelemetryLog` preserves ordered failure, defect, and interruption reasons.
The durable journal allocates `sourceSeq`, so rebuilding or concurrently
running logger layers for one run cannot reuse an identity.

The queue defaults to 256 records and accepts a configured capacity from 1
through 65,536. A snapshot accepts at most 1 MiB of encoded data, 4,096
container members, and 64 container edges. Unreadable values become
`[Unrenderable]`; values past a ceiling become `[Truncated]`; deep values become
`[Deep]`. The same journal redaction rules used for durable events run before
queue admission.

The callback never blocks. A full queue drops the new record. Journal delivery
failure is absorbed because reporting it through the same logger would recurse.
Closing the layer interrupts the worker and can drop records queued behind an
in-flight write. Invalid run ids or capacities fail layer acquisition with
`InvalidJournalLoggerOptions`; they are never routed through the lossy worker.

## Runtime metrics

`Metric` exports three cross-package runtime signals. `runThroughput` advances
only after `RunStore.transitionOwned` commits a terminal transition.
`activeSeats` is a gauge held for the lifetime of a production `Agent.run`
stream and released on success, failure, or interruption. `quotaParks`
advances when the sealed quota decision is first executed, not when that
decision is replayed after a wake or process restart.

Step-cache lookup and write counters remain owned by `@smthrs/step-cache`.
This package does not duplicate those handles.

## OTLP delivery

`Otlp.layer` requires an Effect `HttpClient`; `layerFetch` supplies the global
fetch implementation. Both install JSON exporters for `/v1/logs`,
`/v1/metrics`, and `/v1/traces`. Effect's exporter retries transient failure
three times, then temporarily disables delivery. Export failure does not fail
the application effect. `shutdownTimeout` bounds the final flush.

`NodeOtel.layerOtel` creates OTLP/HTTP trace, metric, and log exporters only
when its scoped layer is built. `BrowserOtel.layerOtel` and `Otel.layerOtel`
instead consume application-created providers, processors, and readers.
