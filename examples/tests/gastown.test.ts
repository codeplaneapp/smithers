import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers gastown", async () => {
  const nodes = [
    "mayor", "convoy-create", "sling-gt-a", "polecat-gt-a",
    "mr-create-gt-a", "merge-gt-a", "convoy-close", "report",
  ];
  const result = await coverExample("../gastown.jsx", {
    input: { goal: "add coverage", maxAgents: 1 },
    mocks: {
      mayor: {
        convoyId: "convoy-a",
        beads: [{
          id: "gt-a", title: "Add test", description: "Cover workflow", files: ["test.ts"],
          priority: 1, acceptanceCriteria: "test passes",
        }],
      },
      "polecat-gt-a": {
        beadId: "gt-a", polecatName: "Toast", branch: "polecat/gt-a", state: "done",
        summary: "done", filesChanged: ["test.ts"], commitCount: 1, exitType: "completed",
      },
      "merge-gt-a": {
        id: "mr-gt-a", branch: "polecat/gt-a", worker: "Toast", issueId: "gt-a",
        targetBranch: "main", phase: "merged",
      },
    },
    expectedNodes: nodes,
    // A completed one-worker convoy never needs the transitional witness patrol.
    allowUnreached: ["witness-patrol"],
  });

  expect(result.executed).toEqual(nodes);
  expect(result.taskOutputs["convoy-close"][0]).toMatchObject({
    status: "closed", completedTasks: 1,
  });
});
