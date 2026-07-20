import { describe, expect, test } from "bun:test";
import { Effect, Metric } from "effect";
import { httpRequestDuration, renderPrometheusMetrics, runsTotal, } from "../src/index.js";
describe("Prometheus metrics", () => {
    test("renders built-in Smithers metrics in Prometheus exposition format", async () => {
        await Effect.runPromise(Metric.increment(runsTotal));
        await Effect.runPromise(Metric.update(httpRequestDuration, 42));
        const output = renderPrometheusMetrics();
        expect(output).toContain("# TYPE smithers_runs_total counter");
        expect(output).toContain("smithers_runs_total");
        expect(output).toContain("# TYPE smithers_http_request_duration_ms histogram");
        expect(output).toContain("smithers_http_request_duration_ms_bucket");
        expect(output).toContain("smithers_http_request_duration_ms_count");
    });
});
