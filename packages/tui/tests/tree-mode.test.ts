import { describe, it, expect } from "bun:test";
import { parseKeypress } from "@opentui/core";
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
} from "../src/modes/treeUtils.ts";
import { routeApprovalKey } from "../src/modes/approvalUtils.ts";
import { deriveOutputText, TUI_OUTPUT_PREVIEW_CHARS, TUI_OUTPUT_TRUNCATION_MARKER } from "../src/modes/TreeMode.tsx";
import type { GatewayRunNode } from "@smthrs/gateway-client";

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
      expect(eventKeyName({ name: "down", raw: "\u001b[B" })).toBe("down");
    });

    it("falls back to raw printable input", () => {
      expect(eventKeyName({ name: "", raw: "a", sequence: "" })).toBe("a");
    });

    it("falls back to sequence when name and raw are unavailable", () => {
      expect(eventKeyName({ sequence: "a" })).toBe("a");
    });
  });

  describe("isModifiedKeyEvent (approval hotkey safety, real parser events)", () => {
    const key = (raw: string) => {
      const parsed = parseKeypress(Buffer.from(raw));
      if (!parsed) throw new Error(`parseKeypress returned null for ${JSON.stringify(raw)}`);
      return parsed;
    };

    it("flags Ctrl-D / Ctrl-A control bytes — parseKeypress reports the PLAIN letter name", () => {
      const ctrlD = key("\x04");
      expect(ctrlD.name).toBe("d");
      expect(isModifiedKeyEvent(ctrlD)).toBe(true);
      const ctrlA = key("\x01");
      expect(ctrlA.name).toBe("a");
      expect(isModifiedKeyEvent(ctrlA)).toBe(true);
    });

    it("flags Alt (Esc-prefixed) letters as meta-modified", () => {
      const altD = key("\x1bd");
      expect(altD.name).toBe("d");
      expect(isModifiedKeyEvent(altD)).toBe(true);
    });

    it("passes plain and shifted letters through", () => {
      expect(isModifiedKeyEvent(key("d"))).toBe(false);
      expect(isModifiedKeyEvent(key("L"))).toBe(false);
      expect(isModifiedKeyEvent(null)).toBe(false);
      expect(isModifiedKeyEvent("d")).toBe(false);
    });

    it("keeps Ctrl-D from ever reaching approval routing while plain d still denies", () => {
      const ctx = { hasApproval: true, isHumanRequest: false, mode: "gate" as const, busy: false };
      // TreeMode's handler drops modified events BEFORE routing; compose the
      // same guard here against the real parsed events.
      const route = (raw: string) => {
        const ev = key(raw);
        if (isModifiedKeyEvent(ev)) return null;
        return routeApprovalKey(eventKeyName(ev), ctx);
      };
      expect(route("\x04")).toBeNull(); // Ctrl-D must NOT deny
      expect(route("\x01")).toBeNull(); // Ctrl-A must NOT approve
      expect(route("\x1bd")).toBeNull(); // Alt-D must NOT deny
      expect(route("d")).toEqual({ kind: "deny" });
      expect(route("a")).toEqual({ kind: "approve" });
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
      // A new loop attempt lands above: same node, new index.
      const after = [row("a"), row("a2"), row("b"), row("c")];
      expect(resolveFocusIdx(after, "c", 2)).toBe(3);
    });

    it("falls back to the clamped last index when the anchored node disappears", () => {
      const shrunk = [row("a"), row("b")];
      // lastIdx 5 is past the end — clamp so `k` responds immediately.
      expect(resolveFocusIdx(shrunk, "ghost", 5)).toBe(1);
      expect(resolveFocusIdx(shrunk, "ghost", 0)).toBe(0);
    });

    it("handles no selection and empty lists", () => {
      expect(resolveFocusIdx([row("a")], null, 0)).toBe(0);
      expect(resolveFocusIdx([], "a", 3)).toBe(0);
      expect(resolveFocusIdx([row("a"), row("b")], null, -2)).toBe(0);
    });
  });
});

describe("deriveOutputText (getNodeOutput envelope unwrap)", () => {
  const outNode = (overrides: Partial<GatewayRunNode> = {}): GatewayRunNode => ({
    id: "n",
    name: "n",
    kind: "task",
    status: "done",
    ...overrides,
  });

  it("unwraps a produced envelope to the row's output string", () => {
    // The real wire shape: { status, row, schema } (see server getNodeOutput).
    const envelope = {
      status: "produced",
      row: { output: "# the agent's markdown" },
      schema: { fields: [{ name: "output", type: "string" }] },
    };
    const text = deriveOutputText(envelope, outNode());
    expect(text).toBe("# the agent's markdown");
    expect(text).not.toContain("schema");
  });

  it("defensively truncates a produced envelope with a very large row output", () => {
    const envelope = {
      status: "produced",
      row: { output: "x".repeat(1_000_000) },
      schema: { fields: [{ name: "output", type: "string" }] },
    };

    const text = deriveOutputText(envelope, outNode());

    expect(text.length).toBeLessThanOrEqual(20_020);
    expect(text.length).toBeLessThanOrEqual(TUI_OUTPUT_PREVIEW_CHARS + TUI_OUTPUT_TRUNCATION_MARKER.length);
    expect(text.endsWith(TUI_OUTPUT_TRUNCATION_MARKER)).toBe(true);
    expect(text).not.toBe(envelope.row.output);
  });

  it("keeps the output preview boundary inclusive and truncates one byte over", () => {
    const exactLimit = "x".repeat(TUI_OUTPUT_PREVIEW_CHARS);
    const oneOverLimit = `${exactLimit}y`;

    expect(deriveOutputText({ status: "produced", row: { output: exactLimit }, schema: null }, outNode())).toBe(
      exactLimit,
    );

    const truncated = deriveOutputText({ status: "produced", row: { output: oneOverLimit }, schema: null }, outNode());

    expect(truncated).toBe(`${exactLimit}${TUI_OUTPUT_TRUNCATION_MARKER}`);
  });

  it("renders a structured produced row as JSON of the ROW only (no envelope)", () => {
    const envelope = { status: "produced", row: { value: 42 }, schema: null };
    const text = deriveOutputText(envelope, outNode());
    expect(text).toContain('"value": 42');
    expect(text).not.toContain("produced");
    expect(text).not.toContain("schema");
  });

  it("maps a pending envelope to a readable placeholder, not raw JSON", () => {
    expect(deriveOutputText({ status: "pending", row: null, schema: null }, outNode())).toBe("(no output yet)");
  });

  it("maps a failed envelope to a failure note, surfacing partial output", () => {
    expect(deriveOutputText({ status: "failed", row: null, schema: null }, outNode())).toBe("(failed, no output)");
    const withPartial = deriveOutputText(
      { status: "failed", row: null, schema: null, partial: { step: "halfway" } },
      outNode(),
    );
    expect(withPartial).toContain("(failed) partial output:");
    expect(withPartial).toContain("halfway");
  });

  it("defensively truncates a failed envelope with very large partial output", () => {
    const text = deriveOutputText(
      {
        status: "failed",
        row: null,
        schema: null,
        partial: { output: "x".repeat(1_000_000) },
      },
      outNode(),
    );

    expect(text).toContain("(failed) partial output:");
    expect(text.length).toBeLessThanOrEqual(TUI_OUTPUT_PREVIEW_CHARS + TUI_OUTPUT_TRUNCATION_MARKER.length);
    expect(text.endsWith(TUI_OUTPUT_TRUNCATION_MARKER)).toBe(true);
  });

  it("keeps the plain string-field fallbacks for non-envelope payloads", () => {
    expect(deriveOutputText({ output: "plain" }, outNode())).toBe("plain");
    expect(deriveOutputText({ text: "txt" }, outNode())).toBe("txt");
    expect(deriveOutputText({ content: "c" }, outNode())).toBe("c");
    expect(deriveOutputText({ other: 1 }, outNode())).toContain('"other": 1');
    expect(deriveOutputText(undefined, outNode({ output: "inline" }))).toBe("inline");
    expect(deriveOutputText(undefined, outNode())).toBe("(no output)");
  });
});
