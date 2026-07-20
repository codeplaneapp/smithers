import { describe, expect, test } from "bun:test";
import { snapshotSerialize } from "../src/snapshotSerializer.js";

describe("snapshotSerialize", () => {
  test("serializes scalars, arrays, objects, null, undefined, booleans", () => {
    expect(snapshotSerialize("abc")).toBe("abc");
    expect(snapshotSerialize(1)).toBe(1);
    expect(snapshotSerialize(true)).toBe(true);
    expect(snapshotSerialize(null)).toBeNull();
    expect(snapshotSerialize(undefined)).toBeUndefined();
    expect(snapshotSerialize([1, "two", false])).toEqual([1, "two", false]);
    expect(snapshotSerialize({ a: 1, b: "two", c: null })).toEqual({
      a: 1,
      b: "two",
      c: null,
    });
  });

  test("passes through large strings (1MB)", () => {
    const large = "x".repeat(1024 * 1024);
    expect(snapshotSerialize(large)).toBe(large);
  });

  test("replaces circular references with [Circular]", () => {
    const value: Record<string, unknown> = { name: "root" };
    value.self = value;
    const out = snapshotSerialize(value) as Record<string, unknown>;
    expect(out.self).toBe("[Circular]");
  });

  test("replaces non-serializable values and never throws", () => {
    const result = snapshotSerialize({
      fn: () => "x",
      sym: Symbol("token"),
      bareSym: Symbol(),
      dt: new Date("2026-01-01T00:00:00.000Z"),
      invalidDate: new Date("not-a-date"),
      big: BigInt(42),
    }) as Record<string, unknown>;
    expect(result.fn).toBe("[Function]");
    expect(result.sym).toBe("[Symbol: token]");
    expect(result.bareSym).toBe("[Symbol]");
    expect(result.dt).toBe("[Date: 2026-01-01T00:00:00.000Z]");
    expect(result.invalidDate).toBe("[Date: Invalid]");
    expect(result.big).toBe("[BigInt: 42]");
  });

  test("truncates depth > 100 with [MaxDepth]", () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let depth = 0; depth <= 110; depth += 1) {
      cursor.child = {};
      cursor = cursor.child as Record<string, unknown>;
    }
    const serialized = snapshotSerialize(root, { maxDepth: 100 }) as Record<string, unknown>;
    let scan = serialized;
    for (let depth = 0; depth < 100; depth += 1) {
      scan = scan.child as Record<string, unknown>;
    }
    expect(scan.child).toBe("[MaxDepth]");
  });

  test("emits warnings for serializer limits and unsupported values", () => {
    const warnings: unknown[] = [];
    const throwing: Record<string, unknown> = {};
    Object.defineProperty(throwing, "broken", {
      enumerable: true,
      get() {
        throw new Error("nope");
      },
    });
    const circular: Record<string, unknown> = { name: "root" };
    circular.self = circular;

    const serialized = snapshotSerialize(
      {
        circular,
        map: new Map([["k", "v"]]),
        throwing,
        many: ["a", "b"],
      },
      {
        maxDepth: 20,
        maxEntries: 20,
        onWarning(warning) {
          warnings.push(warning);
        },
      },
    ) as Record<string, unknown>;

    expect(serialized.map).toBe("[Map]");
    expect(serialized.throwing).toEqual({ broken: "[Unserializable]" });
    expect(serialized.circular).toEqual({ name: "root", self: "[Circular]" });
    expect(warnings).toContainEqual({ code: "UnsupportedType", path: "$.map", detail: "Map" });
    expect(warnings).toContainEqual({ code: "UnsupportedType", path: "$.throwing.broken", detail: "ThrownDuringRead" });
    expect(warnings).toContainEqual({ code: "CircularReference", path: "$.circular.self" });
  });

  test("emits a warning when maxDepth is exceeded", () => {
    const warnings: unknown[] = [];
    const serialized = snapshotSerialize({ nested: { child: { value: 1 } } }, {
      maxDepth: 1,
      onWarning(warning) {
        warnings.push(warning);
      },
    });
    expect(serialized).toEqual({ nested: { child: "[MaxDepth]" } });
    expect(warnings).toContainEqual({ code: "MaxDepthExceeded", path: "$.nested.child" });
  });

  test("emits a warning when maxEntries is exceeded", () => {
    const warnings: unknown[] = [];
    const serialized = snapshotSerialize([{ value: 1 }, { value: 2 }], {
      maxEntries: 1,
      onWarning(warning) {
        warnings.push(warning);
      },
    });
    expect(serialized).toEqual(["[MaxEntries]", "[MaxEntries]"]);
    expect(warnings).toContainEqual({ code: "MaxEntriesExceeded", path: "$[0]" });
  });

  test("bounds a flat array of scalars by maxEntries (scalars are counted)", () => {
    // Regression: scalar leaves used to return before the maxEntries check, so
    // a flat scalar collection bypassed the cap entirely.
    const serialized = snapshotSerialize([1, 2, 3, 4, 5], { maxEntries: 3 });
    // array (1) + first two scalars (2,3) fit; the rest are capped.
    expect(serialized).toEqual([1, 2, "[MaxEntries]", "[MaxEntries]", "[MaxEntries]"]);
  });

  test("bounds a flat object of scalars by maxEntries", () => {
    const serialized = snapshotSerialize({ a: 1, b: 2, c: 3, d: 4 }, { maxEntries: 3 });
    // object (1) + a,b (2,3) fit (keys sorted); c,d capped.
    expect(serialized).toEqual({ a: 1, b: 2, c: "[MaxEntries]", d: "[MaxEntries]" });
  });

  test("normalizes numeric serializer options", () => {
    expect(snapshotSerialize({ child: true }, { maxDepth: -1 })).toEqual({ child: "[MaxDepth]" });
    expect(snapshotSerialize([{ value: 1 }], { maxEntries: 0 })).toEqual(["[MaxEntries]"]);
  });

  test("serializes non-plain values passed at the top level", () => {
    expect(snapshotSerialize(10n)).toBe("[BigInt: 10]");
    expect(snapshotSerialize(() => {})).toBe("[Function]");
    expect(snapshotSerialize(Symbol("tag"))).toBe("[Symbol: tag]");
    expect(snapshotSerialize(Symbol())).toBe("[Symbol]");
    expect(snapshotSerialize(new Date("2026-06-19T00:00:00.000Z"))).toBe("[Date: 2026-06-19T00:00:00.000Z]");
    expect(snapshotSerialize(new Date("not-a-date"))).toBe("[Date: Invalid]");
  });

  test("renders a top-level named-class instance as [Ctor] with a warning", () => {
    class Widget {
      x = 1;
    }
    const warnings: Array<{ code: string; detail?: string }> = [];
    const result = snapshotSerialize(new Widget(), { onWarning: (w) => warnings.push(w) });
    expect(result).toBe("[Widget]");
    expect(warnings).toEqual([{ code: "UnsupportedType", path: "$", detail: "Widget" }]);
  });

  test("serializes an anonymous-class instance as its own enumerable keys", () => {
    // An anonymous class has an empty constructor name, so the [Ctor] guard does
    // not fire and the instance's own enumerable fields are walked like an object.
    const instance = new (class {
      a = 1;
      b = "two";
    })();
    expect(snapshotSerialize(instance)).toEqual({ a: 1, b: "two" });
  });
});
