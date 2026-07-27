import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers discovery", async () => {
  const result = await coverExample("../discovery.jsx", {
    input: { directory: "src" },
    mocks: {
      scan: {
        findings: [],
        summary: "clean",
        totalFiles: 12,
        scannedAt: "2026-07-27T00:00:00Z",
      },
    },
  });

  expect(result.executed).toEqual(["scan"]);
  expect(result.taskOutputs.scan[0]).toMatchObject({ totalFiles: 12, findings: [] });
});
