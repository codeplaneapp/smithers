import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers classifier-switchboard", async () => {
  const domains = ["support", "sales", "security", "billing"] as const;
  const result = await coverExample("../classifier-switchboard.jsx", {
    mocks: {
      intake: {
        items: domains.map((domain) => ({ id: domain, content: domain, source: "ticket" })),
      },
      classify: {
        classifications: domains.map((domain) => ({
          itemId: domain, domain, confidence: 1, reasoning: domain, priority: "normal",
        })),
      },
      "handle-*": ({ nodeId }: { nodeId: string }) => {
        const domain = nodeId.split("-")[1] as (typeof domains)[number];
        return { itemId: domain, domain, action: "handled", status: "resolved", response: "done" };
      },
      summary: {
        totalProcessed: 4,
        byDomain: Object.fromEntries(domains.map((domain) => [domain, 1])),
        byStatus: { resolved: 4 },
        escalations: [],
        summary: "all routed",
      },
    },
  });

  expect(result.executed).toEqual([
    "intake", "classify", "handle-support-support", "handle-sales-sales",
    "handle-security-security", "handle-billing-billing", "summary",
  ]);
  expect(result.taskOutputs.summary[0]).toMatchObject({ totalProcessed: 4, byStatus: { resolved: 4 } });
});
