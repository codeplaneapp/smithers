# metrics/

Every Smithers Effect `Metric` instance, one per file (so consumers can
subpath-import a single counter without pulling the world), plus the catalog
(`smithersMetricCatalog.js` and its `ByKey`/`ByName`/`ByPrometheusName` lookup
maps), shared histogram boundaries (`_buckets.js`), the SmithersEvent → metric
fan-out (`trackEvent.js`), the process / external-wait gauge updaters, and
`metricsServiceAdapter.js`, which implements `MetricsServiceShape` on top of
the global Effect metric registry.

How it fits: leaf files define metrics; `smithersMetricCatalog.js` attaches
names, types, labels, boundaries, and default zero-lines for Prometheus
rendering; `../renderPrometheusMetrics.js` and `../MetricsServiceLive.js`
consume the catalog and adapter; `index.js` is the `./metrics` subpath barrel.

Gotchas: some metrics exist as files but are NOT in the catalog (`devtools*`,
`rewind*`, `attentionBacklog`, most `alerts*`, several memory/openApi/scorer
counters) — they only appear in Prometheus output after their first update and
get no default HELP line. A second, drifted catalog copy lives in
`../_coreMetrics.js`; the one in this directory is the source of truth.
Underscore files (`_buckets.js`, `_processStartMs.js`,
`_asyncExternalWaitCounts.js`) hold module-level mutable/shared state.
