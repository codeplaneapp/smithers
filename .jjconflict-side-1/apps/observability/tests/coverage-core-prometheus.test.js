import { describe, expect, test } from "bun:test";
import { renderPrometheusSamples, toPrometheusMetricName } from "../src/_corePrometheus.js";

describe("toPrometheusMetricName", () => {
    test("replaces disallowed characters with underscores", () => {
        expect(toPrometheusMetricName("smithers.runs.total")).toBe("smithers_runs_total");
        expect(toPrometheusMetricName("a-b.c:d")).toBe("a_b_c:d");
    });
    test("prefixes an underscore when the first character is not a valid start", () => {
        expect(toPrometheusMetricName("1abc")).toBe("_1abc");
        expect(toPrometheusMetricName("9.metric")).toBe("_9_metric");
    });
});

describe("renderPrometheusSamples", () => {
    test("renders counter and gauge samples with sorted, escaped labels", () => {
        const output = renderPrometheusSamples([
            { name: "smithers.render_test", type: "counter", labels: { z: "1", a: "2" }, value: 5 },
            { name: "smithers.render_test", type: "counter", labels: { b: "9" }, value: 1 },
            { name: "smithers.gauge_special", type: "gauge", labels: { path: 'a\\b\nc"d' }, value: 3 },
        ]);
        expect(output).toContain("# TYPE smithers_render_test counter");
        expect(output).toContain('smithers_render_test{a="2",z="1"} 5');
        expect(output).toContain('smithers_render_test{b="9"} 1');
        // backslash, newline and quote are all escaped in the label value.
        expect(output).toContain('smithers_gauge_special{path="a\\\\b\\nc\\"d"} 3');
    });

    test("renders histogram samples with bucket, sum and count lines", () => {
        const output = renderPrometheusSamples([
            {
                name: "smithers.hist_test",
                type: "histogram",
                labels: { kind: "x" },
                buckets: new Map([
                    [200, 2],
                    [100, 1],
                ]),
                sum: 300,
                count: 3,
            },
        ]);
        expect(output).toContain('smithers_hist_test_bucket{kind="x",le="100"} 1');
        expect(output).toContain('smithers_hist_test_bucket{kind="x",le="200"} 2');
        expect(output).toContain('smithers_hist_test_bucket{kind="x",le="+Inf"} 3');
        expect(output).toContain('smithers_hist_test_sum{kind="x"} 300');
        expect(output).toContain('smithers_hist_test_count{kind="x"} 3');
    });

    test("defaults missing histogram buckets/sum/count to empty/zero", () => {
        const output = renderPrometheusSamples([
            { name: "smithers.hist_empty", type: "histogram", labels: {} },
        ]);
        expect(output).toContain('smithers_hist_empty_bucket{le="+Inf"} 0');
        expect(output).toContain("smithers_hist_empty_sum 0");
        expect(output).toContain("smithers_hist_empty_count 0");
    });

    test("formats NaN and +/-Infinity gauge values", () => {
        const output = renderPrometheusSamples([
            { name: "smithers.nan_metric", type: "gauge", labels: {}, value: Number.NaN },
            { name: "smithers.pos_inf", type: "gauge", labels: {}, value: Number.POSITIVE_INFINITY },
            { name: "smithers.neg_inf", type: "gauge", labels: {}, value: Number.NEGATIVE_INFINITY },
            { name: "smithers.no_value", type: "gauge", labels: {} },
        ]);
        expect(output).toContain("smithers_nan_metric NaN");
        expect(output).toContain("smithers_pos_inf +Inf");
        expect(output).toContain("smithers_neg_inf -Inf");
        expect(output).toContain("smithers_no_value 0");
    });

    test("returns an empty string for no samples", () => {
        expect(renderPrometheusSamples([])).toBe("");
    });
});
