import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers form-filler-assistant", async () => {
  const result = await coverExample("../form-filler-assistant.jsx", {
    mocks: {
      extract: {
        knownFields: [],
        missingFields: [{ name: "email", description: "contact email", required: true }],
        documentType: "signup",
        summary: "email needed",
      },
      clarify: {
        answeredFields: [{ name: "email", value: "a@example.com", source: "user-input", confidence: 1 }],
        stillMissing: [],
        allRequiredCollected: true,
        summary: "complete",
      },
      validate: {
        valid: true,
        fields: [{ name: "email", value: "a@example.com", valid: true }],
        normalizedPayload: { email: "a@example.com" },
        summary: "valid",
      },
    },
    maxLoopIterations: 2,
    expectedNodes: ["extract", "clarify", "validate", "submit"],
  });

  expect(result.executed).toEqual(["extract", "clarify", "validate", "submit"]);
  expect(result.taskOutputs.clarify).toHaveLength(1);
  expect(result.taskOutputs.submit[0]).toMatchObject({ status: expect.any(String) });
});
