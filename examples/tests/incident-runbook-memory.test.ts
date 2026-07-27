import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers incident-runbook-memory", async () => {
  const result = await coverExample("../incident-runbook-memory.jsx", {
    mocks: {
      recall: {
        rules: [],
        lessons: ["retry", "warm cache", "check capacity"],
        lessonIds: ["l1", "l2", "l3"],
        onCall: "ops",
        lessonCount: 3,
      },
    },
    approvals: { ratify: "approve" },
  });

  expect(result.executed).toEqual(["recall", "triage", "bank", "distill", "ratify"]);
  expect(result.taskOutputs.ratify[0]).toMatchObject({
    ratifiedNoteId: expect.any(String),
    supersededCount: expect.any(Number),
  });
});
