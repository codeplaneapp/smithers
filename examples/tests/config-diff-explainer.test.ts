import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const Prompt = () => "test prompt";
mock.module("../prompts/config-diff-explainer/explain.mdx", () => ({ default: Prompt }));

test("covers config-diff-explainer", async () => {
  const result = await coverExample("../config-diff-explainer.jsx", {
    input: { paths: ["values.yaml"] },
    executeCompute: true,
    mocks: {
      "fetch-diffs": {
        files: [{ path: "values.yaml", kind: "helm", diff: "+replicas: 5", service: "api" }],
        totalChanges: 1,
        summary: "replicas changed",
      },
      explain: {
        blastRadius: [{ system: "api", impact: "more replicas", severity: "low" }],
        riskLevel: "low", affectedSystems: ["api"], rollbackNotes: "restore value",
        summary: "safe scale-up",
      },
      approve: { action: "approve", comment: "low risk", summary: "approved" },
    },
  });

  expect(result.executed).toEqual(["fetch-diffs", "explain", "approve"]);
  expect(result.taskOutputs.explain[0]).toMatchObject({
    riskLevel: "low",
    affectedSystems: ["api"],
  });
  expect(result.taskOutputs.approve[0]).toMatchObject({ action: "approve" });
});
