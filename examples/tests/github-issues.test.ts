import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers github-issues", async () => {
  const result = await coverExample("../github-issues.jsx", {
    input: { repo: "smithersai/smithers" },
    mocks: {
      triage: {
        repo: "smithersai/smithers",
        issues: [
          { number: 1, title: "Crash", type: "bug", priority: "P0", suggestedLabels: ["bug"] },
          { number: 2, title: "Docs", type: "chore", priority: "P2", suggestedLabels: ["docs"] },
        ],
      },
    },
    executeCompute: true,
    expectedNodes: ["triage", "build-board"],
  });

  expect(result.executed).toEqual(["triage", "build-board"]);
  expect(result.taskOutputs["build-board"][0]).toMatchObject({
    repo: "smithersai/smithers",
    total: 2,
    columns: expect.arrayContaining([
      { name: "bug", cards: [{ number: 1, title: "Crash", priority: "P0" }] },
    ]),
  });
});
