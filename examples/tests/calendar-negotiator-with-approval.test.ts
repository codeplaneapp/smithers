import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers calendar-negotiator-with-approval", async () => {
  const result = await coverExample("../calendar-negotiator-with-approval.jsx", {
    expectedNodes: [
      "parse-request", "check-organizer-calendar", "check-room-calendar",
      "check-work-hours", "rank-slots", "draft-reply",
      "approve-calendar-write", "create-event", "send-reply",
    ],
  });

  expect(result.approvals[0]).toMatchObject({
    nodeId: "approve-calendar-write",
    approved: true,
  });
});
