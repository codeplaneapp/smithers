import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const Prompt = () => "test prompt";
for (const name of ["intake", "classify", "incident", "request", "policy"]) {
  mock.module(`../prompts/service-desk-dispatcher/${name}.mdx`, () => ({ default: Prompt }));
}

test("covers service-desk-dispatcher", async () => {
  const tickets = [
    { id: "inc", title: "Outage", category: "incident", urgency: "critical", reasoning: "down" },
    { id: "req", title: "Access", category: "request", urgency: "medium", reasoning: "needed" },
    { id: "pol", title: "Policy", category: "policy", urgency: "low", reasoning: "question" },
  ];
  const result = await coverExample("../service-desk-dispatcher.jsx", {
    mocks: {
      intake: {
        tickets: tickets.map(({ id, title }) => ({ id, title, description: title, submitter: "Ada" })),
        totalReceived: 3,
      },
      classify: { classified: tickets },
      "handle-*": ({ nodeId }: { nodeId: string }) => ({
        ticketId: nodeId.slice(7), action: "handled", status: "resolved", resolution: "done",
      }),
    },
    expectedNodes: ["intake", "classify", "handle-inc", "handle-req", "handle-pol", "report"],
  });

  expect(result.executed).toEqual([
    "intake", "classify", "handle-inc", "handle-req", "handle-pol", "report",
  ]);
  expect(result.taskOutputs.report[0]).toMatchObject({
    totalTickets: 3, incidents: 1, requests: 1, policyQuestions: 1, resolved: 3,
  });
});
