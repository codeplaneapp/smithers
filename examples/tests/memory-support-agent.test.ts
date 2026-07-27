import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

for (const prompt of ["respond", "persist", "escalate"]) {
  mock.module(`../prompts/memory-support-agent/${prompt}.mdx`, () => ({
    default: () => prompt,
  }));
}

test("covers memory-support-agent escalation and normal paths", async () => {
  const response = {
    reply: "reply",
    confidenceScore: 20,
    needsEscalation: true,
    reasoning: "reason",
    suggestedActions: [],
  };
  const escalated = await coverExample("../memory-support-agent.jsx", {
    input: { customerId: "a" },
    mocks: { respond: response },
    expectedNodes: ["escalate"],
  });
  const normal = await coverExample("../memory-support-agent.jsx", {
    input: { customerId: "b" },
    mocks: {
      respond: { ...response, confidenceScore: 95, needsEscalation: false },
    },
  });

  expect(escalated.executed).toEqual(["recall", "respond", "persist", "escalate"]);
  expect(normal.executed).toEqual(["recall", "respond", "persist"]);
  expect(escalated.taskOutputs.escalate[0]).toMatchObject({ escalated: expect.any(Boolean) });
});
