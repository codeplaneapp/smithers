import { describe, it, expect } from "bun:test";
import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";
import {
  computeColumnDepths,
  computeGraphLayout,
  connectorArrow,
  edgesForConnector,
  hasIncomingEdge,
} from "../src/modes/graphUtils.ts";

function node(id: string, overrides: Partial<GatewayRunNode> = {}): GatewayRunNode {
  return { id, name: id, kind: "task", status: "done", ...overrides };
}

describe("graphUtils – computeColumnDepths", () => {
  it("assigns depth 0 to a lone root", () => {
    const root = node("r");
    const depths = computeColumnDepths([root], root);
    expect(depths.get("r")).toBe(0);
  });

  it("assigns depth 1 to direct children of the root", () => {
    const root = node("r", { childIds: ["a", "b"] });
    const a = node("a", { parentId: "r" });
    const b = node("b", { parentId: "r" });
    const depths = computeColumnDepths([root, a, b], root);
    expect(depths.get("r")).toBe(0);
    expect(depths.get("a")).toBe(1);
    expect(depths.get("b")).toBe(1);
  });

  it("assigns deepest column when a node has multiple parents", () => {
    // r → a → c, r → b → c: c should be at depth 2
    const root = node("r", { childIds: ["a", "b"] });
    const a = node("a", { parentId: "r", childIds: ["c"] });
    const b = node("b", { parentId: "r", childIds: ["c"] });
    const c = node("c", { parentId: "a" });
    const depths = computeColumnDepths([root, a, b, c], root);
    expect(depths.get("c")).toBe(2);
  });

  it("handles no root — assigns depth 0 to parentless nodes", () => {
    const a = node("a");
    const b = node("b");
    const depths = computeColumnDepths([a, b], null);
    expect(depths.get("a")).toBe(0);
    expect(depths.get("b")).toBe(0);
  });

  it("assigns column 0 to unreachable orphan nodes", () => {
    const root = node("r", { childIds: ["a"] });
    const a = node("a", { parentId: "r" });
    const orphan = node("orphan");
    const depths = computeColumnDepths([root, a, orphan], root);
    expect(depths.get("orphan")).toBe(0);
  });
});

describe("graphUtils – computeGraphLayout", () => {
  it("returns empty layout for empty nodes", () => {
    const layout = computeGraphLayout([], null);
    expect(layout.numCols).toBe(0);
    expect(layout.maxRows).toBe(0);
    expect(layout.edges).toHaveLength(0);
  });

  it("places a single root node at col=0, row=0", () => {
    const root = node("r");
    const layout = computeGraphLayout([root], root);
    expect(layout.numCols).toBe(1);
    expect(layout.positions.get("r")).toEqual({ col: 0, row: 0 });
  });

  it("places children in col 1", () => {
    const root = node("r", { childIds: ["a", "b"] });
    const a = node("a", { parentId: "r" });
    const b = node("b", { parentId: "r" });
    const layout = computeGraphLayout([root, a, b], root);
    expect(layout.numCols).toBe(2);
    const posA = layout.positions.get("a");
    const posB = layout.positions.get("b");
    expect(posA?.col).toBe(1);
    expect(posB?.col).toBe(1);
    // Both in col 1 at different rows
    expect(posA?.row).not.toBe(posB?.row);
  });

  it("creates edges list for parent-child relationships", () => {
    const root = node("r", { childIds: ["a"] });
    const a = node("a", { parentId: "r" });
    const layout = computeGraphLayout([root, a], root);
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toEqual({ fromId: "r", toId: "a" });
  });

  it("tracks maxRows correctly across columns", () => {
    const root = node("r", { childIds: ["a", "b", "c"] });
    const a = node("a", { parentId: "r" });
    const b = node("b", { parentId: "r" });
    const c = node("c", { parentId: "r" });
    const layout = computeGraphLayout([root, a, b, c], root);
    expect(layout.maxRows).toBe(3); // col 1 has 3 nodes
  });

  it("colGroups[col] contains the expected node ids", () => {
    const root = node("r", { childIds: ["a"] });
    const a = node("a", { parentId: "r", childIds: ["b"] });
    const b = node("b", { parentId: "a" });
    const layout = computeGraphLayout([root, a, b], root);
    expect(layout.colGroups[0]).toContain("r");
    expect(layout.colGroups[1]).toContain("a");
    expect(layout.colGroups[2]).toContain("b");
  });

  it("keys duplicate logical node ids by unique row key", () => {
    const root = node("root", { key: "root", childIds: ["body#0", "body#1"] });
    const attempt0 = node("body", { key: "body#0", parentId: "root", iteration: 0 });
    const attempt1 = node("body", { key: "body#1", parentId: "root", iteration: 1 });

    const layout = computeGraphLayout([root, attempt0, attempt1], root);

    expect(layout.positions.get("body#0")).toEqual({ col: 1, row: 0 });
    expect(layout.positions.get("body#1")).toEqual({ col: 1, row: 1 });
    expect(layout.positions.has("body")).toBe(false);
    expect(layout.edges).toEqual([
      { fromId: "root", toId: "body#0" },
      { fromId: "root", toId: "body#1" },
    ]);
  });

  it("terminates on malformed cyclic child links", () => {
    const root = node("root", { childIds: ["a"] });
    const a = node("a", { parentId: "root", childIds: ["root"] });

    const layout = computeGraphLayout([root, a], root);

    expect(layout.positions.get("root")).toEqual({ col: 0, row: 0 });
    expect(layout.positions.get("a")).toEqual({ col: 1, row: 0 });
    expect(layout.numCols).toBe(2);
  });
});

describe("graphUtils – edgesForConnector", () => {
  it("returns only edges crossing the specified column gap", () => {
    const root = node("r", { childIds: ["a", "b"] });
    const a = node("a", { parentId: "r", childIds: ["c"] });
    const b = node("b", { parentId: "r" });
    const c = node("c", { parentId: "a" });
    const layout = computeGraphLayout([root, a, b, c], root);

    // Col 0→1 connector: edges r→a and r→b
    const conn01 = edgesForConnector(layout.edges, layout.positions, 0);
    expect(conn01.length).toBe(2);
    expect(conn01.some((e) => e.fromRow === 0 && e.toRow === layout.positions.get("a")!.row)).toBe(true);
    expect(conn01.some((e) => e.fromRow === 0 && e.toRow === layout.positions.get("b")!.row)).toBe(true);

    // Col 1→2 connector: edge a→c
    const conn12 = edgesForConnector(layout.edges, layout.positions, 1);
    expect(conn12.length).toBe(1);
    expect(conn12[0]?.toRow).toBe(layout.positions.get("c")!.row);
  });

  it("returns empty array when no edges cross the gap", () => {
    const a = node("a");
    const b = node("b");
    const layout = computeGraphLayout([a, b], null);
    const conn = edgesForConnector(layout.edges, layout.positions, 0);
    expect(conn).toHaveLength(0);
  });
});

describe("graphUtils – connectorArrow", () => {
  // Regression for #582: the compact arrow was " →  " (4 chars) rendered into a
  // width-3 connector column, so arrow rows overflowed and were one cell wider
  // than blank rows, skewing the graph. The arrow must fit its own column
  // exactly in both modes, so callers can size the cell from `.length`.
  it("compact arrow is exactly 3 columns wide (no overflow)", () => {
    expect(connectorArrow(true)).toBe(" → ");
    expect(connectorArrow(true).length).toBe(3);
  });

  it("normal arrow is exactly 5 columns wide", () => {
    expect(connectorArrow(false)).toBe(" ──▶ ");
    expect(connectorArrow(false).length).toBe(5);
  });
});

describe("graphUtils – hasIncomingEdge", () => {
  it("returns true when an edge targets the given row", () => {
    const connEdges = [
      { fromRow: 0, toRow: 1 },
      { fromRow: 0, toRow: 3 },
    ];
    expect(hasIncomingEdge(connEdges, 1)).toBe(true);
    expect(hasIncomingEdge(connEdges, 3)).toBe(true);
  });

  it("returns false when no edge targets the given row", () => {
    const connEdges = [{ fromRow: 0, toRow: 2 }];
    expect(hasIncomingEdge(connEdges, 0)).toBe(false);
    expect(hasIncomingEdge(connEdges, 1)).toBe(false);
  });

  it("returns false for empty edge list", () => {
    expect(hasIncomingEdge([], 0)).toBe(false);
  });
});
