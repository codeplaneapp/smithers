import { describe, expect, test } from "bun:test";
import { statusLabel, statusTone, type NodeStatus, type StatusTone } from "../../src/runs/statusMeta.ts";

const CASES: Array<{ status: NodeStatus; tone: StatusTone; label: string }> = [
  { status: "running", tone: "running", label: "running" },
  { status: "ok", tone: "ok", label: "ok" },
  { status: "queued", tone: "idle", label: "queued" },
  { status: "waiting", tone: "waiting", label: "waiting" },
  { status: "failed", tone: "failed", label: "failed" },
  { status: "cancelled", tone: "idle", label: "cancelled" },
  { status: "unknown", tone: "idle", label: "unknown" },
];

describe("statusMeta", () => {
  test("maps every node status to its display tone", () => {
    for (const { status, tone } of CASES) {
      expect(statusTone(status)).toBe(tone);
    }
  });

  test("maps every node status to its label", () => {
    for (const { status, label } of CASES) {
      expect(statusLabel(status)).toBe(label);
    }
  });
});
