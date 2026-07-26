import { describe, expect, test } from "bun:test";
import { SmithersError } from "../src/SmithersError.js";
import { TaskHeartbeatTimeout } from "../src/TaskHeartbeatTimeout.js";
import { TaskTimeout } from "../src/TaskTimeout.js";
import { errorToJson } from "../src/errorToJson.js";
import { fromTaggedErrorPayload } from "../src/fromTaggedErrorPayload.js";
import { toTaggedErrorPayload } from "../src/toTaggedErrorPayload.js";

// These guarantees protect the engine's durable failed-task write path, which
// does `JSON.stringify(errorToJson(error))` (engine.js, *-task-bridge.js). An
// error while recording an error must never corrupt the durable log.
describe("errorToJson is JSON-safe on the error path", () => {
  test("preserves a plain Error cause and own enumerable properties", () => {
    const root = new Error("root cause");
    const err = new Error("wrapped", { cause: root });
    err.customField = { important: true };

    const round = JSON.parse(JSON.stringify(errorToJson(err)));
    expect(round.name).toBe("Error");
    expect(round.message).toBe("wrapped");
    expect(round.cause).toMatchObject({ name: "Error", message: "root cause" });
    expect(round.customField).toEqual({ important: true });
  });

  test("survives a throwing cause getter on a top-level plain Error", () => {
    const err = new Error("wrapped");
    Object.defineProperty(err, "cause", {
      enumerable: true,
      get() {
        throw new Error("cause getter boom");
      },
    });
    err.customField = "kept";

    const json = errorToJson(err);
    expect(() => JSON.stringify(json)).not.toThrow();
    const round = JSON.parse(JSON.stringify(json));
    expect(round.message).toBe("wrapped");
    expect(round.customField).toBe("kept");
    expect(round.cause).toBeUndefined();
  });

  test("does not throw on a circular cause (SmithersError includes cause)", () => {
    const inner = new Error("inner boom");
    const outer = new SmithersError("INTERNAL_ERROR", "outer boom", undefined, inner);
    // mutual reference cycle: outer.cause === inner, inner.cause === outer
    inner.cause = outer;

    const json = errorToJson(outer);
    expect(() => JSON.stringify(json)).not.toThrow();
    const round = JSON.parse(JSON.stringify(json));
    expect(round.message).toContain("outer boom");
    // the cycle is broken with a sentinel rather than throwing
    expect(JSON.stringify(json)).toContain("[Circular]");
  });

  test("does not throw on a self-referential cause", () => {
    const err = new SmithersError("INTERNAL_ERROR", "loop");
    err.cause = err;
    expect(() => JSON.stringify(errorToJson(err))).not.toThrow();
  });

  test("does not throw on BigInt details and serializes them as strings", () => {
    const err = new SmithersError("INVALID_INPUT", "bad input", {
      big: 10n,
      nested: { also: 20n },
    });
    const json = errorToJson(err);
    expect(() => JSON.stringify(json)).not.toThrow();
    const round = JSON.parse(JSON.stringify(json));
    expect(round.details.big).toBe("10");
    expect(round.details.nested.also).toBe("20");
  });

  test("does not throw on a circular details object", () => {
    /** @type {Record<string, unknown>} */
    const details = { name: "x" };
    details.self = details;
    const err = new SmithersError("INTERNAL_ERROR", "boom", details);
    expect(() => JSON.stringify(errorToJson(err))).not.toThrow();
  });

  test("drops functions/symbols and survives a throwing getter", () => {
    const err = new SmithersError("INTERNAL_ERROR", "boom", {
      fn: () => 1,
      sym: Symbol("s"),
      get explode() {
        throw new Error("getter boom");
      },
      ok: "kept",
    });
    const json = errorToJson(err);
    expect(() => JSON.stringify(json)).not.toThrow();
    const round = JSON.parse(JSON.stringify(json));
    expect(round.details.ok).toBe("kept");
    expect(round.details.fn).toBeUndefined();
    expect(round.details.explode).toBeUndefined();
  });

  test("survives a throwing own getter on a nested Error cause", () => {
    // buildErrorJson keeps `cause` as the raw Error, so toJsonSafe walks the
    // Error branch and iterates its own enumerable keys. A throwing getter on
    // that Error must be skipped, not crash the recording path.
    const inner = new Error("inner boom");
    Object.defineProperty(inner, "explode", {
      enumerable: true,
      get() {
        throw new Error("getter boom");
      },
    });
    Object.defineProperty(inner, "kept", {
      enumerable: true,
      value: "safe",
    });
    const err = new SmithersError("INTERNAL_ERROR", "outer", undefined, inner);
    const json = errorToJson(err);
    expect(() => JSON.stringify(json)).not.toThrow();
    const round = JSON.parse(JSON.stringify(json));
    expect(round.cause.message).toBe("inner boom");
    expect(round.cause.kept).toBe("safe");
    expect(round.cause.explode).toBeUndefined();
  });

  test("sanitizes array details, mapping undefined entries to null", () => {
    const err = new SmithersError("INTERNAL_ERROR", "boom", {
      list: [1, "two", undefined, () => 3, 4n, Number.NaN],
    });
    const json = errorToJson(err);
    expect(() => JSON.stringify(json)).not.toThrow();
    const round = JSON.parse(JSON.stringify(json));
    expect(round.details.list).toEqual([1, "two", null, null, "4", null]);
  });

  test("converts non-finite numbers to null so JSON stays valid", () => {
    const err = new SmithersError("INTERNAL_ERROR", "boom", {
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      good: 42,
    });
    const round = JSON.parse(JSON.stringify(errorToJson(err)));
    expect(round.details.nan).toBeNull();
    expect(round.details.inf).toBeNull();
    expect(round.details.good).toBe(42);
  });

  test("plain non-Error objects are sanitized too", () => {
    /** @type {Record<string, unknown>} */
    const value = { big: 5n };
    value.cycle = value;
    expect(() => JSON.stringify(errorToJson(value))).not.toThrow();
  });

  test("a top-level array is wrapped into a record, not passed through", () => {
    // Effect failures / `throw` can carry arrays (e.g. validation errors); the
    // durable write path stores errorToJson output as a JSON object.
    const json = errorToJson([1, "two"]);
    expect(Array.isArray(json)).toBe(false);
    expect(typeof json).toBe("object");
    expect(typeof json.message).toBe("string");
    expect(json.message).toBe('[1,"two"]');
    const round = JSON.parse(JSON.stringify(json));
    expect(round.value).toEqual([1, "two"]);
  });

  test("wrapped array values are still sanitized (undefined, bigint, cycles)", () => {
    /** @type {unknown[]} */
    const list = [undefined, 7n, () => 1];
    list.push(list);
    const json = errorToJson(list);
    expect(Array.isArray(json)).toBe(false);
    expect(() => JSON.stringify(json)).not.toThrow();
    const round = JSON.parse(JSON.stringify(json));
    expect(round.value).toEqual([null, "7", null, "[Circular]"]);
    expect(typeof round.message).toBe("string");
  });
});

describe("tagged-error payloads keep numeric fields finite across a round-trip", () => {
  test("TaskTimeout with missing numerics round-trips to defined numbers, not null", () => {
    // attempt/timeoutMs intentionally omitted -> Number(undefined) used to be NaN -> null.
    const err = new TaskTimeout({ message: "timed out", nodeId: "node-a" });
    const payload = toTaggedErrorPayload(err);
    expect(payload).toBeDefined();
    const round = JSON.parse(JSON.stringify(payload));
    expect(typeof round.attempt).toBe("number");
    expect(typeof round.timeoutMs).toBe("number");
    expect(round.attempt).not.toBeNull();
    expect(Number.isFinite(round.attempt)).toBe(true);
    expect(Number.isFinite(round.timeoutMs)).toBe(true);
    // reconstructing the tagged error from the round-tripped payload works
    const rebuilt = fromTaggedErrorPayload(round);
    expect(rebuilt._tag).toBe("TaskTimeout");
  });

  test("TaskTimeout preserves present numeric values exactly", () => {
    const err = new TaskTimeout({
      message: "timed out",
      nodeId: "node-a",
      attempt: 3,
      timeoutMs: 1500,
    });
    const round = JSON.parse(JSON.stringify(toTaggedErrorPayload(err)));
    expect(round.attempt).toBe(3);
    expect(round.timeoutMs).toBe(1500);
  });

  test("TaskHeartbeatTimeout numerics stay finite when omitted", () => {
    const err = new TaskHeartbeatTimeout({ message: "stale", nodeId: "n" });
    const round = JSON.parse(JSON.stringify(toTaggedErrorPayload(err)));
    for (const key of ["iteration", "attempt", "timeoutMs", "staleForMs", "lastHeartbeatAtMs"]) {
      expect(typeof round[key]).toBe("number");
      expect(Number.isFinite(round[key])).toBe(true);
    }
  });
});
