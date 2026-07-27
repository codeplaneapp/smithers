import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const Prompt = () => "test prompt";
for (const name of ["ingest", "analyze", "report"]) {
  mock.module(`../prompts/trace-explainer/${name}.mdx`, () => ({ default: Prompt }));
}

test("covers trace-explainer", async () => {
  const result = await coverExample("../trace-explainer.jsx", {
    mocks: {
      ingest: {
        spans: [{ name: "agent", durationMs: 100, tokenCount: 50, failed: false }],
        totalDurationMs: 100, totalTokens: 50, failedSpanCount: 0,
      },
      analyze: {
        bottleneck: { spanName: "agent", reason: "latency", impact: "slow" },
        hotPath: ["agent"], failureSummary: null,
        tokenHogs: [{ spanName: "agent", tokenCount: 50, percentOfTotal: 100 }],
      },
      report: {
        title: "Trace", bottleneckExplanation: "agent is slow",
        optimizations: [{ target: "agent", suggestion: "cache", estimatedSaving: "50ms" }],
        summary: "optimize agent",
      },
    },
  });

  expect(result.executed).toEqual(["ingest", "analyze", "report"]);
  expect(result.taskOutputs.report[0]).toMatchObject({
    title: "Trace",
    optimizations: [{ target: "agent", suggestion: "cache", estimatedSaving: "50ms" }],
  });
});
