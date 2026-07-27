import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers revenue-scout", async () => {
  const result = await coverExample("../revenue-scout.jsx", {
    mocks: {
      classify: {
        conversations: [{
          id: "c1", source: "support", hasSignal: true, signalType: "expansion",
          confidence: 0.95, reasoning: "more seats",
        }],
      },
      extract: {
        opportunities: [{
          conversationId: "c1", signalType: "expansion", product: "Enterprise",
          customerName: "Acme", keyQuotes: ["more seats"], urgency: "near-term", summary: "expand",
        }],
      },
      handoff: {
        totalScanned: 1, opportunitiesFound: 1, routedToCrm: 1,
        bySignalType: { expansion: 1 },
        handoffs: [{ conversationId: "c1", assignedRep: "Ada", priority: "warm", nextStep: "call" }],
        summary: "routed",
      },
    },
    expectedNodes: ["classify", "extract", "handoff"],
  });

  expect(result.executed).toEqual(["classify", "extract", "handoff"]);
  expect(result.taskOutputs.handoff[0]).toMatchObject({ opportunitiesFound: 1, routedToCrm: 1 });
});
