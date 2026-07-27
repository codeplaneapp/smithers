import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers doc-sync", async () => {
  const result = await coverExample("../doc-sync.jsx", {
    mocks: {
      audit: {
        discrepancies: [{
          docFile: "docs/api.md",
          codeFile: "src/api.ts",
          issue: "outdated-api",
          description: "signature changed",
          severity: "warning",
        }],
        totalDocsChecked: 1,
      },
      "fix-0": { file: "docs/api.md", changes: "updated signature", status: "fixed" },
      pr: { branch: "docs/sync", prUrl: "https://example.com/pr/1", filesChanged: 1, summary: "synced" },
    },
    expectedNodes: ["audit", "fix-0", "pr"],
  });

  expect(result.executed).toEqual(["audit", "fix-0", "pr"]);
  expect(result.taskOutputs.pr[0]).toMatchObject({ filesChanged: 1 });
});
