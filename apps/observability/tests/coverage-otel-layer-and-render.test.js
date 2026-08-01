import { describe, expect, test } from "bun:test";
import { Effect, Metric } from "effect";
import { createSmithersOtelLayer } from "../src/createSmithersOtelLayer.js";
import { renderPrometheusMetrics } from "../src/renderPrometheusMetrics.js";

describe("createSmithersOtelLayer tracer context", () => {
  test("routes span execution through smithersTraceSpanStorage when enabled", async () => {
    const layer = createSmithersOtelLayer({
      enabled: true,
      endpoint: "http://127.0.0.1:59999/v1/traces",
      serviceName: "coverage-otel",
    });
    // Executing a span under the enabled OTLP tracer invokes the layer's
    // tracerContext callback, which binds the span into the AsyncLocalStorage
    // store. The unreachable export endpoint is irrelevant to that callback.
    const result = await Effect.runPromise(
      Effect.succeed("ok").pipe(Effect.withSpan("coverage-span"), Effect.provide(layer)),
    );
    expect(result).toBe("ok");
  });
});

describe("renderPrometheusMetrics coverage of metric-state paths", () => {
  test("renders counters, gauges, histograms, summaries and frequencies together", () => {
    Effect.runSync(
      Effect.all([
        Metric.update(Metric.counter("smithers.render_cov.counter"), 1),
        Metric.update(Metric.gauge("smithers.render_cov.gauge"), 3),
        Metric.update(
          Metric.histogram("smithers.render_cov.hist", {
            boundaries: Metric.linearBoundaries({ start: 0, width: 10, count: 5 }),
          }),
          5,
        ),
      ]),
    );
    const summary = Metric.summary("smithers.render_cov.summary", {
      maxAge: "1 minutes",
      maxSize: 100,
      quantiles: [0.5, 0.9],
    });
    Effect.runSync(Metric.update(summary, 2));
    Effect.runSync(Metric.update(Metric.frequency("smithers.render_cov.freq"), "a"));

    const output = renderPrometheusMetrics();
    expect(output).toContain("smithers_render_cov_counter");
    expect(output).toContain("smithers_render_cov_gauge 3");
    expect(output).toContain("smithers_render_cov_hist_bucket");
    expect(output).toContain("smithers_render_cov_summary");
    expect(output).toContain('smithers_render_cov_freq{key="a"}');
  });

  test("emits default zero-valued lines for catalog metrics that were never observed", () => {
    // A histogram catalog metric with no recorded samples still renders its
    // default bucket/sum/count lines (defaultPrometheusMetricLines).
    const output = renderPrometheusMetrics();
    expect(output).toContain("# TYPE smithers_supervisor_resume_lag_ms histogram");
    expect(output).toContain("smithers_supervisor_resume_lag_ms_count");
    // A gauge with defaultLabels renders one default line per label set.
    expect(output).toContain("smithers_external_wait_async_pending");
  });
});
