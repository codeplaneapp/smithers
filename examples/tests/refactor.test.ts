import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers refactor", async () => {
  const result = await coverExample("../refactor.jsx", {
    input: { directory: "src", pattern: "old", refactoring: "rename" },
    mocks: {
      analyze: {
        targets: [
          { file: "src/a.ts", pattern: "old", occurrences: 2, complexity: "simple" },
          { file: "src/b.ts", pattern: "old", occurrences: 1, complexity: "moderate" },
        ],
        totalOccurrences: 3,
        estimatedImpact: "small",
      },
      "refactor-src-a.ts": { file: "src/a.ts", status: "refactored", changes: "renamed", linesChanged: 2 },
      "refactor-src-b.ts": { file: "src/b.ts", status: "refactored", changes: "renamed", linesChanged: 1 },
      verify: { typecheck: true, tests: true, lint: true, errors: [], passed: true },
    },
    expectedNodes: ["analyze", "refactor-src-a.ts", "refactor-src-b.ts", "verify", "summary"],
  });

  expect(result.executed).toEqual([
    "analyze", "refactor-src-a.ts", "refactor-src-b.ts", "verify", "summary",
  ]);
  expect(result.taskOutputs.summary[0]).toMatchObject({ totalTargets: 2, refactored: 2, verified: true });
});
