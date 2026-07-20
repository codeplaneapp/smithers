import { describe, expect, test } from "bun:test";
import { applyDelta } from "../src/applyDelta.js";
import { InvalidDeltaError } from "../src/InvalidDeltaError.js";
import type { DevToolsSnapshotV1 } from "../src/DevToolsSnapshotV1.ts";

const base: DevToolsSnapshotV1 = {
  version: 1,
  runId: "run-apply",
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
        props: { value: 1 },
        task: { nodeId: "task-2", kind: "static", iteration: 0 },
        children: [],
        depth: 1,
      },
    ],
    depth: 0,
  },
};

describe("applyDelta", () => {
  test("throws typed InvalidDelta error for unknown target id and leaves state unchanged", () => {
    const input = structuredClone(base);
    const before = structuredClone(input);
    expect(() =>
      applyDelta(input, {
        version: 1,
        baseSeq: 1,
        seq: 2,
        ops: [{ op: "updateProps", id: 999, props: { nope: true } }],
      }),
    ).toThrowError(InvalidDeltaError);
    expect(input).toEqual(before);
  });

  test("applies two ops against the same node in deterministic order", () => {
    const result = applyDelta(base, {
      version: 1,
      baseSeq: 1,
      seq: 2,
      ops: [
        { op: "updateProps", id: 2, props: { value: 2 } },
        { op: "updateProps", id: 2, props: { value: 3 } },
      ],
    });
    expect(result.root.children[0]?.props.value).toBe(3);
  });

  test("rejects unsupported versions and malformed replaceRoot ops", () => {
    expect(() =>
      applyDelta(base, {
        version: 2,
        baseSeq: 1,
        seq: 2,
        ops: [],
      }),
    ).toThrowError(InvalidDeltaError);

    expect(() =>
      applyDelta(base, {
        version: 1,
        baseSeq: 1,
        seq: 2,
        ops: [{ op: "replaceRoot" } as never],
      }),
    ).toThrowError(InvalidDeltaError);
  });

  test("updates task sidecars, deletes them, and rejects unknown ops", () => {
    const updated = applyDelta(base, {
      version: 1,
      baseSeq: 1,
      seq: 2,
      ops: [{ op: "updateTask", id: 2, task: { nodeId: "task-2", kind: "agent", agent: "codex", iteration: 1 } }],
    });
    expect(updated.root.children[0]?.task).toMatchObject({ kind: "agent", agent: "codex" });

    const deleted = applyDelta(updated, {
      version: 1,
      baseSeq: 2,
      seq: 3,
      ops: [{ op: "updateTask", id: 2, task: undefined }],
    });
    expect(deleted.root.children[0]?.task).toBeUndefined();

    expect(() =>
      applyDelta(base, {
        version: 1,
        baseSeq: 1,
        seq: 2,
        ops: [{ op: "renameNode", id: 2 } as never],
      }),
    ).toThrowError(InvalidDeltaError);

    expect(() =>
      applyDelta(base, {
        version: 1,
        baseSeq: 1,
        seq: 2,
        ops: [{ op: "updateTask", id: 999, task: undefined }],
      }),
    ).toThrowError(InvalidDeltaError);
  });

  test("falls back to JSON cloning when structuredClone is unavailable", () => {
    const original = globalThis.structuredClone;
    try {
      (globalThis as typeof globalThis & { structuredClone?: typeof structuredClone }).structuredClone = undefined;
      const result = applyDelta(base, {
        version: 1,
        baseSeq: 1,
        seq: 2,
        ops: [{ op: "updateProps", id: 2, props: { fallback: true } }],
      });
      expect(result.root.children[0]?.props).toEqual({ fallback: true });
    } finally {
      globalThis.structuredClone = original;
    }
  });
});
