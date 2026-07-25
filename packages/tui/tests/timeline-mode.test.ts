import { describe, it, expect } from "bun:test";
import type { GatewayEventFrame } from "@smithers-orchestrator/gateway-client";
import {
  classifyFrame,
  frameTickChar,
  frameTickColor,
  extractNodeSnapshots,
  nodeStatusGlyph,
  nodeStatusColor,
  resolveFrameIdx,
  snapshotKey,
} from "../src/modes/timelineUtils.ts";

function frame(seq: number, event: string, payload?: unknown): GatewayEventFrame {
  return { type: "event", seq, event, payload, stateVersion: seq };
}

// ─── classifyFrame ────────────────────────────────────────────────────────────

describe("classifyFrame", () => {
  it("classifies gate events", () => {
    expect(classifyFrame(frame(1, "approval.requested"))).toBe("gate");
    expect(classifyFrame(frame(2, "gate.raised"))).toBe("gate");
    expect(classifyFrame(frame(3, "node.waiting"))).toBe("gate");
  });

  it("classifies notable events", () => {
    expect(classifyFrame(frame(1, "tool.use"))).toBe("notable");
    expect(classifyFrame(frame(2, "agent.start"))).toBe("notable");
    expect(classifyFrame(frame(3, "node.start"))).toBe("notable");
    expect(classifyFrame(frame(4, "node.end"))).toBe("notable");
    expect(classifyFrame(frame(5, "run.heartbeat"))).toBe("notable");
  });

  it("classifies generic events as normal", () => {
    expect(classifyFrame(frame(1, "run.event"))).toBe("normal");
    expect(classifyFrame(frame(2, "stream.chunk"))).toBe("normal");
    expect(classifyFrame(frame(3, "metadata.update"))).toBe("normal");
  });

  it("is case-insensitive", () => {
    expect(classifyFrame(frame(1, "APPROVAL.REQUESTED"))).toBe("gate");
    expect(classifyFrame(frame(2, "TOOL.USE"))).toBe("notable");
  });
});

// ─── frameTickChar ────────────────────────────────────────────────────────────

describe("frameTickChar", () => {
  it("returns block for selected frame regardless of marker", () => {
    expect(frameTickChar("normal", true)).toBe("█");
    expect(frameTickChar("notable", true)).toBe("█");
    expect(frameTickChar("gate", true)).toBe("█");
  });

  it("returns gate char for unselected gate frames", () => {
    expect(frameTickChar("gate", false)).toBe("⊛");
  });

  it("returns pipe for unselected notable frames", () => {
    expect(frameTickChar("notable", false)).toBe("│");
  });

  it("returns dot for unselected normal frames", () => {
    expect(frameTickChar("normal", false)).toBe("·");
  });
});

// ─── frameTickColor ───────────────────────────────────────────────────────────

describe("frameTickColor", () => {
  it("returns cyan for selected frame", () => {
    expect(frameTickColor("normal", true)).toBe("#00d7ff");
    expect(frameTickColor("gate", true)).toBe("#00d7ff");
    expect(frameTickColor("notable", true)).toBe("#00d7ff");
  });

  it("returns yellow for unselected gate", () => {
    expect(frameTickColor("gate", false)).toBe("#ffaf00");
  });

  it("returns grey for unselected notable", () => {
    expect(frameTickColor("notable", false)).toBe("#888888");
  });

  it("returns dim for unselected normal", () => {
    expect(frameTickColor("normal", false)).toBe("#333333");
  });
});

// ─── resolveFrameIdx ──────────────────────────────────────────────────────────

describe("resolveFrameIdx", () => {
  const ring = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => frame(from + i, "run.event"));

  it("follows the newest frame when the anchor is null (live)", () => {
    expect(resolveFrameIdx(ring(1, 8), null)).toBe(7);
    expect(resolveFrameIdx([], null)).toBe(0);
  });

  it("resolves the anchored seq to its current index", () => {
    expect(resolveFrameIdx(ring(1, 8), 6)).toBe(5);
  });

  it("keeps the pinned frame as the ring evicts older rows", () => {
    // Same pinned seq, ring slid forward by 3: index must follow the frame, not
    // stay put (which would silently show a later run state).
    expect(resolveFrameIdx(ring(4, 11), 6)).toBe(2);
    expect(resolveFrameIdx(ring(6, 13), 6)).toBe(0);
  });

  it("falls back to the nearest retained frame once the anchor is evicted", () => {
    // seq 6 has fallen out of the ring: land on the oldest RETAINED frame, never
    // slide forward to a later one.
    expect(resolveFrameIdx(ring(9, 16), 6)).toBe(0);
  });

  it("clamps to the last frame when the list shrinks under the anchor", () => {
    // Reconnect/rewind truncation: stay in range so j/k respond immediately.
    expect(resolveFrameIdx(ring(1, 3), 7)).toBe(2);
    expect(resolveFrameIdx([], 7)).toBe(0);
  });
});

// ─── extractNodeSnapshots ─────────────────────────────────────────────────────

describe("extractNodeSnapshots", () => {
  it("returns empty array when no events have nodeId", () => {
    const events = [
      frame(1, "run.heartbeat"),
      frame(2, "run.event", { text: "hello" }),
    ];
    expect(extractNodeSnapshots(events, 999)).toHaveLength(0);
  });

  it("only includes events up to upToSeq (inclusive)", () => {
    const events = [
      frame(1, "node.start", { nodeId: "n-1", status: "running" }),
      frame(5, "node.end", { nodeId: "n-1", status: "done" }),
    ];
    // Stop before seq 5 — only see running status
    const snap = extractNodeSnapshots(events, 4);
    expect(snap).toHaveLength(1);
    expect(snap[0]!.status).toBe("running");
  });

  it("includes event at exactly upToSeq", () => {
    const events = [
      frame(1, "node.start", { nodeId: "n-1", status: "running" }),
      frame(5, "node.end", { nodeId: "n-1", status: "done" }),
    ];
    const snap = extractNodeSnapshots(events, 5);
    expect(snap[0]!.status).toBe("done");
  });

  it("tracks multiple nodes", () => {
    const events = [
      frame(1, "node.start", { nodeId: "n-1", status: "running" }),
      frame(2, "node.start", { nodeId: "n-2", status: "running" }),
      frame(3, "node.end", { nodeId: "n-1", status: "done" }),
    ];
    const snap = extractNodeSnapshots(events, 999);
    expect(snap).toHaveLength(2);
    const ids = snap.map((s) => s.id).sort();
    expect(ids).toEqual(["n-1", "n-2"]);
    const n1 = snap.find((s) => s.id === "n-1")!;
    expect(n1.status).toBe("done");
    const n2 = snap.find((s) => s.id === "n-2")!;
    expect(n2.status).toBe("running");
  });

  it("infers running status from node.start event name", () => {
    const events = [frame(1, "node.start", { nodeId: "n-1" })];
    const snap = extractNodeSnapshots(events, 999);
    expect(snap[0]!.status).toBe("running");
  });

  it("infers done status from node.end event name", () => {
    const events = [
      frame(1, "node.start", { nodeId: "n-1" }),
      frame(2, "node.end", { nodeId: "n-1" }),
    ];
    const snap = extractNodeSnapshots(events, 999);
    expect(snap[0]!.status).toBe("done");
  });

  it("infers failed status from node.fail event name", () => {
    const events = [
      frame(1, "node.start", { nodeId: "n-1" }),
      frame(2, "node.fail", { nodeId: "n-1" }),
    ];
    const snap = extractNodeSnapshots(events, 999);
    expect(snap[0]!.status).toBe("failed");
  });

  it("infers cancelled status from node.cancel event name", () => {
    const events = [
      frame(1, "node.start", { nodeId: "n-1" }),
      frame(2, "node.cancel", { nodeId: "n-1" }),
    ];
    const snap = extractNodeSnapshots(events, 999);
    expect(snap[0]!.status).toBe("cancelled");
  });

  it("infers waiting status from approval.request event", () => {
    const events = [
      frame(1, "node.start", { nodeId: "n-1" }),
      frame(2, "approval.request", { nodeId: "n-1" }),
    ];
    const snap = extractNodeSnapshots(events, 999);
    expect(snap[0]!.status).toBe("waiting");
  });

  it("prefers explicit status field over event name inference", () => {
    const events = [frame(1, "node.start", { nodeId: "n-1", status: "waiting" })];
    const snap = extractNodeSnapshots(events, 999);
    expect(snap[0]!.status).toBe("waiting");
  });

  it("captures node name from payload", () => {
    const events = [frame(1, "node.start", { nodeId: "n-1", name: "my-task" })];
    const snap = extractNodeSnapshots(events, 999);
    expect(snap[0]!.name).toBe("my-task");
  });

  it("defaults first-seen status to running when no status clues", () => {
    const events = [frame(1, "run.event", { nodeId: "n-1", text: "hi" })];
    const snap = extractNodeSnapshots(events, 999);
    expect(snap[0]!.status).toBe("running");
  });

  it("keeps loop/retry attempts of one nodeId as DISTINCT rows", () => {
    // Same logical nodeId, two iterations — must NOT collapse into one row.
    const events = [
      frame(1, "node.start", { nodeId: "n-1", iteration: 0, status: "running" }),
      frame(2, "node.fail", { nodeId: "n-1", iteration: 0, status: "failed" }),
      frame(3, "node.start", { nodeId: "n-1", iteration: 1, status: "running" }),
      frame(4, "node.end", { nodeId: "n-1", iteration: 1, status: "done" }),
    ];
    const snap = extractNodeSnapshots(events, 999);
    expect(snap).toHaveLength(2);
    const iter0 = snap.find((s) => s.iteration === 0)!;
    const iter1 = snap.find((s) => s.iteration === 1)!;
    expect(iter0.status).toBe("failed");
    expect(iter1.status).toBe("done");
    // Distinct, stable render keys per attempt.
    expect(snapshotKey(iter0.id, iter0.iteration)).not.toBe(snapshotKey(iter1.id, iter1.iteration));
  });

  it("leaves iteration undefined for container nodes with no attempt id", () => {
    const events = [frame(1, "node.start", { nodeId: "container", status: "running" })];
    const snap = extractNodeSnapshots(events, 999);
    expect(snap[0]!.iteration).toBeUndefined();
  });
});

// ─── nodeStatusGlyph ─────────────────────────────────────────────────────────

describe("nodeStatusGlyph", () => {
  it("maps known statuses to glyphs", () => {
    expect(nodeStatusGlyph("done")).toBe("✓");
    expect(nodeStatusGlyph("running")).toBe("●");
    expect(nodeStatusGlyph("waiting")).toBe("⏸");
    expect(nodeStatusGlyph("failed")).toBe("✗");
  });

  it("returns a distinct dim glyph for cancelled (not the red failure ✗)", () => {
    expect(nodeStatusGlyph("cancelled")).toBe("⊘");
    expect(nodeStatusGlyph("cancelled")).not.toBe(nodeStatusGlyph("failed"));
  });

  it("falls back to pending glyph for unknown status", () => {
    expect(nodeStatusGlyph("unknown")).toBe("○");
    expect(nodeStatusGlyph("")).toBe("○");
  });
});

// ─── nodeStatusColor ──────────────────────────────────────────────────────────

describe("nodeStatusColor", () => {
  it("maps known statuses to colors", () => {
    expect(nodeStatusColor("done")).toBe("#00d787");
    expect(nodeStatusColor("running")).toBe("#00d7ff");
    expect(nodeStatusColor("waiting")).toBe("#ffaf00");
    expect(nodeStatusColor("failed")).toBe("#ff5f5f");
  });

  it("returns dim grey for cancelled (never the red failure color)", () => {
    expect(nodeStatusColor("cancelled")).toBe("#888888");
    expect(nodeStatusColor("cancelled")).not.toBe(nodeStatusColor("failed"));
  });

  it("falls back to dim for unknown status", () => {
    expect(nodeStatusColor("unknown")).toBe("#555555");
    expect(nodeStatusColor("")).toBe("#555555");
  });
});
