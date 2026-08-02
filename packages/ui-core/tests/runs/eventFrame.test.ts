import { describe, it, expect } from "bun:test";
import type { GatewayEventFrame } from "@smthrs/gateway-client";
import { normalizeFrame, unwrapEvent, nodeLogEvents } from "../../src/runs/eventFrame.ts";

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
