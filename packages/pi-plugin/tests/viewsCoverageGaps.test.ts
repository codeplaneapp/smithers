import { describe, expect, test } from "bun:test";
import { DevToolsStore } from "../src/runtime/DevToolsStore.js";
import { NodeInspector } from "../src/views/NodeInspector.js";
import { RunTree } from "../src/views/RunTree.js";
import type { DevToolsNode, DevToolsSnapshot } from "@smthrs/protocol";

const plainTheme = {
  fg: (_color: string, value: string) => value,
  bold: (value: string) => value,
};

function task(id: number, nodeId: string, state: string, children: DevToolsNode[] = []): DevToolsNode {
  return {
    id,
    type: "task",
    name: nodeId,
    props: { state, output: `out-${nodeId}` },
    task: { nodeId, kind: "compute", label: nodeId, iteration: 0 },
    children,
    depth: 1,
  };
}

function snapshot(children: DevToolsNode[]): DevToolsSnapshot {
  return {
    version: 1,
    runId: "run-views",
    frameNo: 1,
    seq: 1,
    root: { id: 1, type: "workflow", name: "Workflow", props: { state: "running" }, children, depth: 0 },
  };
}

function storeWithTree(children: DevToolsNode[]) {
  const store = new DevToolsStore();
  store.runId = "run-views";
  store.applyEvent({ version: 1, kind: "snapshot", snapshot: snapshot(children) });
  return store;
}

describe("RunTree keyboard navigation", () => {
  test("collapse walks to the parent and expand re-opens a collapsed subtree", () => {
    const child = task(3, "task:child", "running");
    const parent = task(2, "task:parent", "running", [child]);
    const store = storeWithTree([parent, task(4, "task:sibling", "running")]);
    const tree = new RunTree(store);
    tree.render(100, 10, plainTheme);

    // Select the leaf child; left-arrow on a childless node walks up to the parent.
    store.selectNode(3);
    expect(tree.handleInput("\x1b[D")).toBe("handled");
    expect(store.selectedNodeId).toBe(2);

    // Left-arrow on the expanded parent collapses it (first press).
    expect(tree.handleInput("\x1b[D")).toBe("handled");
    // Right-arrow re-expands the collapsed parent.
    expect(tree.handleInput("\x1b[C")).toBe("handled");

    // Left-arrow on the now-expanded parent collapses, then again walks to root.
    tree.handleInput("\x1b[D");
    tree.handleInput("\x1b[D");
    expect(store.selectedNodeId).toBe(1);
  });

  test("j/k move selection, and moving with nothing selected picks an end", () => {
    const store = storeWithTree([task(2, "task:a", "running"), task(3, "task:b", "running")]);
    const tree = new RunTree(store);
    tree.render(100, 10, plainTheme);

    store.clearSelection();
    expect(tree.handleInput("j")).toBe("handled");
    expect(store.selectedNodeId).not.toBeUndefined();
    tree.handleInput("k");

    store.clearSelection();
    // Up with no selection lands on the last row.
    tree.handleInput("\x1b[A");
    expect(store.selectedNodeId).not.toBeUndefined();
  });

  test("home, end and enter are handled, unknown keys are not", () => {
    const store = storeWithTree([task(2, "task:a", "running"), task(3, "task:b", "running")]);
    const tree = new RunTree(store);
    tree.render(100, 10, plainTheme);

    expect(tree.handleInput("g")).toBe("handled");
    expect(tree.handleInput("G")).toBe("handled");
    expect(tree.handleInput("\r")).toBe("focusInspector");
    expect(tree.handleInput("z")).toBe("unhandled");
  });
});

describe("NodeInspector tab and scroll input", () => {
  test("tab keys cycle tabs and digit keys jump directly", () => {
    const store = storeWithTree([task(2, "task:a", "running")]);
    store.selectNode(2);
    const inspector = new NodeInspector(store);

    expect(inspector.handleInput("\t")).toBe("handled"); // nextTab(+1)
    expect(inspector.handleInput("[")).toBe("handled"); // nextTab(-1)
    expect(inspector.handleInput("]")).toBe("handled"); // nextTab(+1)
    expect(inspector.handleInput("1")).toBe("handled");
    expect(inspector.handleInput("2")).toBe("handled");
    expect(inspector.handleInput("3")).toBe("handled");
    expect(inspector.handleInput("j")).toBe("handled");
    expect(inspector.handleInput("k")).toBe("handled");
    expect(inspector.handleInput("g")).toBe("handled");
    expect(inspector.handleInput("z")).toBe("unhandled");

    // Render after cycling to exercise the active-tab rendering paths.
    expect(inspector.render(120, 10, plainTheme).join("\n").length).toBeGreaterThan(0);
  });
});
