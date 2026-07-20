import { describe, expect, test } from "bun:test";
import { findDescriptor } from "../src/findDescriptor.js";

describe("findDescriptor", () => {
  test("is a keyed lookup, never a linear scan (issue #546)", () => {
    const descriptors = new Map([
      ["someOtherKey", { nodeId: "real", iteration: 0 }],
    ]);
    expect(findDescriptor(descriptors, "real")).toBeUndefined();
  });

  test("returns the entry stored under its nodeId", () => {
    const d = { nodeId: "a", iteration: 0 };
    const descriptors = new Map([["a", d]]);
    expect(findDescriptor(descriptors, "a")).toBe(d);
    expect(findDescriptor(descriptors, "a", 0)).toBe(d);
  });

  test("stale/mismatched iteration returns undefined", () => {
    const d = { nodeId: "a", iteration: 3 };
    const descriptors = new Map([["a", d]]);
    expect(findDescriptor(descriptors, "a", 2)).toBeUndefined();
  });
});
