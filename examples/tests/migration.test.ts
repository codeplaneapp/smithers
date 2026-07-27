import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers migration", async () => {
  const result = await coverExample("../migration.jsx", {
    input: { directory: ".", from: "v1", to: "v2" },
    mocks: {
      analyze: {
        files: [
          { path: "src/a.ts", changeType: "modify", description: "A", complexity: "trivial" },
          { path: "src/b.ts", changeType: "modify", description: "B", complexity: "moderate" },
        ],
        breakingChanges: [],
        totalFiles: 2,
      },
      "migrate-src-a.ts": { path: "src/a.ts", status: "migrated", changes: "updated" },
      "migrate-src-b.ts": { path: "src/b.ts", status: "failed", changes: "", error: "bad" },
      validate: { passed: false, typecheck: true, tests: false, lint: true, errors: ["bad"] },
    },
    executeCompute: true,
  });

  expect(result.executed).toEqual([
    "analyze", "migrate-src-a.ts", "migrate-src-b.ts", "validate", "report",
  ]);
  expect(result.taskOutputs.report[0]).toMatchObject({
    totalFiles: 2,
    migrated: 1,
    failed: 1,
    validationPassed: false,
  });
});
