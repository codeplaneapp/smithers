import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers schema-conformance-gate branches", async () => {
  let validations = 0;
  const result = await coverExample("../schema-conformance-gate.jsx", {
    inputs: [{ data: {} }, { data: { id: 1 } }],
    mocks: {
      validate: () => {
        const passed = validations++ > 0;
        return {
          passed,
          violations: passed ? [] : [{
            field: "id", rule: "required", message: "missing", severity: "error",
          }],
          checkedFields: 1,
        };
      },
      diagnose: {
        rootCause: "missing field", suggestedFixes: ["add id"], canAutoFix: true,
      },
    },
    expectedNodes: ["validate", "diagnose", "fail-result", "pass-result"],
  });

  expect(result.executed).toEqual([
    "validate", "diagnose", "fail-result", "validate", "pass-result",
  ]);
  expect(result.taskOutputs["fail-result"][0]).toMatchObject({ status: "failed", errorCount: 1 });
  expect(result.taskOutputs["pass-result"][0]).toMatchObject({ status: "passed", errorCount: 0 });
});
