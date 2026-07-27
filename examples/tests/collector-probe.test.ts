import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers collector-probe", async () => {
  const result = await coverExample("../collector-probe.jsx", {
    input: { endpoint: "https://example.com", maxIterations: 3 },
    maxLoopIterations: 3,
    mocks: {
      invocation: ({ iteration }: { iteration: number }) => ({
        callId: `call-${iteration}`, model: "test", inputTokens: 1, outputTokens: 1,
        latencyMs: 500, costUsd: 0.01, qualityScore: 0.9, timestamp: "now",
      }),
      collector: ({ iteration }: { iteration: number }) => ({
        samples: [{ callId: `call-${iteration}`, latencyMs: 500, costUsd: 0.01, qualityScore: 0.9 }],
        aggregates: {
          meanLatencyMs: 500, p95LatencyMs: 500, meanCostUsd: 0.01,
          meanQuality: 0.9, totalInvocations: iteration + 1,
        },
        summary: "collected",
      }),
      anomaly: ({ iteration }: { iteration: number }) => ({
        driftDetected: iteration === 0,
        anomalies: [],
        shouldAlert: false,
        summary: iteration === 0 ? "drift" : "steady",
      }),
    },
  });

  expect(result.executed).toEqual([
    "invocation", "collector", "anomaly", "invocation", "collector", "anomaly", "report",
  ]);
  expect(result.taskOutputs.anomaly).toHaveLength(2);
  expect(result.taskOutputs.report[0]).toMatchObject({
    overallStatus: "degraded", totalInvocations: 2, iterationsRun: 2, anomaliesDetected: 1,
  });
});
