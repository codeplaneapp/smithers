import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers supervisor loop", async () => {
  const result = await coverExample("../supervisor.jsx", {
    input: { goal: "ship", directory: "." },
    executeCompute: true,
    maxLoopIterations: 3,
    mocks: {
      delegate: {
        tasks: [
          { id: "code", title: "Code", instructions: "build", files: ["a.ts"], workerType: "coder" },
          { id: "test", title: "Test", instructions: "verify", files: ["a.test.ts"], workerType: "tester" },
        ],
        strategy: "parallel",
      },
      "worker-code": { taskId: "code", status: "success", summary: "done", filesChanged: ["a.ts"] },
      "worker-test": { taskId: "test", status: "success", summary: "done", filesChanged: ["a.test.ts"] },
      supervise: ({ iteration }: { iteration: number }) => ({
        allDone: iteration >= 1, retriable: [], summary: "reviewed", nextActions: [],
      }),
    },
  });

  expect(result.executed).toEqual([
    "delegate", "worker-code", "worker-test", "supervise",
    "worker-code", "worker-test", "supervise", "final",
  ]);
  expect(result.taskOutputs.supervise).toHaveLength(2);
  expect(result.taskOutputs.final[0]).toMatchObject({
    totalTasks: 2, succeeded: 4, failed: 0, iterations: 2,
  });
});
