import { describe, expect, test } from "bun:test";
import { nodeGlyph, nodeGlyphColor } from "../../ui-core/src/runs/treeUtils.ts";
import { statusClass } from "../../ui/src/status.ts";
import { nodeStatusColor, nodeStatusGlyph, statusToneColor, type TuiStatusTone } from "../src/status.ts";

const NODE_STATUSES = [
  "done",
  "completed",
  "ok",
  "running",
  "active",
  "waiting",
  "paused",
  "blocked",
  "waiting_approval",
  "queued",
  "pending",
  "idle",
  "cancelled",
  "canceled",
  "failed",
  "error",
  "unknown",
] as const;

describe("status vocabulary parity", () => {
  test("keeps the local node glyph tables in sync with ui-core", () => {
    for (const status of NODE_STATUSES) {
      expect(nodeStatusGlyph(status)).toBe(nodeGlyph(status));
      expect(nodeStatusColor(status)).toBe(nodeGlyphColor(status));
    }
  });

  test("uses one color for corresponding pill tones and node statuses", () => {
    const correspondences: ReadonlyArray<readonly [string, TuiStatusTone]> = [
      ["done", "ok"],
      ["waiting", "warn"],
      ["failed", "bad"],
      ["cancelled", "muted"],
      ["running", "run"],
    ];

    for (const [status, tone] of correspondences) {
      expect(statusClass(status)).toBe(tone);
      expect(nodeStatusColor(status)).toBe(statusToneColor(tone));
    }
  });
});
