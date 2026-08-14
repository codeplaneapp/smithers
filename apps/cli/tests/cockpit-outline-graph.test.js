import { describe, expect, test } from "bun:test";
import { mapDevToolsNodeToOutline, flattenOutlineTree, outlinePhasesToTree } from "../src/cockpit-outline-graph.js";
import { buildCockpitOutlineModel, renderCockpitOutlineFrame } from "../src/cockpit-outline.js";

describe("cockpit outline graph", () => {
  test("maps nested parallel DevTools tree to hierarchical outline", () => {
    const root = {
      id: 1,
      type: "workflow",
      name: "nested",
      props: {},
      depth: 0,
      children: [
        {
          id: 2,
          type: "sequence",
          name: "sequence",
          props: {},
          depth: 1,
          children: [
            {
              id: 3,
              type: "task",
              name: "setup",
              props: { id: "setup" },
              task: { nodeId: "setup", state: "finished", attempt: 1, label: "Setup" },
              children: [],
              depth: 2,
            },
            {
              id: 4,
              type: "parallel",
              name: "parallel",
              props: {},
              depth: 2,
              children: [
                {
                  id: 5,
                  type: "task",
                  name: "a",
                  props: { id: "outer-a" },
                  task: { nodeId: "outer-a", state: "finished", attempt: 1 },
                  children: [],
                  depth: 3,
                },
                {
                  id: 6,
                  type: "parallel",
                  name: "parallel",
                  props: {},
                  depth: 3,
                  children: [
                    {
                      id: 7,
                      type: "task",
                      name: "inner-1",
                      props: { id: "inner-1" },
                      task: {
                        nodeId: "inner-1",
                        state: "in-progress",
                        attempt: 1,
                        label: "Inner 1",
                      },
                      children: [],
                      depth: 4,
                    },
                    {
                      id: 8,
                      type: "task",
                      name: "inner-2",
                      props: { id: "inner-2" },
                      task: { nodeId: "inner-2", state: "pending", attempt: 0 },
                      children: [],
                      depth: 4,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const mapped = mapDevToolsNodeToOutline(root, {});
    expect(mapped).toBeTruthy();
    const roots = mapped.kind === "group" && mapped.groupType === "sequence" ? mapped.children : [mapped];
    const flat = flattenOutlineTree(roots, {});
    // Nested parallel group appears as a selectable phase with depth > outer
    const nestedGroup = flat.rows.find(
      (r) => r.node.kind === "group" && r.depth >= 1 && r.node.groupType === "parallel",
    );
    expect(nestedGroup).toBeTruthy();
    expect(flat.selectables.some((s) => s.nodeId === "inner-1")).toBe(true);
    expect(flat.selectables.some((s) => s.nodeId === "outer-a")).toBe(true);

    const model = buildCockpitOutlineModel({
      runId: "g1",
      status: "running",
      live: true,
      nodes: [],
      outlineRoots: roots,
      selectedKey: "inner-1",
    });
    expect(model.outlineSource).toBe("graph");
    const plain = renderCockpitOutlineFrame(model, { rows: 24, cols: 90 })
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/Inner 1|inner-1/);
    expect(plain).toMatch(/parallel/);
  });

  test("outlinePhasesToTree preserves flat fallback shape", () => {
    const roots = outlinePhasesToTree([
      {
        id: "s1",
        kind: "single",
        title: "Setup",
        agents: [{ nodeId: "setup", displayName: "Setup", state: "finished", attempt: 1 }],
      },
      {
        id: "p1",
        kind: "parallel",
        title: "parallel",
        expanded: true,
        agents: [
          { nodeId: "worker-01", displayName: "w1", state: "in-progress", attempt: 1 },
          { nodeId: "worker-02", displayName: "w2", state: "pending", attempt: 0 },
        ],
      },
    ]);
    expect(roots).toHaveLength(2);
    expect(roots[0].kind).toBe("task");
    expect(roots[1].kind).toBe("group");
    expect(roots[1].children).toHaveLength(2);
  });
});
