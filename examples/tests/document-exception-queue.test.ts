import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers document-exception-queue approval decisions", async () => {
  const pass = [
    "classify-invoice-pdf", "extract-invoice-pdf",
    "reconcile", "targeted-reextract", "reconcile", "targeted-reextract",
    "human-exception-review", "export-normalized-record",
  ];
  const result = await coverExample("../document-exception-queue.jsx", {
    inputs: [{ files: ["invoice.pdf"] }, { files: ["invoice.pdf"] }],
    mocks: {
      reconcile: {
        passed: false,
        checks: [{ name: "total", passed: false, explanation: "mismatch" }],
        exceptions: [{ severity: "high", message: "total mismatch", files: ["invoice.pdf"] }],
      },
      "targeted-reextract": {
        file: "invoice.pdf", fields: {}, tables: [], confidence: 0.9, missingFields: [],
      },
    },
    approvals: ({ passIndex }) => passIndex === 0,
    maxLoopIterations: 2,
    expectedNodes: pass,
    assert: false,
  });

  expect(result.executed).toEqual([...pass, ...pass.slice(0, -1)]);
  expect(result.status).toBe("failed");
  expect(result.approvals.map(({ approved }) => approved)).toEqual([true, false]);
  expect(result.taskOutputs.reconcile).toHaveLength(4);
  expect(result.errors).toHaveLength(1);
});
