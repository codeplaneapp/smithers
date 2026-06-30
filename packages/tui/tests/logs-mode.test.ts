import { describe, it, expect } from "bun:test";
import type { GatewayEventFrame } from "@smithers-orchestrator/gateway-client";
import {
  extractNodeId,
  extractIteration,
  extractEventText,
  makeAttemptKey,
  extractAttemptKeys,
  filterEventsByAttempt,
} from "../src/modes/logUtils.ts";

function frame(
  seq: number,
  event: string,
  payload?: unknown,
): GatewayEventFrame {
  return { type: "event", seq, event, payload, stateVersion: seq };
}

// ─── extractNodeId ────────────────────────────────────────────────────────────

describe("extractNodeId", () => {
  it("returns nodeId field", () => {
    expect(extractNodeId({ nodeId: "n-1" })).toBe("n-1");
  });

  it("returns node_id field", () => {
    expect(extractNodeId({ node_id: "n-2" })).toBe("n-2");
  });

  it("returns nodeid field", () => {
    expect(extractNodeId({ nodeid: "n-3" })).toBe("n-3");
  });

  it("returns null when no id field present", () => {
    expect(extractNodeId({ other: "value" })).toBeNull();
    expect(extractNodeId(null)).toBeNull();
    expect(extractNodeId(undefined)).toBeNull();
    expect(extractNodeId("string")).toBeNull();
  });

  it("returns null when id field is not a string", () => {
    expect(extractNodeId({ nodeId: 123 })).toBeNull();
    expect(extractNodeId({ nodeId: null })).toBeNull();
  });
});

// ─── extractIteration ────────────────────────────────────────────────────────

describe("extractIteration", () => {
  it("returns iteration field", () => {
    expect(extractIteration({ iteration: 2 })).toBe(2);
  });

  it("returns attempt field", () => {
    expect(extractIteration({ attempt: 3 })).toBe(3);
  });

  it("returns null when absent", () => {
    expect(extractIteration({ nodeId: "n" })).toBeNull();
    expect(extractIteration(null)).toBeNull();
  });

  it("returns null when field is not a number", () => {
    expect(extractIteration({ iteration: "2" })).toBeNull();
  });
});

// ─── extractEventText ────────────────────────────────────────────────────────

describe("extractEventText", () => {
  it("returns text field", () => {
    expect(extractEventText("run.event", { text: "hello world" })).toBe("hello world");
  });

  it("returns content field when no text", () => {
    expect(extractEventText("run.event", { content: "content here" })).toBe("content here");
  });

  it("returns message field when no text or content", () => {
    expect(extractEventText("run.event", { message: "msg" })).toBe("msg");
  });

  it("returns tool name with parens for tool events", () => {
    expect(extractEventText("tool.use", { name: "read_file" })).toBe("read_file(…)");
    expect(extractEventText("tool.use", { tool: "bash" })).toBe("bash(…)");
  });

  it("falls back to JSON for unknown payload", () => {
    const result = extractEventText("run.event", { foo: "bar" });
    expect(result).toContain("foo");
  });

  it("returns event name when payload is null/undefined", () => {
    expect(extractEventText("run.heartbeat", null)).toBe("run.heartbeat");
    expect(extractEventText("run.heartbeat", undefined)).toBe("run.heartbeat");
  });

  it("truncates long text to 200 chars", () => {
    const long = "x".repeat(300);
    expect(extractEventText("run.event", { text: long })).toHaveLength(200);
  });
});

// ─── makeAttemptKey ──────────────────────────────────────────────────────────

describe("makeAttemptKey", () => {
  it("formats nodeId:iteration", () => {
    expect(makeAttemptKey("n-1", 2)).toBe("n-1:2");
  });

  it("defaults iteration 0 for null", () => {
    expect(makeAttemptKey("n-1", null)).toBe("n-1:0");
  });
});

// ─── extractAttemptKeys ──────────────────────────────────────────────────────

describe("extractAttemptKeys", () => {
  it("returns empty array for events with no nodeId", () => {
    const events = [frame(1, "run.heartbeat"), frame(2, "run.event", { text: "hi" })];
    expect(extractAttemptKeys(events)).toHaveLength(0);
  });

  it("returns unique attempt keys in order of first appearance", () => {
    const events = [
      frame(1, "run.event", { nodeId: "n-1", iteration: 0 }),
      frame(2, "run.event", { nodeId: "n-1", iteration: 0 }),
      frame(3, "run.event", { nodeId: "n-2", iteration: 0 }),
      frame(4, "run.event", { nodeId: "n-1", iteration: 1 }),
    ];
    expect(extractAttemptKeys(events)).toEqual(["n-1:0", "n-2:0", "n-1:1"]);
  });

  it("defaults iteration to 0 when absent", () => {
    const events = [frame(1, "run.event", { nodeId: "n-1" })];
    expect(extractAttemptKeys(events)).toEqual(["n-1:0"]);
  });
});

// ─── filterEventsByAttempt ───────────────────────────────────────────────────

describe("filterEventsByAttempt", () => {
  const events = [
    frame(1, "run.event", { nodeId: "n-1", iteration: 0 }),
    frame(2, "run.event", { nodeId: "n-1", iteration: 1 }),
    frame(3, "run.event", { nodeId: "n-2", iteration: 0 }),
    frame(4, "run.event", { nodeId: "n-1", iteration: 0 }),
  ];

  it("filters to the matching nodeId and iteration", () => {
    const result = filterEventsByAttempt(events, "n-1:0");
    expect(result.map((e) => e.seq)).toEqual([1, 4]);
  });

  it("filters iteration 1 for n-1", () => {
    const result = filterEventsByAttempt(events, "n-1:1");
    expect(result.map((e) => e.seq)).toEqual([2]);
  });

  it("filters by node n-2", () => {
    const result = filterEventsByAttempt(events, "n-2:0");
    expect(result.map((e) => e.seq)).toEqual([3]);
  });

  it("returns empty when no match", () => {
    const result = filterEventsByAttempt(events, "n-3:0");
    expect(result).toHaveLength(0);
  });
});
