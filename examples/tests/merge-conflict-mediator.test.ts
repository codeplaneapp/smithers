import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers merge-conflict-mediator apply and skip paths", async () => {
  const result = await coverExample("../merge-conflict-mediator.jsx", {
    inputs: [{ autoApply: true }, { autoApply: false }],
    mocks: {
      mediationResult: {
        resolutions: [{
          file: "src/a.ts",
          semanticDisagreement: "intent",
          proposedCode: "resolved",
          confidence: 0.9,
          rationale: "safe",
        }],
        overallRisk: "low",
        summary: "safe to apply",
      },
      "apply-result": {
        applied: true,
        filesStaged: ["src/a.ts"],
        gitStatus: "staged",
        summary: "applied",
      },
    },
    expectedNodes: ["apply-result", "apply-result-skipped"],
  });

  expect(result.passes[0].executed).toEqual([
    "parseResult", "mediationResult", "apply-result", "review",
  ]);
  expect(result.passes[1].executed).toEqual([
    "parseResult", "mediationResult", "apply-result-skipped", "review",
  ]);
});
