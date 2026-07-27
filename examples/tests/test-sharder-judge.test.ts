import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers test-sharder-judge", async () => {
  const result = await coverExample("../test-sharder-judge.jsx", {
    input: { diff: "+change" },
    mocks: {
      analyze: { changedFiles: ["a.ts"], affectedModules: ["core"], riskLevel: "high" },
      select: {
        priorityTests: [
          { file: "a.test.ts", reason: "direct", confidence: 1 },
          { file: "b.test.ts", reason: "related", confidence: 0.8 },
        ],
        deferredTests: ["e2e.test.ts"], totalCandidates: 3,
      },
      "run-a.test.ts": { testFile: "a.test.ts", status: "pass", durationMs: 10 },
      "run-b.test.ts": { testFile: "b.test.ts", status: "fail", durationMs: 20, errorMessage: "boom" },
      adjudicate: {
        verdict: "red", failedTests: ["b.test.ts"], deferredTests: ["e2e.test.ts"],
        shouldExpandRun: true, summary: "failed",
      },
    },
  });

  expect(result.executed).toEqual([
    "analyze", "select", "run-a.test.ts", "run-b.test.ts", "adjudicate",
  ]);
  expect(result.taskOutputs.adjudicate[0]).toMatchObject({
    verdict: "red", failedTests: ["b.test.ts"], shouldExpandRun: true,
  });
});
