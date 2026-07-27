import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

mock.module("../prompts/patch-plausibility-gate/finalize.mdx", () => ({
  default: () => "finalize patch",
}));

test("covers patch-plausibility-gate", async () => {
  const result = await coverExample("../patch-plausibility-gate.jsx", {
    input: { pr: 42, repo: "smithers" },
    mocks: {
      gate: {
        promoted: true,
        passedChecks: ["lint", "test", "build"],
        failedChecks: [],
        plausibilityScore: 1,
        reasoning: "all checks passed",
      },
      finalize: { action: "merge", message: "merged", summary: "promoted" },
    },
  });

  expect(result.executed).toEqual(["patch", "lint", "test", "build", "gate", "finalize"]);
  expect(result.taskOutputs.gate[0]).toMatchObject({
    promoted: true,
    passedChecks: ["lint", "test", "build"],
    failedChecks: [],
  });
});
