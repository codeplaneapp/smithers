import { describe, it, expect } from "bun:test";
import {
  flattenTree,
  nodeGlyph,
  nodeGlyphColor,
  nodeChevron,
  defaultTab,
  eventKeyName,
  isModifiedKeyEvent,
  treeScrollWindow,
  resolveFocusIdx,
  ALL_TABS,
  type FlatNode,
} from "../../src/runs/treeUtils.ts";
import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";

function node(id: string, overrides: Partial<GatewayRunNode> = {}): GatewayRunNode {
  return { id, name: id, kind: "task", status: "done", ...overrides };
}

describe("flattenTree", () => {
  it("returns empty array for empty nodes with no root", () => {
    const result = flattenTree([], null, new Set());
    expect(result).toHaveLength(0);
  });

  it("flattens all nodes with depth 0 when no root", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const result = flattenTree(nodes, null, new Set());
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.depth)).toEqual([0, 0, 0]);
  });

  it("walks tree in depth-first order", () => {
    const root = node("root", { childIds: ["a", "b"] });
    const a = node("a", { parentId: "root", childIds: ["a1"] });
    const a1 = node("a1", { parentId: "a" });
    const b = node("b", { parentId: "root" });
    const nodes = [root, a, a1, b];
    const result = flattenTree(nodes, root, new Set());
    expect(result.map((r) => r.node.id)).toEqual(["root", "a", "a1", "b"]);
  });

  it("assigns correct depths", () => {
    const root = node("root", { childIds: ["a"] });
    const a = node("a", { parentId: "root", childIds: ["a1"] });
    const a1 = node("a1", { parentId: "a" });
    const nodes = [root, a, a1];
    const result = flattenTree(nodes, root, new Set());
    expect(result.map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  it("omits children of collapsed nodes", () => {
    const root = node("root", { childIds: ["a"] });
    const a = node("a", { parentId: "root", childIds: ["a1"] });
    const a1 = node("a1", { parentId: "a" });
    const nodes = [root, a, a1];
    const collapsed = new Set(["a"]);
    const result = flattenTree(nodes, root, collapsed);
    expect(result.map((r) => r.node.id)).toEqual(["root", "a"]);
  });

  it("marks nodes with children as hasChildren=true", () => {
    const root = node("root", { childIds: ["a"] });
    const a = node("a", { parentId: "root" });
    const nodes = [root, a];
    const result = flattenTree(nodes, root, new Set());
    expect(result[0]!.hasChildren).toBe(true);
    expect(result[1]!.hasChildren).toBe(false);
  });

  it("marks collapsed nodes as isCollapsed=true", () => {
    const root = node("root", { childIds: ["a"] });
    const a = node("a", { parentId: "root" });
    const nodes = [root, a];
    const collapsed = new Set(["root"]);
    const result = flattenTree(nodes, root, collapsed);
    expect(result[0]!.isCollapsed).toBe(true);
  });

  it("uses unique row keys for duplicate logical node ids and per-attempt collapse", () => {
    const root = node("root", { key: "root", childIds: ["body#0", "body#1"] });
    const attempt0 = node("body", { key: "body#0", parentId: "root", iteration: 0, childIds: ["leaf#0"] });
    const attempt1 = node("body", { key: "body#1", parentId: "root", iteration: 1, childIds: ["leaf#1"] });
    const leaf0 = node("leaf", { key: "leaf#0", parentId: "body#0", iteration: 0 });
    const leaf1 = node("leaf", { key: "leaf#1", parentId: "body#1", iteration: 1 });

    const result = flattenTree([root, attempt0, attempt1, leaf0, leaf1], root, new Set(["body#0"]));

    expect(result.map((r) => [r.node.key, r.node.id, r.depth])).toEqual([
      ["root", "root", 0],
      ["body#0", "body", 1],
      ["body#1", "body", 1],
      ["leaf#1", "leaf", 2],
    ]);
  });

  it("does not recurse forever when malformed childIds contain a cycle", () => {
    const root = node("root", { childIds: ["a"] });
    const a = node("a", { parentId: "root", childIds: ["root"] });

    const result = flattenTree([root, a], root, new Set());

    expect(result.map((r) => r.node.id)).toEqual(["root", "a"]);
  });
});

describe("nodeGlyph", () => {
  it("returns ✓ for done/completed/ok", () => {
    expect(nodeGlyph("done")).toBe("✓");
    expect(nodeGlyph("completed")).toBe("✓");
    expect(nodeGlyph("ok")).toBe("✓");
  });

  it("returns ● for running/active", () => {
    expect(nodeGlyph("running")).toBe("●");
    expect(nodeGlyph("active")).toBe("●");
  });

  it("returns ⏸ for waiting/paused/blocked", () => {
    expect(nodeGlyph("waiting")).toBe("⏸");
    expect(nodeGlyph("paused")).toBe("⏸");
    expect(nodeGlyph("blocked")).toBe("⏸");
    expect(nodeGlyph("waiting_approval")).toBe("⏸");
  });

  it("returns ○ for queued/pending/idle", () => {
    expect(nodeGlyph("queued")).toBe("○");
    expect(nodeGlyph("pending")).toBe("○");
    expect(nodeGlyph("idle")).toBe("○");
  });

  it("returns a distinct dim glyph for cancelled (not the red failure ✗)", () => {
    expect(nodeGlyph("cancelled")).toBe("⊘");
    expect(nodeGlyph("canceled")).toBe("⊘");
  });

  it("returns ✗ for failed/error", () => {
    expect(nodeGlyph("failed")).toBe("✗");
    expect(nodeGlyph("error")).toBe("✗");
  });

  it("returns · for unknown status", () => {
    expect(nodeGlyph("unknown")).toBe("·");
    expect(nodeGlyph("")).toBe("·");
  });
});

describe("nodeGlyphColor", () => {
  it("returns green for done", () => {
    expect(nodeGlyphColor("done")).toBe("#00d787");
  });

  it("returns cyan for running", () => {
    expect(nodeGlyphColor("running")).toBe("#00d7ff");
  });

  it("returns yellow for waiting", () => {
    expect(nodeGlyphColor("waiting")).toBe("#ffaf00");
  });

  it("returns dim grey for cancelled (never the red failure color)", () => {
    expect(nodeGlyphColor("cancelled")).toBe("#888888");
    expect(nodeGlyphColor("canceled")).toBe("#888888");
    expect(nodeGlyphColor("cancelled")).not.toBe("#ff5f5f");
  });

  it("returns red for failed", () => {
    expect(nodeGlyphColor("failed")).toBe("#ff5f5f");
  });

  it("returns dim for unknown", () => {
    expect(nodeGlyphColor("unknown")).toBe("#6c6c6c");
  });
});

describe("nodeChevron", () => {
  it("returns · for leaf nodes", () => {
    expect(nodeChevron(false, false)).toBe("·");
    expect(nodeChevron(false, true)).toBe("·");
  });

  it("returns ▾ for expanded container", () => {
    expect(nodeChevron(true, false)).toBe("▾");
  });

  it("returns ▸ for collapsed container", () => {
    expect(nodeChevron(true, true)).toBe("▸");
  });
});

describe("defaultTab", () => {
  it("returns props for container kinds", () => {
    expect(defaultTab(node("n", { kind: "root", status: "running" }))).toBe("props");
    expect(defaultTab(node("n", { kind: "parallel", status: "running" }))).toBe("props");
    expect(defaultTab(node("n", { kind: "loop", status: "running" }))).toBe("props");
    expect(defaultTab(node("n", { kind: "workflow", status: "running" }))).toBe("props");
  });

  it("returns logs for running non-container nodes", () => {
    expect(defaultTab(node("n", { kind: "task", status: "running" }))).toBe("logs");
    expect(defaultTab(node("n", { kind: "agent", status: "active" }))).toBe("logs");
  });

  it("returns output when node has output", () => {
    expect(defaultTab(node("n", { kind: "task", status: "done", output: "hello" }))).toBe("output");
  });

  it("returns output for completed leaf nodes (real gateway rows carry no inline output)", () => {
    expect(defaultTab(node("n", { kind: "task", status: "done" }))).toBe("output");
    expect(defaultTab(node("n", { kind: "agent", status: "completed" }))).toBe("output");
    expect(defaultTab(node("n", { kind: "task", status: "ok" }))).toBe("output");
  });

  it("returns props as fallback for non-terminal, non-running leaves", () => {
    expect(defaultTab(node("n", { kind: "task", status: "queued" }))).toBe("props");
    expect(defaultTab(node("n", { kind: "task", status: "failed" }))).toBe("props");
  });
});

describe("ALL_TABS", () => {
  it("contains the inspector tabs (Tools removed — no real source)", () => {
    expect(ALL_TABS).toEqual(["output", "logs", "diff", "props"]);
  });
});

describe("eventKeyName", () => {
  it("uses the normalized name when present", () => {
    expect(eventKeyName({ name: "down", raw: "[B" })).toBe("down");
  });

  it("falls back to raw printable input", () => {
    expect(eventKeyName({ name: "", raw: "a", sequence: "" })).toBe("a");
  });

  it("falls back to sequence when name and raw are unavailable", () => {
    expect(eventKeyName({ sequence: "a" })).toBe("a");
  });
});

describe("isModifiedKeyEvent", () => {
  it("flags ctrl/meta-modified events", () => {
    expect(isModifiedKeyEvent({ name: "d", ctrl: true })).toBe(true);
    expect(isModifiedKeyEvent({ name: "d", meta: true })).toBe(true);
  });

  it("passes plain events through", () => {
    expect(isModifiedKeyEvent({ name: "d" })).toBe(false);
    expect(isModifiedKeyEvent(null)).toBe(false);
    expect(isModifiedKeyEvent("d")).toBe(false);
  });
});

describe("treeScrollWindow", () => {
  it("shows everything when the list fits", () => {
    expect(treeScrollWindow(5, 10, 3)).toEqual({ start: 0, end: 5 });
    expect(treeScrollWindow(10, 10, 9)).toEqual({ start: 0, end: 10 });
  });

  it("clamps flush at the top of the list", () => {
    expect(treeScrollWindow(40, 10, 0)).toEqual({ start: 0, end: 10 });
    expect(treeScrollWindow(40, 10, 4)).toEqual({ start: 0, end: 10 });
  });

  it("centers the focused row once past the fold", () => {
    const { start, end } = treeScrollWindow(40, 10, 20);
    expect(start).toBe(15);
    expect(end).toBe(25);
  });

  it("clamps flush at the bottom (no blank tail, last row reachable)", () => {
    expect(treeScrollWindow(40, 10, 39)).toEqual({ start: 30, end: 40 });
    expect(treeScrollWindow(40, 10, 36)).toEqual({ start: 30, end: 40 });
  });

  it("always keeps the focused row inside the window", () => {
    for (let focus = 0; focus < 40; focus++) {
      const { start, end } = treeScrollWindow(40, 7, focus);
      expect(focus).toBeGreaterThanOrEqual(start);
      expect(focus).toBeLessThan(end);
      expect(end - start).toBe(7);
    }
  });

  it("tolerates degenerate pane sizes and out-of-range focus", () => {
    expect(treeScrollWindow(5, 0, 2)).toEqual({ start: 2, end: 3 });
    expect(treeScrollWindow(5, 3, 99)).toEqual({ start: 2, end: 5 });
    expect(treeScrollWindow(5, 3, -1)).toEqual({ start: 0, end: 3 });
    expect(treeScrollWindow(0, 3, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe("resolveFocusIdx (key-anchored selection survives live tree churn)", () => {
  const row = (id: string): FlatNode => ({
    node: { id, name: id, kind: "task", status: "running" },
    depth: 0,
    hasChildren: false,
    isCollapsed: false,
  });

  it("re-derives the index when rows are inserted ABOVE the selection", () => {
    const before = [row("a"), row("b"), row("c")];
    expect(resolveFocusIdx(before, "c", 0)).toBe(2);
    const after = [row("a"), row("a2"), row("b"), row("c")];
    expect(resolveFocusIdx(after, "c", 2)).toBe(3);
  });

  it("falls back to the clamped last index when the anchored node disappears", () => {
    const shrunk = [row("a"), row("b")];
    expect(resolveFocusIdx(shrunk, "ghost", 5)).toBe(1);
    expect(resolveFocusIdx(shrunk, "ghost", 0)).toBe(0);
  });

  it("handles no selection and empty lists", () => {
    expect(resolveFocusIdx([row("a")], null, 0)).toBe(0);
    expect(resolveFocusIdx([], "a", 3)).toBe(0);
    expect(resolveFocusIdx([row("a"), row("b")], null, -2)).toBe(0);
  });
});
