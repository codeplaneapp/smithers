import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const Prompt = () => "test prompt";
for (const name of ["plan", "generate", "run", "heal", "report"]) {
  mock.module(`../prompts/playwright-test-agent/${name}.mdx`, () => ({ default: Prompt }));
}

test("covers playwright-test-agent", async () => {
  const result = await coverExample("../playwright-test-agent.jsx", {
    input: { productBrief: "test login", maxIterations: 2 },
    maxLoopIterations: 2,
    mocks: {
      "run-tests": ({ iteration }: { iteration: number }) => ({
        passed: iteration > 0,
        command: "bun test",
        total: 1,
        failed: iteration > 0 ? 0 : 1,
        failures: iteration > 0 ? [] : [{ file: "login.spec.ts", message: "bad selector" }],
        artifacts: ["trace.zip"],
      }),
    },
    expectedNodes: ["plan-tests", "generate-tests", "run-tests", "heal-tests", "report"],
  });

  expect(result.executed).toEqual([
    "plan-tests", "generate-tests", "run-tests", "heal-tests", "run-tests", "report",
  ]);
  expect(result.taskOutputs["run-tests"].map((run: any) => run.passed)).toEqual([false, true]);
});
