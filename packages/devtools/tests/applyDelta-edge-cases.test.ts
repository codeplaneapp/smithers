import { describe, expect, test } from "bun:test";
import { applyDelta } from "../src/applyDelta.js";
import { InvalidDeltaError } from "../src/InvalidDeltaError.js";
import type { DevToolsSnapshotV1 } from "../src/DevToolsSnapshotV1.ts";
import type { DevToolsNode } from "../src/DevToolsNode.ts";

const baseSnapshot = (): DevToolsSnapshotV1 => ({
  version: 1,
  runId: "run-edge",
  frameNo: 1,
  seq: 1,
  root: {
    id: 1,
    type: "workflow",
    name: "workflow",
    props: {},
    children: [
      {
        id: 2,
        type: "task",
        name: "task-2",
        props: {},
        children: [],
        depth: 1,
      },
    ],
    depth: 0,
  },
});

const taskNode = (id: number, name = `task-${id}`): DevToolsNode => ({
  id,
  type: "task",
  name,
  props: {},
  children: [],
  depth: 1,
});

describe("applyDelta — out-of-order and inconsistent ops", () => {
  test("removeNode for an id that was never added throws InvalidDeltaError and leaves snapshot untouched", () => {
    const snap = baseSnapshot();
    const before = structuredClone(snap);
    expect(() =>
      applyDelta(snap, {
        version: 1,
        baseSeq: 1,
        seq: 2,
        ops: [{ op: "removeNode", id: 999 }],
      }),
    ).toThrowError(InvalidDeltaError);
    expect(snap).toEqual(before);
  });

  test("addNode whose parentId points at an id that was just removed in the same delta fails clearly", () => {
    const snap = baseSnapshot();
    expect(() =>
      applyDelta(snap, {
        version: 1,
        baseSeq: 1,
        seq: 2,
        ops: [
          { op: "removeNode", id: 2 },
          // 2 is now gone — adding under it must fail with the typed error.
          { op: "addNode", parentId: 2, index: 0, node: taskNode(3) },
        ],
      }),
    ).toThrowError(InvalidDeltaError);
  });

  test("removing the root is rejected with a clear error", () => {
    const snap = baseSnapshot();
    expect(() =>
      applyDelta(snap, {
        version: 1,
        baseSeq: 1,
        seq: 2,
        ops: [{ op: "removeNode", id: snap.root.id }],
      }),
    ).toThrowError(InvalidDeltaError);
  });

  test("updateProps on a deleted node fails after the deletion, in op order", () => {
    const snap = baseSnapshot();
    expect(() =>
      applyDelta(snap, {
        version: 1,
        baseSeq: 1,
        seq: 2,
        ops: [
          { op: "removeNode", id: 2 },
          { op: "updateProps", id: 2, props: { x: 1 } },
        ],
      }),
    ).toThrowError(InvalidDeltaError);
  });

  test("baseSeq mismatch is rejected (out-of-band delta)", () => {
    const snap = baseSnapshot();
    expect(() =>
      applyDelta(snap, {
        version: 1,
        baseSeq: 999,
        seq: 1000,
        ops: [],
      }),
    ).toThrowError(InvalidDeltaError);
  });

  test("addNode without a node object is rejected (no tree corruption)", () => {
    const snap = baseSnapshot();
    expect(() =>
      applyDelta(snap, {
        version: 1,
        baseSeq: 1,
        seq: 2,
        // @ts-expect-error malformed payload: missing node
        ops: [{ op: "addNode", parentId: 2, index: 0 }],
      }),
    ).toThrowError(InvalidDeltaError);
  });

  test("addNode with a non-numeric index is rejected", () => {
    const snap = baseSnapshot();
    expect(() =>
      applyDelta(snap, {
        version: 1,
        baseSeq: 1,
        seq: 2,
        // @ts-expect-error malformed payload: index is not a number
        ops: [{ op: "addNode", parentId: 2, index: "x", node: { id: 3, type: "task", name: "t3", props: {}, children: [], depth: 1 } }],
      }),
    ).toThrowError(InvalidDeltaError);
  });

  test("updateProps with no props key is rejected (does not set props=undefined)", () => {
    const snap = baseSnapshot();
    expect(() =>
      applyDelta(snap, {
        version: 1,
        baseSeq: 1,
        seq: 2,
        // @ts-expect-error malformed payload: missing props
        ops: [{ op: "updateProps", id: 2 }],
      }),
    ).toThrowError(InvalidDeltaError);
  });

  test("updateTask with a non-object task is rejected", () => {
    const snap = baseSnapshot();
    expect(() =>
      applyDelta(snap, {
        version: 1,
        baseSeq: 1,
        seq: 2,
        // @ts-expect-error malformed payload: task is a scalar
        ops: [{ op: "updateTask", id: 2, task: "nope" }],
      }),
    ).toThrowError(InvalidDeltaError);
  });

  test("updateTask with a null task is rejected", () => {
    const snap = baseSnapshot();
    expect(() =>
      applyDelta(snap, {
        version: 1,
        baseSeq: 1,
        seq: 2,
        // @ts-expect-error malformed payload: task is null
        ops: [{ op: "updateTask", id: 2, task: null }],
      }),
    ).toThrowError(InvalidDeltaError);
  });
});
