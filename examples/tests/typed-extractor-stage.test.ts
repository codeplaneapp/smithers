import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers typed-extractor-stage", async () => {
  const result = await coverExample("../typed-extractor-stage.jsx", {
    input: { rawInput: "Acme plan: Pro", nextStep: "persist" },
    executeCompute: true,
    mocks: {
      extract: {
        entityName: "Acme", entityType: "company",
        fields: [{ key: "plan", value: "pro", confidence: 0.9 }],
        rawSnippets: ["plan: Pro"], summary: "extracted",
      },
      validate: {
        entityName: "Acme", entityType: "company",
        fields: [{ key: "plan", value: "pro", confidence: 0.9, valid: true, correctedValue: "Pro" }],
        overallConfidence: 0.9, issues: [], summary: "valid",
      },
    },
  });

  expect(result.executed).toEqual(["extract", "validate", "forward"]);
  expect(result.taskOutputs.forward[0]).toEqual({
    entityName: "Acme", entityType: "company", structuredOutput: { plan: "Pro" },
    overallConfidence: 0.9, nextStep: "persist", summary: "valid",
  });
});
