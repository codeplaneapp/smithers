import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const run = { command: "test", exitCode: 1, stdout: "", stderr: "boom", durationMs: 10 };

test("covers both fail-only-report branches", async () => {
  const failed = await coverExample("../fail-only-report.jsx", {
    input: { commands: [{ name: "test", cmd: "bun test" }] },
    mocks: {
      "run-test": run,
      analyze: {
        notable: true,
        failingCommands: ["test"],
        regressingCommands: [],
        artifacts: [{ command: "test", category: "failure", snippet: "boom" }],
        summary: "failed",
      },
    },
    expectedNodes: ["run-test", "analyze", "report", "sink-report"],
    // The initial green render defines the mutually exclusive quiet sink.
    allowUnreached: ["sink-quiet"],
  });
  const green = await coverExample("../fail-only-report.jsx", {
    input: { commands: [{ name: "test", cmd: "bun test" }] },
    mocks: {
      "run-test": { ...run, exitCode: 0, stderr: "" },
      analyze: {
        notable: false, failingCommands: [], regressingCommands: [], artifacts: [], summary: "green",
      },
    },
    expectedNodes: ["run-test", "analyze", "sink-quiet"],
  });

  expect(failed.executed).toEqual(["run-test", "analyze", "report", "sink-report"]);
  expect(green.executed).toEqual(["run-test", "analyze", "sink-quiet"]);
  expect(failed.taskOutputs["sink-report"][0]).toMatchObject({ status: "reported" });
  expect(green.taskOutputs["sink-quiet"][0]).toMatchObject({ status: "quiet" });
}, 15_000);
