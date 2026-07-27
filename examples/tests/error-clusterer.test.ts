import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

for (const path of [
  "../prompts/error-clusterer/explain.mdx",
  "../prompts/error-clusterer/update.mdx",
]) mock.module(path, () => ({ default: () => "prompt" }));

test("covers error-clusterer", async () => {
  const result = await coverExample("../error-clusterer.jsx", {
    mocks: {
      ingest: {
        errors: [
          { id: "a", source: "ci", message: "boom", timestamp: "2026-07-26", fingerprint: "boom" },
          { id: "b", source: "ci", message: "boom", timestamp: "2026-07-27", fingerprint: "boom" },
        ],
        totalIngested: 2,
        sources: { ci: 2, api: 0, runtime: 0 },
      },
    },
    expectedNodes: ["ingest", "cluster", "explain", "kb-update"],
  });

  expect(result.executed).toEqual(["ingest", "cluster", "explain", "kb-update"]);
  expect(result.taskOutputs.cluster[0]).toMatchObject({
    totalClusters: 1,
    largestClusterSize: 2,
  });
});
