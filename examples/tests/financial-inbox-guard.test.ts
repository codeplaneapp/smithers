import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers financial-inbox-guard", async () => {
  const nodes = ["ingest", "classify", "detect-risk", "extract-invoice", "route"];
  const result = await coverExample("../financial-inbox-guard.jsx", {
    input: { rawEmail: "Invoice INV-42 for $100" },
    mocks: {
      ingest: {
        messageId: "m-1", from: "vendor@example.com", subject: "Invoice",
        bodyPreview: "INV-42", attachments: ["invoice.pdf"], receivedAt: "2026-07-27",
      },
      route: {
        messageId: "m-1", action: "queue-approval", assignee: "finance-ops",
        priority: "normal", notifyChannels: ["#finance-alerts"], summary: "review",
      },
    },
    expectedNodes: nodes,
  });

  expect(result.executed).toHaveLength(nodes.length);
  expect(result.executed).toEqual(expect.arrayContaining(nodes));
  expect(result.taskOutputs.route[0]).toMatchObject({
    action: expect.any(String),
    priority: expect.any(String),
  });
});
