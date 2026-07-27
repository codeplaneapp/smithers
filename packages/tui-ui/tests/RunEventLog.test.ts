import { describe, expect, test } from "bun:test";
import { formatRunEventLogRow } from "../src/RunEventLog.tsx";

describe("formatRunEventLogRow", () => {
  test("formats seq, event name, and payload on one line", () => {
    expect(formatRunEventLogRow({ seq: 3, event: "node.started", payload: "{}" })).toBe(
      "  [3] node.started  {}",
    );
  });
});
