import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { metricsServiceAdapter } from "@smthrs/observability/metrics";

function snapshot() {
  return Effect.runPromise(metricsServiceAdapter.snapshot());
}
/** @param {Record<string, string>} labels */
function labelsKey(labels) {
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
}
/** @param {string} name @param {Record<string, string>} [labels] */
function key(name, labels = {}) {
  return `${name}|${labelsKey(labels)}`;
}

describe("metricsServiceAdapter — known vs fallback metric resolution", () => {
  test("increment resolves a catalog counter and an ad-hoc counter", async () => {
    const before = await snapshot();
    await Effect.runPromise(metricsServiceAdapter.increment("smithers.runs.total"));
    await Effect.runPromise(metricsServiceAdapter.increment("smithers.adapter_adhoc_counter"));
    const after = await snapshot();
    expect(
      (after.get(key("smithers.runs.total"))?.value ?? 0) - (before.get(key("smithers.runs.total"))?.value ?? 0),
    ).toBe(1);
    expect(after.get(key("smithers.adapter_adhoc_counter"))?.value).toBe(1);
  });

  test("incrementBy applies a delta to a known and an unknown metric", async () => {
    await Effect.runPromise(metricsServiceAdapter.incrementBy("smithers.runs.total", 2));
    await Effect.runPromise(metricsServiceAdapter.incrementBy("smithers.adapter_adhoc_by", 4, { region: "eu" }));
    const after = await snapshot();
    expect(after.get(key("smithers.adapter_adhoc_by", { region: "eu" }))?.value).toBe(4);
  });

  test("gauge resolves a catalog gauge and an ad-hoc gauge", async () => {
    await Effect.runPromise(metricsServiceAdapter.gauge("smithers.runs.active", 7));
    await Effect.runPromise(metricsServiceAdapter.gauge("smithers.adapter_adhoc_gauge", 9));
    const after = await snapshot();
    expect(after.get(key("smithers.adapter_adhoc_gauge"))?.value).toBe(9);
  });

  test("histogram resolves a catalog histogram and an ad-hoc histogram", async () => {
    const before = await snapshot();
    await Effect.runPromise(metricsServiceAdapter.histogram("smithers.node.duration_ms", 100));
    await Effect.runPromise(metricsServiceAdapter.histogram("smithers.adapter_adhoc_hist", 5));
    const after = await snapshot();
    expect(
      (after.get(key("smithers.node.duration_ms"))?.count ?? 0) -
        (before.get(key("smithers.node.duration_ms"))?.count ?? 0),
    ).toBe(1);
    expect(after.get(key("smithers.adapter_adhoc_hist"))?.count).toBe(1);
  });

  test("recordEvent delegates to trackEvent", async () => {
    const before = await snapshot();
    await Effect.runPromise(
      metricsServiceAdapter.recordEvent({ type: "RunStarted", runId: "adapter-run", timestampMs: Date.now() }),
    );
    const after = await snapshot();
    expect(
      (after.get(key("smithers.events.emitted_total"))?.value ?? 0) -
        (before.get(key("smithers.events.emitted_total"))?.value ?? 0),
    ).toBeGreaterThanOrEqual(1);
  });

  test("updateProcessMetrics populates the process gauges", async () => {
    await Effect.runPromise(metricsServiceAdapter.updateProcessMetrics());
    const after = await snapshot();
    expect(after.has(key("smithers.process.uptime_seconds"))).toBe(true);
  });

  test("updateAsyncExternalWaitPending sets and clamps the pending gauge at zero", async () => {
    await Effect.runPromise(metricsServiceAdapter.updateAsyncExternalWaitPending("approval", 3));
    let snap = await snapshot();
    expect(snap.get(key("smithers.external_wait.async_pending", { kind: "approval" }))?.value).toBe(3);
    // A large negative delta clamps to zero rather than going negative.
    await Effect.runPromise(metricsServiceAdapter.updateAsyncExternalWaitPending("approval", -100));
    snap = await snapshot();
    expect(snap.get(key("smithers.external_wait.async_pending", { kind: "approval" }))?.value).toBe(0);
  });

  test("renderPrometheus renders the adapter's own sample projection", async () => {
    await Effect.runPromise(metricsServiceAdapter.increment("smithers.adapter_render_check"));
    const output = await Effect.runPromise(metricsServiceAdapter.renderPrometheus());
    expect(typeof output).toBe("string");
    expect(output).toContain("smithers_adapter_render_check");
  });
});
