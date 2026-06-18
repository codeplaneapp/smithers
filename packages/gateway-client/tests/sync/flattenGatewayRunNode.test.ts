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
});
