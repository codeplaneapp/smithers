import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

mock.module("../prompts/meeting-briefer/brief.mdx", () => ({
  default: () => "meeting brief",
}));

test("covers meeting-briefer", async () => {
  const result = await coverExample("../meeting-briefer.jsx", {
    input: { event: { title: "Renewal", attendees: ["a@example.com"] } },
    mocks: {
      trigger: {
        meetingId: "m1",
        title: "Renewal",
        organizer: "owner@example.com",
        attendees: ["a@example.com"],
        scheduledAt: "2026-08-01T10:00:00Z",
        calendarSource: "other",
        summary: "renewal meeting",
      },
      "history-context": {
        previousMeetings: [],
        openActionItems: [],
        summary: "no history",
      },
    },
  });

  expect(result.executed).toEqual([
    "trigger", "classify", "crm-context", "attendee-context", "history-context", "brief",
  ]);
  expect(result.taskOutputs.brief[0]).toMatchObject({
    meetingId: expect.any(String),
    talkingPoints: expect.any(Array),
    suggestedAgenda: expect.any(Array),
  });
});
