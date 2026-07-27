import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers extract-anything-workbench", async () => {
  const candidate = (extractorName: string) => ({
    extractorName, fields: [], rawOutput: "{}", overallConfidence: 0.9,
  });
  const validation = (extractorName: string) => ({
    extractorName, isValid: true, errors: [], warnings: [], fieldCount: 0, confidenceScore: 0.9,
  });
  const nodes = ["extract-alpha", "extract-beta", "validate-alpha", "validate-beta", "preview"];
  const result = await coverExample("../extract-anything-workbench.jsx", {
    input: { input: "name=Smithers", targetSchema: {}, extractors: ["alpha", "beta"] },
    mocks: {
      "extract-alpha": candidate("alpha"),
      "extract-beta": candidate("beta"),
      "validate-alpha": validation("alpha"),
      "validate-beta": validation("beta"),
    },
    expectedNodes: nodes,
  });

  expect(result.executed).toHaveLength(nodes.length);
  expect(result.executed).toEqual(expect.arrayContaining(nodes));
  expect(result.taskOutputs.preview[0]).toMatchObject({ recommendation: expect.any(String) });
});
