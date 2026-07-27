import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers parallel-tickets", async () => {
  const ticket = { id: "a", title: "A", description: "Implement A", files: [], dependsOn: [] };
  const result = await coverExample("../parallel-tickets.jsx", {
    input: { directory: ".", tickets: [ticket], maxIterations: 3 },
    mocks: {
      triage: {
        tickets: [ticket],
        waves: [{ index: 0, ticketIds: ["a"], rationale: "independent" }],
        summary: "one wave",
      },
      "implement-a": ({ iteration }: { iteration: number }) => ({
        ticketId: "a",
        status: iteration === 0 ? "needs_docs" : "complete",
        branch: "ticket/a",
        summary: "implementation",
        filesChanged: [],
        commitCount: iteration,
        docRequests: iteration === 0 ? [{ topic: "api", questions: ["How?"] }] : [],
      }),
      "research-a": {
        ticketId: "a",
        requestsAddressed: ["How?"],
        docsWritten: ["wiki/api.md"],
        summary: "researched",
      },
      "review-a": { ticketId: "a", approved: true, feedback: "ok", issues: [] },
      "merge-a": { ticketId: "a", branch: "ticket/a", status: "merged", note: "merged" },
    },
    maxLoopIterations: 3,
    executeCompute: true,
  });

  expect(result.executed).toEqual([
    "triage", "implement-a", "research-a", "implement-a", "review-a", "merge-a", "report",
  ]);
  expect(result.taskOutputs["implement-a"]).toHaveLength(2);
  expect(result.taskOutputs.report[0]).toMatchObject({ totalTickets: 1, waves: 1, merged: 1 });
}, 15_000);
