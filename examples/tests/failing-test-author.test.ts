import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers failing-test-author", async () => {
  const result = await coverExample("../failing-test-author.jsx", {
    mocks: {
      "author-test": {
        testPath: "tests/repro.test.ts", testName: "reproduces bug",
        assertion: "expect(actual).toBe(expected)", linesOfCode: 8, summary: "minimal repro",
      },
      "run-test": {
        testPath: "tests/repro.test.ts", didFail: true, exitCode: 1,
        errorOutput: "expected failure", summary: "reproduced",
      },
    },
    executeCompute: true,
    expectedNodes: ["analyze", "author-test", "run-test", "report"],
  });

  expect(result.executed).toEqual(["analyze", "author-test", "run-test", "report"]);
  expect(result.taskOutputs.report[0]).toMatchObject({
    reproTestPath: "tests/repro.test.ts",
    verified: true,
    readyForFix: true,
  });
});
