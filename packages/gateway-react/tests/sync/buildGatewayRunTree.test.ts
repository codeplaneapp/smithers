import { describe, expect, test } from "bun:test";
import { flattenGatewayRunNode, mapSmithersElectricRow, type GatewayRunNode } from "@smthrs/gateway-client";
import { buildGatewayRunTree, SYNTHETIC_RUN_ROOT_KEY } from "../../src/sync/buildGatewayRunTree.ts";

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
      {
        key: "plan#0",
        id: "plan",
        iteration: 0,
        attempt: 1,
        name: "Plan",
        kind: "agent",
        status: "ok",
        parentId: "loop",
        childIds: [],
      },
      {
        key: "plan#1",
        id: "plan",
        iteration: 1,
        attempt: 2,
        name: "Plan",
        kind: "agent",
        status: "running",
        parentId: "loop",
        childIds: [],
      },
    ];

    const children = buildGatewayRunTree(rows)?.children ?? [];
    expect(children.map((child) => child.key)).toEqual(["plan#0", "plan#1"]);
    expect(children.map((child) => child.iteration)).toEqual([0, 1]);
    expect(children.map((child) => child.attempt)).toEqual([1, 2]);
  });

  test("preserves link-less sibling rows beneath a synthetic run root", () => {
    // Multiplayer `_smithers_nodes` rows carry no parentId/childIds at all, so
    // every row is a root. All of them must survive, not just the first —
    // using the state vocabulary the engine actually persists.
    const rows = [
      {
        run_id: "run",
        node_id: "a",
        label: "A",
        output_table: "agent",
        state: "finished",
        iteration: 0,
        last_attempt: 1,
      },
      {
        run_id: "run",
        node_id: "b",
        label: "B",
        output_table: "agent",
        state: "in-progress",
        iteration: 0,
        last_attempt: 2,
      },
      { run_id: "run", node_id: "c", label: "C", output_table: "agent", state: "pending", iteration: 0 },
    ].map((row) => mapSmithersElectricRow("nodes", row));

    const root = buildGatewayRunTree(rows);
    expect(root?.key).toBe(SYNTHETIC_RUN_ROOT_KEY);
    expect(root?.kind).toBe("workflow");
    expect(root?.status).toBe("running");
    expect(root?.children?.map((child) => child.key)).toEqual(["run:a:0", "run:b:0", "run:c:0"]);
    expect(root?.children?.map((child) => child.status)).toEqual(["ok", "running", "queued"]);
    expect(root?.children?.map((child) => child.attempt)).toEqual([1, 2, undefined]);
  });

  test("synthetic root reads active over failed with persisted states", () => {
    // Real `_smithers_nodes` rows persist `in-progress`/`failed`, not the UI's
    // `running`; an in-progress sibling must still win over a failed one.
    const rows = [
      { run_id: "run", node_id: "a", output_table: "agent", state: "failed", iteration: 0 },
      { run_id: "run", node_id: "b", output_table: "agent", state: "in-progress", iteration: 0 },
    ].map((row) => mapSmithersElectricRow("nodes", row));

    expect(buildGatewayRunTree(rows)?.status).toBe("running");
  });

  test("synthetic root reads ok when every persisted row is finished", () => {
    // `finished` normalizes to `ok`; the synthetic root must not surface the
    // raw persisted word (useGatewayRunTree would narrow it to `queued`).
    const rows = [
      { run_id: "run", node_id: "a", output_table: "agent", state: "finished", iteration: 0 },
      { run_id: "run", node_id: "b", output_table: "agent", state: "finished", iteration: 0 },
    ].map((row) => mapSmithersElectricRow("nodes", row));

    expect(buildGatewayRunTree(rows)?.status).toBe("ok");
  });

  test("synthetic root surfaces terminal failure once nothing is active", () => {
    const rows: GatewayRunNode[] = [
      { key: "run:a:0", id: "a", name: "A", kind: "agent", status: "ok", childIds: [] },
      { key: "run:b:0", id: "b", name: "B", kind: "agent", status: "failed", childIds: [] },
    ];

    expect(buildGatewayRunTree(rows)?.status).toBe("failed");
  });

  test("reconstructs nesting from parentId when childIds are absent", () => {
    // Rows that carry only the parent side of the link (no childIds) must
    // still rebuild their nested and parallel structure.
    const rows: GatewayRunNode[] = [
      { key: "root", id: "root", name: "Root", kind: "workflow", status: "running", childIds: [] },
      { key: "left", id: "left", name: "Left", kind: "parallel", status: "running", parentId: "root", childIds: [] },
      { key: "right", id: "right", name: "Right", kind: "parallel", status: "queued", parentId: "root", childIds: [] },
      { key: "leaf", id: "leaf", name: "Leaf", kind: "agent", status: "running", parentId: "left", childIds: [] },
    ];

    expect(buildGatewayRunTree(rows)).toMatchObject({
      key: "root",
      children: [
        { key: "left", children: [{ key: "leaf", children: [] }] },
        { key: "right", children: [] },
      ],
    });
  });

  test("parentId-only rows rebuild the same structure as childIds-linked rows", () => {
    // Flatten a nested tree, then strip the child side of every link: the
    // rebuilt tree must be structurally identical to the childIds rebuild.
    const tree: GatewayRunNode = {
      key: "root",
      id: "root",
      name: "Root",
      kind: "workflow",
      status: "running",
      children: [
        {
          key: "loop",
          id: "loop",
          name: "Loop",
          kind: "loop",
          status: "running",
          children: [
            { key: "plan#0", id: "plan", iteration: 0, name: "Plan", kind: "agent", status: "ok", children: [] },
            { key: "plan#1", id: "plan", iteration: 1, name: "Plan", kind: "agent", status: "running", children: [] },
          ],
        },
        { key: "review", id: "review", name: "Review", kind: "agent", status: "queued", children: [] },
      ],
    };

    const rows = flattenGatewayRunNode(tree);
    const parentOnlyRows = rows.map((row) => ({ ...row, childIds: [] }));

    const shape = (node: GatewayRunNode | null | undefined): unknown =>
      node ? { key: node.key, children: (node.children ?? []).map(shape) } : null;
    expect(shape(buildGatewayRunTree(parentOnlyRows))).toEqual(shape(buildGatewayRunTree(rows)));
  });

  test("keeps rows reachable only through a detached cycle", () => {
    const rows: GatewayRunNode[] = [
      { key: "root", id: "root", name: "Root", kind: "workflow", status: "running", childIds: [] },
      { key: "x", id: "x", name: "X", kind: "compute", status: "queued", childIds: ["y"] },
      { key: "y", id: "y", name: "Y", kind: "compute", status: "queued", childIds: ["x"] },
    ];

    const root = buildGatewayRunTree(rows);
    expect(root?.key).toBe(SYNTHETIC_RUN_ROOT_KEY);
    expect(root?.children?.map((child) => child.key)).toEqual(["root", "x"]);
    expect(root?.children?.[1]?.children?.map((child) => child.key)).toEqual(["y"]);
  });
});
