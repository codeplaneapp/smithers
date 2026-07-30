import { describe, expect, test } from "bun:test";
import { formatRunEventLogRow } from "../src/RunEventLog.tsx";

describe("formatRunEventLogRow", () => {
  test("formats seq, event name, and payload on one line", () => {
    expect(formatRunEventLogRow({ seq: 3, event: "node.started", payload: "{}" })).toBe("  [3] node.started  {}");
  });

  test("sanitizes gateway-supplied event fields", () => {
    expect(
      formatRunEventLogRow({
        seq: 4,
        event: "node\x1b[2J.started",
        payload: "safe\x1b]52;c;c2VjcmV0\x07\x07",
      }),
    ).toBe("  [4] node.started  safe");
  });
});
