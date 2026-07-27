import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers mcp-health-probe", async () => {
  const result = await coverExample("../mcp-health-probe.jsx", {
    input: { servers: ["alpha", "beta"], maxIterations: 2 },
    mocks: {
      check: ({ iteration }: { iteration: number }) => ({
        materialChange: iteration === 0,
        unhealthyServers: [],
        driftedServers: [],
        newIssues: iteration === 0 ? ["latency"] : [],
        resolvedIssues: iteration === 1 ? ["latency"] : [],
      }),
    },
    maxLoopIterations: 2,
  });

  expect(result.executed).toEqual([
    "schedule", "probe-alpha", "probe-beta", "check", "report",
    "schedule", "probe-alpha", "probe-beta", "check",
  ]);
  expect(result.taskOutputs.schedule).toHaveLength(2);
  expect(result.taskOutputs.report).toHaveLength(1);
});
