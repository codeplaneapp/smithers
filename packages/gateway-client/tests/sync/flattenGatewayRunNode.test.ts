import { describe, expect, test } from "bun:test";
import { flattenGatewayRunNode } from "../../src/sync/flattenGatewayRunNode.ts";
import type { GatewayRunNode } from "../../src/sync/GatewayRunNode.ts";

describe("flattenGatewayRunNode", () => {
  test("terminates when child references form a cycle", () => {
    const root: GatewayRunNode = { id: "root", name: "Root", kind: "compute", status: "running", children: [] };
    const child: GatewayRunNode = { id: "child", name: "Child", kind: "compute", status: "queued", children: [root] };
    root.children = [child];

    expect(flattenGatewayRunNode(root).map((row) => row.id)).toEqual(["root", "child"]);
  });

  test("emits each duplicated child only once", () => {
    const child: GatewayRunNode = { id: "child", name: "Child", kind: "compute", status: "queued", children: [] };
    const root: GatewayRunNode = {
      id: "root",
      name: "Root",
      kind: "compute",
      status: "running",
      children: [child, child],
    };

    expect(flattenGatewayRunNode(root).map((row) => row.id)).toEqual(["root", "child"]);
  });

  test("keeps loop/retry attempts that share a logical id as distinct rows", () => {
    // Two attempts of the same logical node `plan` (iterations 0 and 1). They
    // share `id` but carry distinct unique `key`s — id-keying would collapse
    // them to the first row and lose the second attempt's output/approval.
    const root: GatewayRunNode = {
      key: "loop",
      id: "loop",
      name: "Loop",
      kind: "loop",
      status: "running",
      children: [
        {
          key: "plan#0",
          id: "plan",
          iteration: 0,
          attempt: 1,
          name: "Plan",
          kind: "agent",
          status: "ok",
          children: [],
        },
        {
          key: "plan#1",
          id: "plan",
          iteration: 1,
          attempt: 2,
          name: "Plan",
          kind: "agent",
          status: "running",
          children: [],
        },
      ],
    };

    const rows = flattenGatewayRunNode(root);
    // Three distinct rows by unique key, not two collapsed by id.
    expect(rows.map((row) => row.key)).toEqual(["loop", "plan#0", "plan#1"]);
    const attempts = rows.filter((row) => row.id === "plan");
    expect(attempts).toHaveLength(2);
    expect(attempts.map((row) => row.iteration)).toEqual([0, 1]);
    expect(attempts.map((row) => row.attempt)).toEqual([1, 2]);
    // The loop links to both attempts by their unique keys, not the shared id.
    expect(rows[0]?.childIds).toEqual(["plan#0", "plan#1"]);
    expect(attempts.map((row) => row.parentId)).toEqual(["loop", "loop"]);
  });
});
