import { describe, expect, test } from "bun:test";
import { reconcileSnapshotNodes } from "../../src/sync/reconcileSnapshotNodes.ts";
import type { GatewayRunNode } from "../../src/sync/GatewayRunNode.ts";

describe("reconcileSnapshotNodes", () => {
  test("returns minimal insert, update, and delete writes", () => {
    const previous: GatewayRunNode[] = [
      { id: "root", name: "Workflow", kind: "compute", status: "queued", childIds: ["old"] },
      { id: "old", name: "Old", kind: "compute", status: "queued", parentId: "root", childIds: [] },
    ];
    const next: GatewayRunNode[] = [
      { id: "root", name: "Workflow", kind: "compute", status: "running", childIds: ["new"] },
      { id: "new", name: "New", kind: "agent", status: "queued", parentId: "root", childIds: [] },
    ];

    expect(reconcileSnapshotNodes(previous, next)).toEqual([
      { type: "update", value: next[0] },
      { type: "insert", value: next[1] },
      { type: "delete", key: "old" },
    ]);
  });

  test("ignores TanStack virtual row fields when comparing", () => {
    const current = {
      id: "root",
      name: "Workflow",
      kind: "compute",
      status: "queued",
      childIds: [],
      $synced: true,
      $origin: "remote",
      $key: "root",
      $collectionId: "nodes",
    } as GatewayRunNode;
    const next: GatewayRunNode = {
      id: "root",
      name: "Workflow",
      kind: "compute",
      status: "queued",
      childIds: [],
    };

    expect(reconcileSnapshotNodes([current], [next])).toEqual([]);
  });
});
