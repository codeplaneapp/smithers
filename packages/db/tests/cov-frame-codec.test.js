import { describe, expect, test } from "bun:test";
import { canonicalizeXml } from "@smithers-orchestrator/graph/utils/xml";
import {
  encodeFrameDelta,
  applyFrameDelta,
  applyFrameDeltaJson,
  parseFrameDelta,
  serializeFrameDelta,
  normalizeFrameEncoding,
  FRAME_KEYFRAME_INTERVAL,
} from "../src/frame-codec.js";

const task = (id, state, label) => ({
  kind: "element",
  tag: "smithers:task",
  props: { id, state, ...(label ? { label } : {}) },
  children: [],
});
const workflow = (children) => ({
  kind: "element",
  tag: "smithers:workflow",
  props: { name: "delta" },
  children,
});

describe("frame-codec.js (monolithic) — encode/apply parity with the modular copy", () => {
  test("constants + normalizeFrameEncoding", () => {
    expect(FRAME_KEYFRAME_INTERVAL).toBe(50);
    expect(normalizeFrameEncoding("delta")).toBe("delta");
    expect(normalizeFrameEncoding("keyframe")).toBe("keyframe");
    expect(normalizeFrameEncoding("other")).toBe("full");
  });

  test("parseFrameDelta rejects non-objects and missing ops", () => {
    expect(() => parseFrameDelta("123")).toThrow(/not an object/);
    expect(() => parseFrameDelta(JSON.stringify({ version: 9, ops: [] }))).toThrow(/version/);
    expect(() => parseFrameDelta(JSON.stringify({ version: 1 }))).toThrow(/ops array/);
  });

  test("state-only, prop add/remove, and reorder deltas round-trip", () => {
    const prev = canonicalizeXml(
      workflow([
        task("plan::0", "pending", "Plan"),
        task("impl::0", "in-progress", "Implement"),
        task("verify::0", "pending", "Verify"),
      ]),
    );
    const next = canonicalizeXml(
      workflow([
        task("plan::0", "finished", "Planning"),
        task("verify::0", "pending", "Verify"),
        task("review::0", "pending"),
        task("ship::0", "pending"),
      ]),
    );
    const delta = encodeFrameDelta(prev, next);
    const roundTrip = applyFrameDelta(prev, parseFrameDelta(serializeFrameDelta(delta)));
    expect(roundTrip).toBe(next);
    expect(delta.ops.some((op) => op.op === "insert")).toBe(true);
    expect(delta.ops.some((op) => op.op === "remove")).toBe(true);
    expect(applyFrameDeltaJson(prev, serializeFrameDelta(delta))).toBe(next);
  });

  test("prop add + prop remove exercise the object-diff and object set/remove apply paths", () => {
    const prev = canonicalizeXml(workflow([task("a::0", "pending", "A"), task("b::0", "pending")]));
    const next = canonicalizeXml(workflow([task("a::0", "pending"), task("b::0", "pending", "B")]));
    const delta = encodeFrameDelta(prev, next);
    expect(delta.ops.some((op) => op.op === "set")).toBe(true);
    expect(delta.ops.some((op) => op.op === "remove")).toBe(true);
    expect(applyFrameDelta(prev, delta)).toBe(next);
  });

  test("middle insert and middle remove keep prefix+suffix → pure insert / pure remove array diffs", () => {
    const two = canonicalizeXml(workflow([task("a::0", "pending"), task("c::0", "pending")]));
    const three = canonicalizeXml(
      workflow([task("a::0", "pending"), task("b::0", "pending"), task("c::0", "pending")]),
    );
    const insertDelta = encodeFrameDelta(two, three);
    expect(insertDelta.ops.every((op) => op.op === "insert")).toBe(true);
    expect(applyFrameDelta(two, insertDelta)).toBe(three);
    const removeDelta = encodeFrameDelta(three, two);
    expect(removeDelta.ops.every((op) => op.op === "remove")).toBe(true);
    expect(applyFrameDelta(three, removeDelta)).toBe(two);
    // identical frames → empty delta
    expect(encodeFrameDelta(two, two).ops).toEqual([]);
  });

  test("explicit root + array-index + null-value ops cover the remaining apply branches", () => {
    const xml = canonicalizeXml(workflow([task("a::0", "pending"), task("b::0", "pending")]));
    const replacement = workflow([task("z::0", "finished")]);
    const replaced = canonicalizeXml(replacement);
    expect(applyFrameDelta(xml, { version: 1, ops: [{ op: "set", path: [], value: replacement }] })).toBe(replaced);
    expect(applyFrameDelta(xml, { version: 1, ops: [{ op: "insert", path: [], value: replacement }] })).toBe(replaced);
    expect(typeof applyFrameDelta(xml, { version: 1, ops: [{ op: "remove", path: [] }] })).toBe("string");
    expect(
      applyFrameDelta(xml, {
        version: 1,
        ops: [{ op: "set", path: ["children", 1], value: task("z::0", "finished") }],
      }),
    ).toBe(canonicalizeXml(workflow([task("a::0", "pending"), task("z::0", "finished")])));
    expect(applyFrameDelta(xml, { version: 1, ops: [{ op: "set", path: ["props", "name"], value: null }] })).toContain(
      '"name":null',
    );
  });

  test("applyFrameDelta throws on every invalid path shape and unknown op", () => {
    const xml = canonicalizeXml(workflow([task("plan::0", "pending", "Plan")]));
    const cases = [
      [{ op: "insert", path: ["props", "name"], value: "x" }, /Invalid insert path/],
      [{ op: "set", path: ["children", "x"], value: 1 }, /Invalid array set path/],
      [{ op: "set", path: ["props", 0], value: 1 }, /Invalid object set path/],
      [{ op: "remove", path: ["children", "x"] }, /Invalid array remove path/],
      [{ op: "remove", path: ["props", 0] }, /Invalid object remove path/],
      [{ op: "set", path: ["props", "name", 0, "y"], value: 1 }, /Invalid numeric path segment/],
      [{ op: "set", path: ["props", "name", "x", "y"], value: 1 }, /Invalid object path segment/],
      [{ op: "replace", path: ["children", 0], value: null }, /Invalid frame delta op/],
    ];
    for (const [op, re] of cases) {
      expect(() => applyFrameDelta(xml, { version: 1, ops: [op] })).toThrow(re);
    }
  });
});
