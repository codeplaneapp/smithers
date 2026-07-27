import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const Prompt = () => "test prompt";
mock.module("../prompts/alert-suppressor/classify.mdx", () => ({ default: Prompt }));
mock.module("../prompts/alert-suppressor/sink.mdx", () => ({ default: Prompt }));

test("covers alert-suppressor", async () => {
  const result = await coverExample("../alert-suppressor.jsx", {
    input: {
      alerts: [
        { id: "a", source: "test", severity: "high", message: "one", timestamp: "now", labels: "{}" },
        { id: "b", source: "test", severity: "high", message: "two", timestamp: "now", labels: "{}" },
      ],
    },
    executeCompute: true,
    mocks: {
      dedupe: { uniqueAlerts: [], suppressedCount: 1, suppressedIds: ["b"] },
      classify: {
        classifications: [{
          alertId: "a", verdict: "observe", confidence: 1, reasoning: "watch", riskLevel: "low",
        }],
      },
      dispatch: { paged: [], ticketed: [], dropped: ["a"] },
    },
  });

  expect(result.executed).toEqual(["dedupe", "context-lookup", "classify", "dispatch", "summary"]);
  expect(result.taskOutputs.summary[0]).toMatchObject({
    totalReceived: 2,
    suppressed: 2,
    escalated: 0,
    observed: 1,
  });
});
