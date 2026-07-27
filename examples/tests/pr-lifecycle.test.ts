import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers pr-lifecycle", async () => {
  const result = await coverExample("../pr-lifecycle.jsx", {
    maxLoopIterations: 2,
    mocks: {
      rebase: { conflicts: false, conflictFiles: [], summary: "rebased" },
      review: { issues: [], approved: true, summary: "approved" },
      push: { pushed: true, forced: false, remote: "origin", branch: "feature", summary: "pushed" },
      "poll-ci": ({ iteration }: { iteration: number }) => ({
        status: iteration > 0 ? "pass" : "pending",
        checks: [{ name: "test", status: iteration > 0 ? "pass" : "pending" }],
        mergeable: true,
      }),
      merge: { merged: true, sha: "abc123" },
    },
    expectedNodes: ["rebase", "review", "push", "poll-ci", "merge"],
  });

  expect(result.executed).toEqual(["rebase", "review", "push", "poll-ci", "poll-ci", "merge"]);
  expect(result.taskOutputs["poll-ci"]).toHaveLength(2);
  expect(result.taskOutputs.merge[0]).toMatchObject({ merged: true, sha: "abc123" });
}, 30_000);
