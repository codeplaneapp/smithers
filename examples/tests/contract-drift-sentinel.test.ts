import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const Prompt = () => "test prompt";
mock.module("../prompts/contract-drift-sentinel/diff.mdx", () => ({ default: Prompt }));
mock.module("../prompts/contract-drift-sentinel/analyze.mdx", () => ({ default: Prompt }));

test("covers contract-drift-sentinel", async () => {
  const result = await coverExample("../contract-drift-sentinel.jsx", {
    input: { baselinePath: "old.yaml", currentPath: "new.yaml", consumers: ["web"] },
    executeCompute: true,
    mocks: {
      load: { format: "openapi", version: "1", baseline: "old", current: "new", entities: ["/users"] },
      diff: {
        additions: [], removals: [{ path: "/users.name", description: "removed" }],
        modifications: [], breakingCandidates: ["/users.name"], totalChanges: 1,
      },
      analyze: {
        breakingChanges: [{
          path: "/users.name", severity: "high", reason: "removed",
          affectedConsumers: ["web"], migrationHint: "restore field",
        }],
        safeChanges: [], riskScore: 80, summary: "breaking",
      },
      output: {
        status: "block", prComment: "restore field", breakingCount: 1,
        riskScore: 80, summary: "breaking",
      },
    },
  });

  expect(result.executed).toEqual(["load", "diff", "analyze", "output"]);
  expect(result.taskOutputs.output[0]).toMatchObject({
    status: "block", breakingCount: 1, riskScore: 80,
  });
});
