import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers smoketest", async () => {
  const result = await coverExample("../smoketest.jsx", {
    input: {
      directory: ".",
      checks: [{ name: "types", cmd: "bun typecheck" }, { name: "unit", cmd: "bun test" }],
    },
    executeCompute: true,
    mocks: {
      setup: { environment: "test", ready: true, details: "ready" },
      "check-types": { name: "types", passed: true, duration: 4, output: "ok" },
      "check-unit": { name: "unit", passed: false, duration: 6, error: "failed", output: "no" },
    },
  });

  expect(result.executed).toEqual(["setup", "check-types", "check-unit", "report"]);
  expect(result.taskOutputs.report[0]).toMatchObject({
    totalChecks: 2, passed: 1, failed: 1, duration: 10, verdict: "fail",
  });
});
