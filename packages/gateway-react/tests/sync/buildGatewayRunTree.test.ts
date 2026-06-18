import { describe, expect, test } from "bun:test";
import type { GatewayRunNode } from "@smithers-orchestrator/gateway-client";
import { buildGatewayRunTree } from "../../src/sync/buildGatewayRunTree.ts";

describe("buildGatewayRunTree", () => {
  test("terminates when childIds form a cycle", () => {
    const rows: GatewayRunNode[] = [
      { id: "root", name: "Root", kind: "compute", status: "running", childIds: ["child"] },
      { id: "child", name: "Child", kind: "compute", status: "queued", parentId: "root", childIds: ["root"] },
    ];

    expect(buildGatewayRunTree(rows)).toMatchObject({
      id: "root",
      children: [{ id: "child", children: [] }],
    });
  });

  test("includes duplicated childIds only once", () => {
    const rows: GatewayRunNode[] = [
      { id: "root", name: "Root", kind: "compute", status: "running", childIds: ["child", "child"] },
      { id: "child", name: "Child", kind: "compute", status: "queued", parentId: "root", childIds: [] },
    ];

    expect(buildGatewayRunTree(rows)?.children?.map((child) => child.id)).toEqual(["child"]);
  });
});
