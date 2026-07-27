import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers command-watchdog", async () => {
  let detections = 0;
  const result = await coverExample("../command-watchdog.jsx", {
    inputs: [{ command: "bun test" }, { command: "bun test" }],
    maxLoopIterations: 2,
    mocks: {
      detect: () => {
        const notable = detections++ === 0;
        return {
          notable, reasons: notable ? ["exit changed"] : [], exitCodeChanged: notable,
          durationDeltaPercent: 0, signatureChanged: false, diffSummary: "",
        };
      },
      report: { status: "escalated", anomalies: ["exit changed"], runCount: 1, summary: "escalate" },
    },
    expectedNodes: ["run", "detect", "report", "steady"],
  });

  expect(result.executed).toEqual([
    "run", "detect", "report",
    "run", "detect", "run", "detect", "steady",
  ]);
  expect(result.taskOutputs.report[0]).toMatchObject({ status: "escalated", runCount: 1 });
  expect(result.taskOutputs.steady[0]).toMatchObject({ status: "steady", runCount: 2 });
});
