import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers waterfall", async () => {
  const result = await coverExample("../waterfall.jsx", {
    input: { topic: "workflows", outputFile: "article.md" },
    mocks: {
      outline: {
        sections: [{ title: "Intro", keyPoints: ["durability"], estimatedLength: 100 }],
        totalSections: 1, targetAudience: "developers",
      },
      draft: { content: "Draft", wordCount: 1, sectionsCompleted: 1 },
      edit: { content: "Edited", wordCount: 1, changesApplied: ["clarity"], readabilityScore: 90 },
      publish: {
        outputFile: "article.md", format: "markdown", wordCount: 1, summary: "published",
      },
    },
  });

  expect(result.executed).toEqual(["outline", "draft", "edit", "publish"]);
  expect(result.taskOutputs.publish[0]).toEqual({
    outputFile: "article.md", format: "markdown", wordCount: 1, summary: "published",
  });
});
