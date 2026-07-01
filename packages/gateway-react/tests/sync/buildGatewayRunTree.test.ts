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

  test("preserves a cancelled node's status (never collapses to failed/queued)", () => {
    // A deliberately-cancelled run must stay `cancelled` through the tree rebuild
    // so the UI renders it dim/grey, not as a red failure or a queued node.
    const rows: GatewayRunNode[] = [
      { id: "root", name: "Root", kind: "compute", status: "cancelled", childIds: ["child"] },
      { id: "child", name: "Child", kind: "agent", status: "cancelled", parentId: "root", childIds: [] },
    ];

    const root = buildGatewayRunTree(rows);
    expect(root?.status).toBe("cancelled");
    expect(root?.children?.[0]?.status).toBe("cancelled");
  });

  test("rebuilds loop/retry attempts that share a logical id as distinct children", () => {
    // Rows are linked by the unique `key`, so two attempts of `plan` survive as
    // separate children even though they share `id`.
    const rows: GatewayRunNode[] = [
      { key: "loop", id: "loop", name: "Loop", kind: "loop", status: "running", childIds: ["plan#0", "plan#1"] },
      { key: "plan#0", id: "plan", iteration: 0, name: "Plan", kind: "agent", status: "ok", parentId: "loop", childIds: [] },
      { key: "plan#1", id: "plan", iteration: 1, name: "Plan", kind: "agent", status: "running", parentId: "loop", childIds: [] },
    ];

    const children = buildGatewayRunTree(rows)?.children ?? [];
    expect(children.map((child) => child.key)).toEqual(["plan#0", "plan#1"]);
    expect(children.map((child) => child.iteration)).toEqual([0, 1]);
  });
});
