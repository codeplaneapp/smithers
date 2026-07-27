import { describe, expect, test } from "bun:test";
import { nodeStatusColor, nodeStatusGlyph } from "../src/StatusGlyph.tsx";

describe("nodeStatusGlyph", () => {
  test("maps done-ish statuses to a check", () => {
    expect(nodeStatusGlyph("done")).toBe("✓");
    expect(nodeStatusGlyph("completed")).toBe("✓");
    expect(nodeStatusGlyph("ok")).toBe("✓");
  });

  test("distinguishes cancelled from failed", () => {
    expect(nodeStatusGlyph("cancelled")).toBe("⊘");
    expect(nodeStatusGlyph("failed")).toBe("✗");
  });

  test("falls back to a dim dot for an unknown status", () => {
    expect(nodeStatusGlyph("some-unknown-status")).toBe("·");
  });
});

describe("nodeStatusColor", () => {
  test("cancelled is dim grey, not the failure red", () => {
    expect(nodeStatusColor("cancelled")).toBe("#888888");
    expect(nodeStatusColor("failed")).not.toBe(nodeStatusColor("cancelled"));
  });

  test("returns a hex color for every known status", () => {
    for (const status of ["done", "running", "waiting", "queued", "cancelled", "failed", "unknown"]) {
      expect(nodeStatusColor(status)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
