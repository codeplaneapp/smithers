import { describe, it, expect } from "bun:test";
import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";
import {
  runningNodes,
  nodeSelectOption,
  hijackExitMessage,
} from "../src/modes/hijackUtils.ts";

function node(id: string, overrides: Partial<GatewayRunNode> = {}): GatewayRunNode {
  return { id, name: id, kind: "task", status: "done", ...overrides };
}

// ─── runningNodes ─────────────────────────────────────────────────────────────

describe("runningNodes", () => {
  it("returns empty for empty input", () => {
    expect(runningNodes([])).toHaveLength(0);
  });

  it("returns only running nodes", () => {
    const nodes = [
      node("a", { status: "running" }),
      node("b", { status: "done" }),
      node("c", { status: "active" }),
      node("d", { status: "waiting" }),
      node("e", { status: "failed" }),
    ];
    const result = runningNodes(nodes);
    expect(result.map((n) => n.id)).toEqual(["a", "c"]);
  });

  it("accepts 'active' as running", () => {
    const nodes = [node("x", { status: "active" })];
    expect(runningNodes(nodes)).toHaveLength(1);
  });

  it("excludes waiting, queued, done, failed", () => {
    const statuses = ["waiting", "queued", "done", "failed", "error", "pending"];
    const nodes = statuses.map((s, i) => node(`n${i}`, { status: s }));
    expect(runningNodes(nodes)).toHaveLength(0);
  });
});

// ─── nodeSelectOption ─────────────────────────────────────────────────────────

describe("nodeSelectOption", () => {
  it("uses node name as select name", () => {
    const opt = nodeSelectOption(node("n1", { name: "my-task" }));
    expect(opt.name).toBe("my-task");
  });

  it("falls back to node id when name is absent", () => {
    const n = node("n1");
    (n as any).name = undefined;
    const opt = nodeSelectOption(n);
    expect(opt.name).toBe("n1");
  });

  it("sets value to node id", () => {
    const opt = nodeSelectOption(node("abc-123"));
    expect(opt.value).toBe("abc-123");
  });

  it("includes node id, kind, and status in description", () => {
    const opt = nodeSelectOption(node("n1", { kind: "agent", status: "running" }));
    expect(opt.description).toContain("n1");
    expect(opt.description).toContain("agent");
    expect(opt.description).toContain("running");
  });

  it("handles unknown kind gracefully", () => {
    const n = node("n2", { status: "active" });
    (n as any).kind = undefined;
    const opt = nodeSelectOption(n);
    expect(opt.description).toContain("task");
  });
});

// ─── hijackExitMessage ────────────────────────────────────────────────────────

describe("hijackExitMessage", () => {
  it("returns 'exited ok' for code 0", () => {
    expect(hijackExitMessage(0)).toBe("exited ok");
  });

  it("returns code in message for non-zero exit", () => {
    expect(hijackExitMessage(1)).toBe("exited (code 1)");
    expect(hijackExitMessage(127)).toBe("exited (code 127)");
  });

  it("returns error message for null code", () => {
    expect(hijackExitMessage(null)).toBe("exited (error)");
  });
});
