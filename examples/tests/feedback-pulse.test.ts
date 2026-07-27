import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

for (const path of [
  "../prompts/feedback-pulse/extract.mdx",
  "../prompts/feedback-pulse/notify.mdx",
]) mock.module(path, () => ({ default: () => "prompt" }));

test("covers feedback-pulse", async () => {
  const result = await coverExample("../feedback-pulse.jsx", {
    mocks: {
      intake: {
        items: [{
          id: "f-1", source: "survey", text: "Search is slow", timestamp: "2026-07-27",
        }],
        totalCount: 1,
        dateRange: { from: "2026-07-20", to: "2026-07-27" },
        summary: "one response",
      },
    },
    expectedNodes: ["intake", "extract", "notify"],
  });

  expect(result.executed).toEqual(["intake", "extract", "notify"]);
  expect(result.taskOutputs.intake[0]).toMatchObject({ totalCount: 1 });
  expect(result.taskOutputs.notify[0]).toMatchObject({
    slackMessages: expect.any(Array),
    jiraTickets: expect.any(Array),
  });
});
