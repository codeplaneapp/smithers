import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const categories = ["warnings", "stale-todos", "broken-examples", "formatting", "docs"] as const;
const fixNodes = ["fix-warnings", "fix-todos", "fix-examples", "fix-formatting", "fix-docs"];

test("covers repo-janitor", async () => {
  let scans = 0;
  const result = await coverExample("../repo-janitor.jsx", {
    inputs: [...categories.map((category) => ({ category })), { category: "empty" }],
    mocks: {
      scan: () => {
        const passIndex = scans++;
        return {
          category: categories[Math.min(passIndex, categories.length - 1)],
          items: passIndex < categories.length
            ? [{ file: "a.ts", description: "cleanup", severity: "low" }]
            : [],
          count: passIndex < categories.length ? 1 : 0,
        };
      },
      "fix-*": ({ nodeId }: { nodeId: string }) => ({
        category: nodeId, filesChanged: ["a.ts"], fixCount: 1, skipped: [], summary: "fixed",
      }),
    },
    expectedNodes: ["scan", ...fixNodes, "pr-summary-generated", "pr-summary-empty"],
  });

  expect(result.executed).toEqual([
    "scan", "fix-warnings", "pr-summary-generated",
    "scan", "fix-todos", "pr-summary-generated",
    "scan", "fix-examples", "pr-summary-generated",
    "scan", "fix-formatting", "pr-summary-generated",
    "scan", "fix-docs", "pr-summary-generated",
    "scan", "pr-summary-empty",
  ]);
  expect(result.taskOutputs["pr-summary-empty"][0]).toMatchObject({ totalFixes: 0, riskLevel: "low" });
}, 30_000);
