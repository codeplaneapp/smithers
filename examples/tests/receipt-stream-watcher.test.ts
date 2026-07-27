import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers receipt-stream-watcher", async () => {
  const result = await coverExample("../receipt-stream-watcher.jsx", {
    mocks: {
      extract: {
        merchant: { value: "Cafe", confidence: 0.99 },
        total: { value: "12.50", confidence: 0.98 },
        date: { value: "2026-07-27", confidence: 0.97 },
        currency: { value: "USD", confidence: 0.96 },
        iterationsUsed: 1,
        complete: true,
      },
      consume: {
        merchant: "Cafe", total: 12.5, date: "2026-07-27", currency: "USD",
        highConfidenceCount: 4, readyForRouting: true, summary: "ready",
      },
      route: {
        destination: "expense-report", merchant: "Cafe", total: 12.5, currency: "USD",
        date: "2026-07-27", reasoning: "business meal", summary: "routed",
      },
    },
    expectedNodes: ["extract", "consume", "route"],
  });

  expect(result.executed).toEqual(["extract", "consume", "route"]);
  expect(result.taskOutputs.route[0]).toMatchObject({ destination: "expense-report", total: 12.5 });
});
