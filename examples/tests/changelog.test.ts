import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers changelog", async () => {
  const result = await coverExample("../changelog.jsx", {
    input: { version: "1.2.3" },
    mocks: {
      analyze: {
        commits: [{
          sha: "abc", message: "feat: ship", author: "Ada", category: "feature", summary: "Ship it",
        }],
        totalCommits: 1,
        dateRange: "this week",
      },
      generate: {
        version: "1.2.3", date: "2026-07-27",
        sections: [{ category: "Features", emoji: "✨", items: ["Ship it"] }],
        highlights: ["Ship it"], breakingChanges: [], contributors: ["Ada"], markdown: "# 1.2.3",
      },
    },
  });

  expect(result.executed).toEqual(["analyze", "generate"]);
  expect(result.taskOutputs.generate[0]).toMatchObject({
    version: "1.2.3",
    highlights: ["Ship it"],
    contributors: ["Ada"],
  });
});
