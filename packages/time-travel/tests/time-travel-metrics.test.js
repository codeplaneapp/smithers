import { describe, test } from "bun:test";
import { Effect, Metric } from "effect";
import { snapshotsCaptured, runForksCreated, replaysStarted, snapshotDuration } from "../src/metrics.js";
describe("time-travel metrics", () => {
  test("snapshotsCaptured is a counter metric", async () => {
    // Incrementing should not throw
    await Effect.runPromise(Metric.update(snapshotsCaptured, 1));
  });
  test("runForksCreated is a counter metric", async () => {
    await Effect.runPromise(Metric.update(runForksCreated, 1));
  });
  test("replaysStarted is a counter metric", async () => {
    await Effect.runPromise(Metric.update(replaysStarted, 1));
  });
  test("snapshotDuration is a histogram metric", async () => {
    // Should accept a duration value
    await Effect.runPromise(Metric.update(snapshotDuration, 42));
  });
  test("metrics can be updated multiple times", async () => {
    await Effect.runPromise(
      Effect.all([
        Metric.update(snapshotsCaptured, 1),
        Metric.update(snapshotsCaptured, 1),
        Metric.update(runForksCreated, 1),
        Metric.update(snapshotDuration, 10),
        Metric.update(snapshotDuration, 50),
      ]),
    );
  });
});
