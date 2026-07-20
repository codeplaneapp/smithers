import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { MetricsService } from "../src/_coreMetrics.js";
import { MetricsServiceLive } from "../src/MetricsServiceLive.js";

/**
 * Run an effect with the MetricsServiceLive layer provided.
 * @template A
 * @param {Effect.Effect<A, any, MetricsService>} effect
 * @returns {Promise<A>}
 */
function run(effect) {
    return Effect.runPromise(Effect.provide(effect, MetricsServiceLive));
}

/** @param {Record<string, string>} [labels] */
function labelsKey(labels = {}) {
    return JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * @param {string} name
 * @param {Record<string, string>} [labels]
 */
function snapshotKey(name, labels = {}) {
    return `${name}|${labelsKey(labels)}`;
}

/** @returns {Effect.Effect<import("../src/_coreMetricsShape.ts").MetricsSnapshot, never, MetricsService>} */
const getSnapshot = () => Effect.flatMap(MetricsService, (svc) => svc.snapshot());

describe("MetricsServiceLive — metric emission path", () => {
    test("increment emits a counter and snapshot reflects the change", async () => {
        const before = await run(getSnapshot());
        await run(Effect.flatMap(MetricsService, (svc) => svc.increment("smithers.test.msl_counter")));
        const after = await run(getSnapshot());

        const key = snapshotKey("smithers.test.msl_counter");
        const beforeVal = before.get(key)?.value ?? 0;
        const afterVal = after.get(key)?.value ?? 0;
        expect(afterVal - beforeVal).toBe(1);
    });

    test("incrementBy emits the correct delta", async () => {
        const before = await run(getSnapshot());
        await run(Effect.flatMap(MetricsService, (svc) => svc.incrementBy("smithers.test.msl_counter_by", 5)));
        const after = await run(getSnapshot());

        const key = snapshotKey("smithers.test.msl_counter_by");
        const beforeVal = before.get(key)?.value ?? 0;
        const afterVal = after.get(key)?.value ?? 0;
        expect(afterVal - beforeVal).toBe(5);
    });

    test("gauge sets the value in the snapshot", async () => {
        await run(Effect.flatMap(MetricsService, (svc) => svc.gauge("smithers.test.msl_gauge", 42)));
        const snap = await run(getSnapshot());

        const entry = snap.get(snapshotKey("smithers.test.msl_gauge"));
        expect(entry?.type).toBe("gauge");
        expect(entry?.value).toBe(42);
    });

    test("histogram records an observation in the snapshot", async () => {
        const before = await run(getSnapshot());
        await run(Effect.flatMap(MetricsService, (svc) => svc.histogram("smithers.test.msl_histogram", 100)));
        const after = await run(getSnapshot());

        const key = snapshotKey("smithers.test.msl_histogram");
        const beforeCount = before.get(key)?.count ?? 0;
        const afterCount = after.get(key)?.count ?? 0;
        expect(afterCount - beforeCount).toBe(1);
    });

    test("recordEvent increments the eventsEmittedTotal counter via RunStarted", async () => {
        const before = await run(getSnapshot());
        await run(Effect.flatMap(MetricsService, (svc) =>
            svc.recordEvent({ type: "RunStarted", runId: "test-msl-run-1" })
        ));
        const after = await run(getSnapshot());

        // eventsEmittedTotal is always incremented by trackEvent for any event
        const key = snapshotKey("smithers.events.emitted_total");
        const emittedBefore = before.get(key)?.value ?? 0;
        const emittedAfter = after.get(key)?.value ?? 0;
        expect(emittedAfter - emittedBefore).toBeGreaterThanOrEqual(1);
    });

    test("renderPrometheus returns a non-empty string after increments", async () => {
        await run(Effect.flatMap(MetricsService, (svc) => svc.increment("smithers.test.msl_prom_check")));
        const output = await run(Effect.flatMap(MetricsService, (svc) => svc.renderPrometheus()));
        expect(typeof output).toBe("string");
        expect(output.length).toBeGreaterThan(0);
    });

    test("increment with labels appears in snapshot under labeled key", async () => {
        const before = await run(getSnapshot());
        await run(Effect.flatMap(MetricsService, (svc) =>
            svc.increment("smithers.test.msl_labeled", { env: "test" })
        ));
        const after = await run(getSnapshot());

        const key = snapshotKey("smithers.test.msl_labeled", { env: "test" });
        const beforeVal = before.get(key)?.value ?? 0;
        const afterVal = after.get(key)?.value ?? 0;
        expect(afterVal - beforeVal).toBe(1);
    });
});
