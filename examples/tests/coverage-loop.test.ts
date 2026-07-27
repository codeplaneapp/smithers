import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers coverage-loop", async () => {
  const result = await coverExample("../coverage-loop.jsx", {
    input: { directory: ".", target: 90 },
    maxLoopIterations: 3,
    mocks: {
      measure: ({ iteration }: { iteration: number }) => ({
        coverage: iteration === 0 ? 70 : 95,
        uncoveredFiles: iteration === 0
          ? [{ file: "a.ts", coverage: 70, uncoveredLines: [1] }]
          : [],
        totalFiles: 1,
      }),
      fix: { testsWritten: 1, filesCreated: ["a.test.ts"], expectedCoverageGain: 25, summary: "covered" },
    },
  });

  expect(result.executed).toEqual(["measure", "fix", "measure", "report"]);
  expect(result.taskOutputs.measure).toHaveLength(2);
  expect(result.taskOutputs.report[0]).toMatchObject({
    initialCoverage: 70,
    finalCoverage: 95,
    totalTestsWritten: 1,
    iterations: 2,
  });
});
