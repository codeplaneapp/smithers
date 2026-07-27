import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const Prompt = () => "test prompt";
mock.module("../prompts/change-blast-radius/gather.mdx", () => ({ default: Prompt }));
mock.module("../prompts/change-blast-radius/blast-radius.mdx", () => ({ default: Prompt }));

test("covers change-blast-radius", async () => {
  const result = await coverExample("../change-blast-radius.jsx", {
    input: { diff: "diff --git a/api.ts b/api.ts" },
    executeCompute: true,
    mocks: {
      "parse-diff": {
        files: [{ path: "api.ts", changeType: "modified", hunks: 1, linesChanged: 3 }],
        totalFiles: 1,
        summary: "api changed",
      },
      "gather-context": {
        dependencies: [{ source: "web", dependsOn: ["api.ts"], service: "web" }],
        relatedTests: ["api.test.ts"], relatedDocs: ["api.md"],
        owners: [{ team: "platform", files: ["api.ts"] }], summary: "one dependent",
      },
      "blast-radius": {
        impactedServices: [{ name: "web", risk: "high", reason: "imports api" }],
        impactedTests: ["api.test.ts"], impactedDocs: ["api.md"], owners: ["platform"],
        overallRisk: "high", summary: "web is affected",
      },
    },
  });

  expect(result.executed).toEqual(["parse-diff", "gather-context", "blast-radius"]);
  expect(result.taskOutputs["blast-radius"][0]).toMatchObject({
    overallRisk: "high",
    impactedServices: [{ name: "web", risk: "high", reason: "imports api" }],
    owners: ["platform"],
  });
});
