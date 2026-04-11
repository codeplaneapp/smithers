import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  CorrelationContextLive,
  MetricsService,
  MetricsServiceLive,
  getCurrentCorrelationContextEffect,
  makeSmithersSpanAttributes,
  prometheusContentType,
  runWithCorrelationContext,
  smithersMetricCatalogByKey,
  smithersMetricCatalogByPrometheusName,
  smithersMetrics,
  toPrometheusMetricName,
  TracingService,
  TracingServiceLive,
  updateCurrentCorrelationContext,
  withSmithersSpan,
} from "../src/observability/index.ts";

describe("observability services", () => {
  test("records metrics and renders prometheus text", async () => {
    const program = Effect.gen(function* () {
      const metrics = yield* MetricsService;
      yield* metrics.increment("smithers.cache.hits", { runId: "r1" });
      yield* metrics.incrementBy("smithers.tokens.input_total", 12, { model: "m" });
      yield* metrics.gauge("smithers.scheduler.queue_depth", 3);
      yield* metrics.histogram("smithers.node.duration_ms", 42);
      return yield* metrics.renderPrometheus();
    }).pipe(Effect.provide(MetricsServiceLive));

    const text = await Effect.runPromise(program);
    expect(text).toContain("# TYPE smithers_cache_hits counter");
    expect(text).toContain('smithers_cache_hits{runId="r1"} 1');
    expect(text).toContain('smithers_tokens_input_total{model="m"} 12');
    expect(text).toContain("smithers_scheduler_queue_depth 3");
    expect(text).toContain("smithers_node_duration_ms_count 1");
  });

  test("exports the main Smithers metric catalog names", () => {
    expect(smithersMetrics.runsTotal).toBe("smithers.runs.total");
    expect(smithersMetricCatalogByKey.get("cacheHits")?.name).toBe(
      "smithers.cache.hits",
    );
    expect(
      smithersMetricCatalogByPrometheusName.get("smithers_cache_hits")?.key,
    ).toBe("cacheHits");
    expect(toPrometheusMetricName("1.bad-name")).toBe("_1_bad_name");
  });

  test("exports Smithers observability span helpers", async () => {
    expect(prometheusContentType).toContain("text/plain");
    expect(makeSmithersSpanAttributes({ runId: "r1", node_id: "n1" })).toEqual({
      "smithers.run_id": "r1",
      "smithers.node_id": "n1",
    });
    await expect(
      Effect.runPromise(
        withSmithersSpan("task:demo", Effect.succeed("ok"), { nodeId: "n1" }),
      ),
    ).resolves.toBe("ok");
  });

  test("tracks process, external wait, and event metrics", async () => {
    const program = Effect.gen(function* () {
      const metrics = yield* MetricsService;
      yield* metrics.updateProcessMetrics();
      yield* metrics.updateAsyncExternalWaitPending("approval", 2);
      yield* metrics.updateAsyncExternalWaitPending("approval", -1);
      yield* metrics.recordEvent({ type: "RunStarted" });
      yield* metrics.recordEvent({ type: "TokenUsageReported", inputTokens: 9 });
      return yield* metrics.renderPrometheus();
    }).pipe(Effect.provide(MetricsServiceLive));

    const text = await Effect.runPromise(program);
    expect(text).toContain("smithers_process_uptime_seconds");
    expect(text).toContain('smithers_external_wait_async_pending{kind="approval"} 1');
    expect(text).toContain("smithers_runs_total 1");
    expect(text).toContain("smithers_tokens_input_total 9");
  });

  test("tracing service composes spans without changing values", async () => {
    const program = Effect.gen(function* () {
      const tracing = yield* TracingService;
      return yield* tracing.withSpan(
        "test.span",
        Effect.succeed(42),
        { runId: "r1" },
      );
    }).pipe(Effect.provide(TracingServiceLive));

    await expect(Effect.runPromise(program)).resolves.toBe(42);
  });

  test("bridges async local and Effect fiber correlation contexts", async () => {
    const fromAsyncLocal = runWithCorrelationContext({ runId: "r1" }, () =>
      Effect.runPromise(getCurrentCorrelationContextEffect()),
    );
    await expect(fromAsyncLocal).resolves.toMatchObject({ runId: "r1" });

    const fromFiber = updateCurrentCorrelationContext({
      runId: "r2",
      nodeId: "n1",
    }).pipe(
      Effect.flatMap(() => getCurrentCorrelationContextEffect()),
      Effect.provide(CorrelationContextLive),
    );
    await expect(Effect.runPromise(fromFiber)).resolves.toMatchObject({
      runId: "r2",
      nodeId: "n1",
    });
  });
});
