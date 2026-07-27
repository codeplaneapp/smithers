import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers triage routing", async () => {
  const result = await coverExample("../triage.jsx", {
    executeCompute: true,
    mocks: {
      classify: {
        items: [
          { id: "1", title: "Bug", category: "bug", priority: "high", assignTo: "bug-fix", reasoning: "broken" },
          { id: "2", title: "Docs", category: "docs", priority: "low", assignTo: "docs", reasoning: "stale" },
          { id: "3", title: "Spam", category: "noise", priority: "low", assignTo: "ignore", reasoning: "spam" },
        ],
      },
      "handle-1": { itemId: "1", action: "fix", status: "handled", summary: "fixed" },
      "handle-2": { itemId: "2", action: "edit", status: "escalated", summary: "owner needed" },
    },
  });

  expect(result.executed).toEqual(["classify", "handle-1", "handle-2", "report"]);
  expect(result.taskOutputs.report[0]).toMatchObject({
    totalItems: 3, handled: 1, escalated: 1, deferred: 0,
    byCategory: { "bug-fix": 1, docs: 1, ignore: 1 },
  });
});
