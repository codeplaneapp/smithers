import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers blog-analyzer-pipeline", async () => {
  const result = await coverExample("../blog-analyzer-pipeline.jsx", {
    input: { source: "posts/" },
    mocks: {
      ingest: {
        articles: [{ id: "a", title: "Post", content: "Body", author: "Ada" }],
        totalIngested: 1,
        errors: [],
      },
      analyze: {
        insights: [{
          articleId: "a", categories: ["engineering"], sentiment: "positive",
          keyTopics: ["workflows"], readabilityScore: 90,
        }],
        totalAnalyzed: 1,
        topCategories: [{ category: "engineering", count: 1 }],
      },
      report: {
        summary: "one post", categoryBreakdown: { engineering: 1 },
        sentimentDistribution: { positive: 1 }, topTopics: ["workflows"],
        recommendations: ["publish"], totalProcessed: 1,
      },
    },
  });

  expect(result.executed).toEqual(["ingest", "analyze", "report"]);
  expect(result.taskOutputs.report[0]).toMatchObject({
    totalProcessed: 1,
    categoryBreakdown: { engineering: 1 },
    sentimentDistribution: { positive: 1 },
  });
});
