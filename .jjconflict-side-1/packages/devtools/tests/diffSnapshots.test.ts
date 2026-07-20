import { describe, expect, test } from "bun:test";
import { applyDelta } from "../src/applyDelta.js";
import { diffSnapshots } from "../src/diffSnapshots.js";
import type { DevToolsNode } from "../src/DevToolsNode.ts";
import type { DevToolsSnapshotV1 } from "../src/DevToolsSnapshotV1.ts";


function node(
  id: number,
  children: DevToolsNode[] = [],
  props: Record<string, unknown> = {},
): DevToolsNode {
  return {
    id,
    type: "task",
    name: `node-${id}`,
    props,
    task: { nodeId: `task-${id}`, kind: "static", iteration: 0 },
    children,
    depth: 0,
  };
}

function withDepth(root: DevToolsNode): DevToolsNode {
  const copy = structuredClone(root);
  const stack: Array<{ node: DevToolsNode; depth: number }> = [{ node: copy, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    current.node.depth = current.depth;
    for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: current.node.children[index], depth: current.depth + 1 });
    }
  }
  return copy;
}

function snapshot(seq: number, root: DevToolsNode): DevToolsSnapshotV1 {
  return {
    version: 1,
    runId: "run-diff",
    frameNo: seq,
    seq,
    root: withDepth(root),
  };
}

function wideTree(count: number): DevToolsNode {
  return node(1, Array.from({ length: count }, (_, index) => node(index + 2)));
}

describe("diffSnapshots + applyDelta round trip", () => {
  const cases: Array<{ name: string; from: DevToolsSnapshotV1; to: DevToolsSnapshotV1 }> = [
    {
      name: "empty to single root child",
      from: snapshot(1, node(1, [])),
      to: snapshot(2, node(1, [node(2)])),
    },
    {
      name: "single root to nested 5-deep",
      from: snapshot(3, node(1, [node(2)])),
      to: snapshot(4, node(1, [node(2, [node(3, [node(4, [node(5, [node(6)])])])])])),
    },
    {
      name: "nested 5-deep to flat 20-wide",
      from: snapshot(5, node(1, [node(2, [node(3, [node(4, [node(5, [node(6)])])])])])),
      to: snapshot(6, wideTree(20)),
    },
    {
      name: "swap two siblings",
      from: snapshot(7, node(1, [node(2), node(3)])),
      to: snapshot(8, node(1, [node(3), node(2)])),
    },
    {
      // Regression: reordering three siblings [6,1,5] -> [1,6,5] removes and
      // re-adds all of them. applyDelta splices each addNode at its precomputed
      // final index without re-indexing, so the addNode ops MUST be emitted in
      // ascending-index order. Previously add ops were ordered only by depth,
      // leaving equal-depth siblings in arbitrary Set-iteration order, which
      // corrupted sibling order on reorders.
      name: "reorder three siblings [6,2,5] -> [2,6,5]",
      from: snapshot(70, node(1, [node(6), node(2, [], { x: 1 }), node(5)])),
      to: snapshot(71, node(1, [node(2, [], { x: 1 }), node(6), node(5)])),
    },
    {
      // Regression: reorder existing siblings while also inserting a brand-new
      // sibling. The new add and the reorder-induced re-adds share the same
      // depth, so ascending-index ordering must interleave them correctly.
      name: "reverse siblings with a new insert [10,20,30] -> [30,40,20,10]",
      from: snapshot(72, node(1, [node(10), node(20), node(30)])),
      to: snapshot(73, node(1, [node(30), node(40), node(20), node(10)])),
    },
    {
      // Regression: a node (5) reparents into a subtree (2) that is itself being
      // removed-and-re-added because its index changed. node 2's addNode clones
      // its whole subtree, which now contains 5 under 3. node 5's DIRECT parent
      // (3) is unchanged, so the old direct-parent-only filter still emitted a
      // standalone addNode for 5, duplicating it. The filter now walks the full
      // ancestor chain, so 5 gets added once (via 2's clone). Fuzzing reparenting
      // tree-pairs hit this in ~2.6% of cases.
      name: "reparent a node into a re-added subtree (no duplicate)",
      from: snapshot(74, node(1, [node(5), node(2, [node(3)])])),
      to: snapshot(75, node(1, [node(2, [node(3, [node(5)])])])),
    },
    {
      name: "change only props on a leaf",
      from: snapshot(9, node(1, [node(2, [node(3, [], { value: "a" })])])),
      to: snapshot(10, node(1, [node(2, [node(3, [], { value: "b" })])])),
    },
    {
      name: "change only task sidecar on a leaf",
      from: snapshot(11, node(1, [node(2)])),
      to: snapshot(12, {
        ...node(1, [
          {
            ...node(2),
            task: { nodeId: "task-2", kind: "agent", agent: "claude", iteration: 2 },
          },
        ]),
      }),
    },
    {
      name: "100-node no-op",
      from: snapshot(13, wideTree(100)),
      to: snapshot(14, wideTree(100)),
    },
    {
      name: "1000-node tree deletes half subtree",
      from: snapshot(15, wideTree(1000)),
      to: snapshot(16, wideTree(500)),
    },
  ];

  for (const scenario of cases) {
    test(scenario.name, () => {
      const delta = diffSnapshots(scenario.from, scenario.to);
      const patched = applyDelta(scenario.from, delta);
      expect(patched).toEqual(scenario.to);
      if (scenario.name === "100-node no-op") {
        expect(delta.ops).toEqual([]);
      }
    });
  }

  test("empty root becomes real root: diff emits replaceRoot, applyDelta rehydrates", () => {
    const empty = snapshot(100, node(0, []));
    empty.root.name = "(empty)";
    const filled = snapshot(
      101,
      (() => {
        const root: DevToolsNode = {
          id: 42,
          type: "workflow",
          name: "hello",
          props: {},
          children: [node(2, [], { value: "hi" })],
          depth: 0,
        };
        return root;
      })(),
    );
    const delta = diffSnapshots(empty, filled);
    expect(delta.ops.length).toBe(1);
    expect(delta.ops[0]).toMatchObject({ op: "replaceRoot" });
    const patched = applyDelta(empty, delta);
    expect(patched).toEqual(filled);
  });

  test("round-trips unicode props on child nodes", () => {
    const unicode = "ユニコード🎉";
    const from = snapshot(17, node(1, [node(2, [], { value: "plain" })]));
    const toRoot: DevToolsNode = {
      id: 1,
      type: "task",
      name: "node-1",
      props: {},
      task: { nodeId: "task-1", kind: "static", iteration: 0 },
      children: [
        {
          id: 2,
          type: "task",
          name: "node-2",
          props: { value: unicode, nested: { emoji: "✨" } },
          task: { nodeId: `task-${unicode}`, kind: "agent", agent: unicode, iteration: 0 },
          children: [],
          depth: 1,
        },
      ],
      depth: 0,
    };
    const to = snapshot(18, toRoot);
    const delta = diffSnapshots(from, to);
    const patched = applyDelta(from, delta);
    expect(patched).toEqual(to);
    expect((patched.root.children[0]?.props.value as string)).toBe(unicode);
  });

  test("rejects snapshots from different runs", () => {
    const from = snapshot(30, node(1));
    const to = { ...snapshot(31, node(1)), runId: "other-run" };
    expect(() => diffSnapshots(from, to)).toThrow("different runs");
  });

  test("diffs array, null, and object inequality cases", () => {
    const from = snapshot(32, node(1, [node(2, [], { a: [1, 2], b: null, c: { same: true } })]));
    const to = snapshot(33, node(1, [node(2, [], { a: [1, 3], b: {}, c: { same: true, extra: true } })]));
    const delta = diffSnapshots(from, to);
    expect(delta.ops).toEqual([
      {
        op: "updateProps",
        id: 2,
        props: { a: [1, 3], b: {}, c: { same: true, extra: true } },
      },
    ]);
    expect(applyDelta(from, delta)).toEqual(to);
  });

  test("diffs primitive type, null, array length, and object key mismatches", () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ value: 1 }, { value: "1" }],
      [{ value: null }, { value: {} }],
      [{ value: [1] }, { value: [1, 2] }],
      [{ equalArray: [1, 2], marker: "a" }, { equalArray: [1, 2], marker: "b" }],
      [{ value: { left: true } }, { value: { right: true } }],
    ];
    for (const [fromProps, toProps] of cases) {
      const from = snapshot(40, node(1, [node(2, [], fromProps)]));
      const to = snapshot(41, node(1, [node(2, [], toProps)]));
      const delta = diffSnapshots(from, to);
      expect(delta.ops).toEqual([{ op: "updateProps", id: 2, props: toProps }]);
    }
  });

  test("falls back to JSON cloning when structuredClone is unavailable", () => {
    const from = snapshot(34, node(1));
    const to = snapshot(35, node(9));
    const original = globalThis.structuredClone;
    try {
      (globalThis as typeof globalThis & { structuredClone?: typeof structuredClone }).structuredClone = undefined;
      const delta = diffSnapshots(from, to);
      expect(delta.ops[0]).toMatchObject({ op: "replaceRoot" });
      expect((delta.ops[0] as { node?: DevToolsNode }).node?.id).toBe(9);
    } finally {
      globalThis.structuredClone = original;
    }
  });

  test("correctly diffs 500-node tree with 10 prop changes", () => {
    const baseline = wideTree(500);
    const mutated = structuredClone(baseline);
    for (let index = 0; index < 10; index += 1) {
      (mutated.children[index].props as Record<string, unknown>).value = `changed-${index}`;
    }
    const from = snapshot(200, baseline);
    const to = snapshot(201, mutated);
    const delta = diffSnapshots(from, to);
    // All 10 changed nodes should appear in the delta as updateProps ops
    const updatedIds = new Set(
      delta.ops
        .filter((op) => op.op === "updateProps")
        .map((op) => (op as { op: "updateProps"; id: number }).id),
    );
    expect(updatedIds.size).toBe(10);
    for (let index = 0; index < 10; index += 1) {
      expect(updatedIds.has(baseline.children[index].id)).toBe(true);
    }
  });

  test("property: round-trips random reparenting tree-pairs with no duplicate or lost nodes", () => {
    // Both trees in each pair share the SAME id set, so every diff is pure
    // reparent/reorder (the add/remove path, keyed on parent/index/depth change).
    // A deterministic LCG keeps the test reproducible. Before the ancestor-chain
    // fix in topLevelAddIds, ~2.6% of these pairs duplicated a node reparented
    // into a re-added subtree, so 300 iterations reliably caught the regression.
    let s = 0xc0ffee >>> 0;
    const rng = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    };
    const buildTree = (ids: number[]): DevToolsNode => {
      const root = node(ids[0], []);
      const placed: DevToolsNode[] = [root];
      for (let i = 1; i < ids.length; i += 1) {
        const parent = placed[Math.floor(rng() * placed.length)];
        const child = node(ids[i], []);
        const at = Math.floor(rng() * (parent.children.length + 1));
        parent.children.splice(at, 0, child);
        placed.push(child);
      }
      return root;
    };
    const collectIds = (root: DevToolsNode): number[] => {
      const ids: number[] = [];
      const stack = [root];
      while (stack.length > 0) {
        const current = stack.pop()!;
        ids.push(current.id);
        for (const child of current.children) stack.push(child);
      }
      return ids;
    };
    for (let iter = 0; iter < 300; iter += 1) {
      const count = 3 + Math.floor(rng() * 12);
      const ids = Array.from({ length: count }, (_, i) => i + 1); // id 1 is always the root
      const from = snapshot(1000 + iter * 2, buildTree(ids));
      const to = snapshot(1001 + iter * 2, buildTree(ids));
      const patched = applyDelta(from, diffSnapshots(from, to));
      expect(patched).toEqual(to);
      const patchedIds = collectIds(patched.root);
      expect(new Set(patchedIds).size).toBe(patchedIds.length); // no duplicate node
      expect([...patchedIds].sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b)); // none lost
    }
  });
});
