import { describe, expect, test } from "bun:test";
import { Context, Effect, Metric } from "effect";
import * as coreMetrics from "../src/_coreMetrics.js";
import { smithersMetrics } from "../src/smithersMetrics.js";
import { smithersMetricCatalogByKey } from "../src/metrics/smithersMetricCatalogByKey.js";

describe("_coreMetrics surface", () => {
    test("exports only the MetricsService tag, no duplicate catalog", () => {
        expect(Object.keys(coreMetrics).sort()).toEqual(["MetricsService"]);
    });

    test("MetricsService is a usable Context tag", async () => {
        /** @type {any} */
        const shape = { incrementCounter: () => Effect.void };
        const resolved = await Effect.runPromise(Effect.provideService(coreMetrics.MetricsService, coreMetrics.MetricsService, shape));
        expect(resolved).toBe(shape);
        expect(Context.isTag(coreMetrics.MetricsService)).toBe(true);
    });

    test("public smithersMetrics maps every catalog key to a Metric instance", () => {
        expect(Object.keys(smithersMetrics).sort()).toEqual([...smithersMetricCatalogByKey.keys()].sort());
        for (const metric of Object.values(smithersMetrics)) {
            expect(Metric.MetricTypeId in /** @type {object} */ (metric)).toBe(true);
        }
    });
});
