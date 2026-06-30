import { describe, it, expect } from "bun:test";
import {
  flattenTree,
  nodeGlyph,
  nodeGlyphColor,
  nodeChevron,
  defaultTab,
  ALL_TABS,
} from "../src/modes/treeUtils.ts";
import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";

function node(id: string, overrides: Partial<GatewayRunNode> = {}): GatewayRunNode {
  return { id, name: id, kind: "task", status: "done", ...overrides };
}

describe("treeUtils", () => {
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

    it("returns props as fallback", () => {
      expect(defaultTab(node("n", { kind: "task", status: "done" }))).toBe("props");
    });
  });

  describe("ALL_TABS", () => {
    it("contains all five tabs", () => {
      expect(ALL_TABS).toEqual(["output", "logs", "tools", "diff", "props"]);
    });
  });
});
