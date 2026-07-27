import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

for (const path of [
  "../prompts/dynamic-schema-enricher/resolve.mdx",
  "../prompts/dynamic-schema-enricher/extract.mdx",
]) mock.module(path, () => ({ default: () => "prompt" }));

test("covers dynamic-schema-enricher", async () => {
  const result = await coverExample("../dynamic-schema-enricher.jsx", {
    input: { document: "Invoice 42", tenant: "acme" },
    mocks: {
      context: {
        source: "email", tenant: "acme", documentFamily: "invoice",
        rawContent: "Invoice 42", detectedLanguage: "en", summary: "invoice",
      },
      output: {
        schemaId: "invoice-v1", tenant: "acme", documentFamily: "invoice",
        payload: {}, valid: true, validationErrors: [], summary: "typed",
      },
    },
    expectedNodes: ["context", "resolve", "extract", "output"],
  });

  expect(result.executed).toEqual(["context", "resolve", "extract", "output"]);
  expect(result.taskOutputs.extract[0]).toMatchObject({
    schemaId: expect.any(String),
    extractedFields: expect.any(Object),
  });
});
