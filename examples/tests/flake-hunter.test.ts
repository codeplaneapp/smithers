import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const runResult = (outcome: "pass" | "fail") =>
  ({ iteration }: { iteration: number }) => ({
    attempt: iteration + 1, outcome, exitCode: outcome === "pass" ? 0 : 1,
    durationMs: 10, stdout: "", stderr: outcome === "fail" ? "boom" : "", signature: outcome,
  });

test("covers both flake-hunter report paths", async () => {
  const divergent = await coverExample("../flake-hunter.jsx", {
    input: { command: "bun test", runs: 3 },
    mocks: {
      runResult: ({ iteration }: { iteration: number }) =>
        runResult(iteration % 2 === 0 ? "pass" : "fail")({ iteration }),
    },
    maxLoopIterations: 3,
    executeCompute: true,
    expectedNodes: ["runResult", "evidence", "report-analysis"],
    // The pre-loop render defines the mutually exclusive static report.
    allowUnreached: ["report-static"],
  });
  const consistent = await coverExample("../flake-hunter.jsx", {
    input: { command: "bun test", runs: 2 },
    mocks: { runResult: runResult("pass") },
    maxLoopIterations: 2,
    executeCompute: true,
    expectedNodes: ["runResult", "evidence", "report-static"],
    // Consistent outcomes intentionally skip the mutually exclusive analyst.
    allowUnreached: ["report-analysis"],
  });

  expect(divergent.executed).toEqual(["runResult", "runResult", "runResult", "evidence", "report-analysis"]);
  expect(consistent.executed).toEqual(["runResult", "runResult", "evidence", "report-static"]);
  expect(divergent.taskOutputs.evidence[0]).toMatchObject({ totalRuns: 3, divergent: true });
  expect(consistent.taskOutputs["report-static"][0]).toMatchObject({ classification: "consistent-pass" });
});
