import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const knowledge = { articles: [], coverageScore: 90 };
const draft = {
  subject: "Re", body: "Answer", tone: "professional", suggestedActions: [], confidenceInDraft: 90,
};

test("covers both support-deflector branches", async () => {
  const deflected = await coverExample("../support-deflector.jsx", {
    input: { ticket: { id: "t1", subject: "How?", body: "Help" } },
    executeCompute: true,
    mocks: {
      classify: {
        category: "how-to", sentiment: "neutral", confidence: 95,
        riskLevel: "low", escalate: false, reasoning: "routine",
      },
      retrieve: knowledge,
      "draft-reply": draft,
    },
  });
  const escalated = await coverExample("../support-deflector.jsx", {
    input: { ticket: { id: "t2", subject: "Outage", body: "Down" } },
    executeCompute: true,
    mocks: {
      classify: {
        category: "outage", sentiment: "angry", confidence: 95,
        riskLevel: "high", escalate: true, reasoning: "urgent",
      },
      retrieve: knowledge,
      "draft-reply": draft,
      escalate: { reason: "outage", priority: "urgent", assignTo: "ops", context: "down" },
    },
    // The initial render defines the mutually exclusive deflection outcome.
    allowUnreached: ["outcome-deflected"],
  });

  expect(deflected.executed).toEqual(["classify", "retrieve", "draft-reply", "outcome-deflected"]);
  expect(escalated.executed).toEqual([
    "classify", "retrieve", "draft-reply", "escalate", "outcome-escalated",
  ]);
  expect(deflected.taskOutputs["outcome-deflected"][0]).toMatchObject({ status: "deflected", ticketId: "t1" });
  expect(escalated.taskOutputs["outcome-escalated"][0]).toMatchObject({ status: "escalated", ticketId: "t2" });
});
