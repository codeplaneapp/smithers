import { describe, it, expect } from "bun:test";
import type { GatewayEventFrame } from "@smithers-orchestrator/gateway-client";
import { normalizeFrame, unwrapEvent, nodeLogEvents } from "../src/modes/eventFrame.ts";
import { extractEventText, extractAttemptKeys, filterEventsByAttempt } from "../src/modes/logUtils.ts";
import { classifyFrame, extractNodeSnapshots } from "../src/modes/timelineUtils.ts";
import { activeNodeIdsFromEvents, hijackCandidates } from "../src/modes/hijackUtils.ts";

/**
 * The REAL gateway shape: an outer `run.event` frame whose payload is
 * `{ streamId, seq, event, payload }` — the engine event name under
 * `payload.event` and its data under `payload.payload`. These tests feed that
 * wrapped shape and assert every event reader unwraps it.
 */
function wrapped(seq: number, engineEvent: string, enginePayload?: unknown): GatewayEventFrame {
  return {
    type: "event",
    seq,
    event: "run.event",
    payload: { streamId: "stream-1", seq, event: engineEvent, payload: enginePayload },
    stateVersion: seq,
  };
}

/** A flat engine event (some callers/tests still pass these). */
function flat(seq: number, event: string, payload?: unknown): GatewayEventFrame {
  return { type: "event", seq, event, payload, stateVersion: seq };
}

describe("unwrapEvent / normalizeFrame", () => {
  it("unwraps a real run.event envelope to the engine event + payload", () => {
    const ev = wrapped(7, "tool.use", { nodeId: "n-1", name: "bash", iteration: 2 });
    const { name, payload } = unwrapEvent(ev);
    expect(name).toBe("tool.use");
    expect(payload).toEqual({ nodeId: "n-1", name: "bash", iteration: 2 });
  });

  it("normalizeFrame surfaces event/payload/seq/nodeId from the envelope", () => {
    const norm = normalizeFrame(wrapped(9, "node.start", { nodeId: "n-2", name: "task" }));
    expect(norm).toEqual({
      event: "node.start",
      payload: { nodeId: "n-2", name: "task" },
      seq: 9,
      nodeId: "n-2",
    });
  });

  it("passes a flat engine event straight through", () => {
    const norm = normalizeFrame(flat(3, "node.end", { node_id: "n-3" }));
    expect(norm.event).toBe("node.end");
    expect(norm.nodeId).toBe("n-3");
  });

  it("treats a literal run.event without an inner event name as flat", () => {
    // payload has no string `event` field → not the envelope, leave it as-is.
    const norm = normalizeFrame(flat(1, "run.event", { nodeId: "n-4", text: "hi" }));
    expect(norm.event).toBe("run.event");
    expect(norm.nodeId).toBe("n-4");
  });

  it("handles a wrapped envelope with an undefined inner payload", () => {
    const norm = normalizeFrame(wrapped(2, "run.heartbeat"));
    expect(norm.event).toBe("run.heartbeat");
    expect(norm.payload).toBeUndefined();
    expect(norm.nodeId).toBeUndefined();
  });
});

describe("nodeLogEvents", () => {
  it("filters wrapped frames to the node id", () => {
    const events = [
      wrapped(1, "node.start", { nodeId: "n-1", iteration: 0 }),
      wrapped(2, "tool.use", { nodeId: "n-2", iteration: 0, name: "bash" }),
      wrapped(3, "node.end", { nodeId: "n-1", iteration: 0 }),
    ];
    expect(nodeLogEvents(events, "n-1", undefined).map((e) => e.seq)).toEqual([1, 3]);
  });

  it("shows only the selected iteration's events when node.iteration is set", () => {
    const events = [
      wrapped(1, "node.start", { nodeId: "n-1", iteration: 0 }),
      wrapped(2, "tool.use", { nodeId: "n-1", iteration: 0, name: "bash" }),
      wrapped(3, "node.start", { nodeId: "n-1", iteration: 1 }),
      wrapped(4, "tool.use", { nodeId: "n-1", iteration: 1, name: "read_file" }),
    ];
    expect(nodeLogEvents(events, "n-1", 1).map((e) => e.seq)).toEqual([3, 4]);
    expect(nodeLogEvents(events, "n-1", 0).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("treats a missing payload iteration as iteration 0", () => {
    const events = [
      wrapped(1, "stream.chunk", { nodeId: "n-1", text: "hi" }), // no iteration
      wrapped(2, "tool.use", { nodeId: "n-1", iteration: 1, name: "bash" }),
    ];
    expect(nodeLogEvents(events, "n-1", 0).map((e) => e.seq)).toEqual([1]);
  });

  it("matches the attempt alias when filtering logs for a loop/retry attempt", () => {
    const events = [
      wrapped(1, "node.start", { nodeId: "loop", attempt: 0 }),
      wrapped(2, "tool.use", { nodeId: "loop", attempt: 1, name: "bash" }),
      wrapped(3, "tool.use", { nodeId: "loop", iteration: 1, name: "read_file" }),
    ];
    expect(nodeLogEvents(events, "loop", 1).map((e) => e.seq)).toEqual([2, 3]);
    expect(nodeLogEvents(events, "loop", 0).map((e) => e.seq)).toEqual([1]);
  });

  it("matches by id alone for container nodes (iteration undefined)", () => {
    const events = [
      wrapped(1, "node.start", { nodeId: "n-1", iteration: 0 }),
      wrapped(2, "node.start", { nodeId: "n-1", iteration: 5 }),
    ];
    expect(nodeLogEvents(events, "n-1", undefined).map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe("log readers on wrapped frames", () => {
  it("extracts text from the inner payload", () => {
    expect(extractEventText(...readerArgs(wrapped(1, "run.event", { text: "hello" })))).toBe("hello");
  });

  it("extracts attempt keys from wrapped node events", () => {
    const events = [
      wrapped(1, "node.start", { nodeId: "n-1", iteration: 0 }),
      wrapped(2, "tool.use", { nodeId: "n-1", iteration: 0, name: "bash" }),
      wrapped(3, "node.start", { nodeId: "n-1", iteration: 1 }),
    ];
    expect(extractAttemptKeys(events)).toEqual(["n-1:0", "n-1:1"]);
  });

  it("filters wrapped events by attempt", () => {
    const events = [
      wrapped(1, "node.start", { nodeId: "n-1", iteration: 0 }),
      wrapped(2, "node.start", { nodeId: "n-1", iteration: 1 }),
      wrapped(3, "node.start", { nodeId: "n-2", iteration: 0 }),
    ];
    expect(filterEventsByAttempt(events, "n-1:1").map((e) => e.seq)).toEqual([2]);
  });
});

describe("timeline readers on wrapped frames", () => {
  it("classifies frames by the inner event name", () => {
    expect(classifyFrame(wrapped(1, "approval.requested", { nodeId: "n-1" }))).toBe("gate");
    expect(classifyFrame(wrapped(2, "tool.use", { nodeId: "n-1" }))).toBe("notable");
    expect(classifyFrame(wrapped(3, "stream.chunk", { nodeId: "n-1" }))).toBe("normal");
  });

  it("reconstructs node snapshots from wrapped events", () => {
    const events = [
      wrapped(1, "node.start", { nodeId: "n-1", name: "task-a" }),
      wrapped(5, "node.end", { nodeId: "n-1" }),
    ];
    const before = extractNodeSnapshots(events, 4);
    expect(before).toHaveLength(1);
    expect(before[0]!.status).toBe("running");
    expect(before[0]!.name).toBe("task-a");
    const after = extractNodeSnapshots(events, 5);
    expect(after[0]!.status).toBe("done");
  });
});

describe("hijack readers on wrapped frames", () => {
  it("derives active node ids from wrapped start/end events", () => {
    const events = [
      wrapped(1, "node.start", { nodeId: "n-1" }),
      wrapped(2, "node.start", { nodeId: "n-2" }),
      wrapped(3, "node.end", { nodeId: "n-1" }),
    ];
    const active = activeNodeIdsFromEvents(events);
    expect(active.has("n-2")).toBe(true);
    expect(active.has("n-1")).toBe(false);
  });

  it("tracks active loop/retry attempts independently for hijack detection", () => {
    const events = [
      wrapped(1, "node.start", { nodeId: "loop", iteration: 0 }),
      wrapped(2, "node.start", { nodeId: "loop", iteration: 1 }),
      wrapped(3, "node.end", { nodeId: "loop", iteration: 0 }),
    ];

    expect(activeNodeIdsFromEvents(events).has("loop")).toBe(true);
    expect(
      activeNodeIdsFromEvents([...events, wrapped(4, "node.end", { nodeId: "loop", iteration: 1 })]).has("loop"),
    ).toBe(false);
  });

  it("builds hijack candidates from wrapped events even when the tree is empty", () => {
    const events = [wrapped(1, "node.start", { nodeId: "n-9" })];
    const candidates = hijackCandidates([], events);
    expect(candidates.map((n) => n.id)).toEqual(["n-9"]);
    expect(candidates[0]!.status).toBe("running");
  });
});

/**
 * The log render path unwraps a frame once, then passes `(event, payload)` to the
 * pure helpers — mirror that here so the helper-level assertions exercise the
 * same values the component computes.
 */
function readerArgs(ev: GatewayEventFrame): [string, unknown] {
  const { event, payload } = normalizeFrame(ev);
  return [event, payload];
}
