import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const Prompt = () => "test prompt";
for (const name of ["trigger", "classify", "lead-action", "support-action", "follow-up-action", "summary"]) {
  mock.module(`../prompts/social-inbox-router/${name}.mdx`, () => ({ default: Prompt }));
}

test("covers social-inbox-router", async () => {
  const result = await coverExample("../social-inbox-router.jsx", {
    mocks: {
      trigger: {
        id: "m1", platform: "linkedin", senderName: "Ada", messageBody: "Help",
        receivedAt: "now", summary: "inbox item",
      },
      classify: {
        items: [{ id: "m1", category: "support", confidence: 1, reasoning: "question" }],
        summary: "classified",
      },
      "lead-actions": { actions: [], summary: "none" },
      "support-actions": {
        tickets: [{ itemId: "m1", subject: "Help", urgency: "high", suggestedReply: "Hi", escalate: false }],
        summary: "ticketed",
      },
      "follow-up-actions": { followUps: [], summary: "none" },
      summary: {
        totalProcessed: 1, categoryCounts: { lead: 0, noise: 0, support: 1, followUp: 0 },
        leadActions: [], supportTickets: ["m1"], followUps: [], summary: "routed",
      },
    },
  });

  expect(result.executed).toEqual([
    "trigger", "classify", "lead-actions", "support-actions", "follow-up-actions", "summary",
  ]);
  expect(result.taskOutputs.summary[0]).toMatchObject({
    totalProcessed: 1, categoryCounts: { support: 1 }, supportTickets: ["m1"],
  });
});
