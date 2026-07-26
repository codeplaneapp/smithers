import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { applyConcurrencyLimits, __engineInternals as I } from "../src/engine.js";
import { extractBalancedJson, extractLastBalancedJson } from "../src/json-extraction.js";

/**
 * @param {string} id
 * @param {number} [iteration]
 * @returns {TaskDescriptor}
 */
function td(id, iteration = 0) {
  return {
    nodeId: id,
    ordinal: 0,
    iteration,
    ralphId: undefined,
    outputTable: null,
    outputTableName: "t",
    outputSchema: undefined,
    needsApproval: false,
    skipIf: false,
    retries: 0,
    timeoutMs: null,
    continueOnFail: false,
    agent: undefined,
    prompt: undefined,
    staticPayload: undefined,
    label: undefined,
    meta: undefined,
    parallelGroupId: undefined,
    parallelMaxConcurrency: undefined,
  };
}

function key(id, it = 0) {
  return `${id}::${it}`;
}

describe("engine: applyConcurrencyLimits() boundaries", () => {
  test("maxConcurrency of 0 admits nothing (and does not divide by zero)", () => {
    const all = [td("a"), td("b")];
    const selected = applyConcurrencyLimits([...all], new Map(), 0, all);
    expect(selected).toEqual([]);
  });

  test("in-progress at capacity clamps admissions to zero, never negative", () => {
    const all = [td("x"), td("y"), td("a")];
    const runnable = [all[2]];
    const states = new Map([
      [key("x"), "in-progress"],
      [key("y"), "in-progress"],
    ]);
    // 2 in-progress with maxConcurrency 1: capacity is max(0, 1 - 2) = 0.
    const selected = applyConcurrencyLimits(runnable, states, 1, all);
    expect(selected).toEqual([]);
  });

  test("empty runnable yields empty selection even with spare capacity", () => {
    const all = [td("x")];
    const selected = applyConcurrencyLimits([], new Map(), 5, all);
    expect(selected).toEqual([]);
  });

  test("admits every runnable task when capacity exceeds the runnable count", () => {
    const all = [td("a"), td("b")];
    const selected = applyConcurrencyLimits([...all], new Map(), 10, all);
    expect(selected.map((t) => t.nodeId)).toEqual(["a", "b"]);
  });

  test("counts in-progress iterations independently per (nodeId, iteration)", () => {
    // Same nodeId at two iterations, one in progress: only the in-progress
    // iteration consumes capacity.
    const all = [td("loop", 0), td("loop", 1), td("other")];
    const runnable = [all[1], all[2]];
    const states = new Map([[key("loop", 0), "in-progress"]]);
    const selected = applyConcurrencyLimits(runnable, states, 2, all);
    expect(selected.length).toBe(1);
  });

  test("non-in-progress states (completed, failed, pending) do not consume capacity", () => {
    const all = [td("done"), td("bad"), td("wait"), td("a"), td("b")];
    const runnable = [all[3], all[4]];
    const states = new Map([
      [key("done"), "completed"],
      [key("bad"), "failed"],
      [key("wait"), "pending"],
    ]);
    const selected = applyConcurrencyLimits(runnable, states, 2, all);
    expect(selected.map((t) => t.nodeId)).toEqual(["a", "b"]);
  });
});

/**
 * Fake adapter capturing writes for the cancellation maintenance helpers.
 *
 * @param {Array<{nodeId: string, iteration: number, attempt: number, startedAtMs: number | null}>} attempts
 * @param {{node?: object | null}} [opts]
 */
function makeCancellationAdapter(attempts, opts = {}) {
  const calls = [];
  const adapter = {
    listInProgressAttempts: () => Effect.succeed(attempts),
    getNode: () => Effect.succeed(opts.node === undefined ? { outputTable: "out", label: "L" } : opts.node),
    updateAttempt: (...args) => Effect.sync(() => calls.push(["updateAttempt", args])),
    markToolCallsUnknownForAttempt: (...args) =>
      Effect.sync(() => calls.push(["markToolCallsUnknownForAttempt", args])),
    insertNode: (row) => Effect.sync(() => calls.push(["insertNode", row])),
    withTransaction: (_label, effect) => Effect.runPromise(effect),
  };
  return { adapter, calls };
}

describe("engine internals: stale attempt cancellation boundaries", () => {
  test("fresh in-progress attempts are left alone", async () => {
    const { adapter, calls } = makeCancellationAdapter([
      { nodeId: "fresh", iteration: 0, attempt: 1, startedAtMs: Date.now() },
    ]);
    await I.cancelStaleAttempts(adapter, "run");
    expect(calls).toEqual([]);
  });

  test("attempts with no startedAtMs are never treated as stale", async () => {
    const { adapter, calls } = makeCancellationAdapter([
      { nodeId: "unknown-start", iteration: 0, attempt: 1, startedAtMs: null },
      { nodeId: "zero-start", iteration: 0, attempt: 1, startedAtMs: 0 },
    ]);
    await I.cancelStaleAttempts(adapter, "run");
    expect(calls).toEqual([]);
  });

  test("stale attempt with a missing node row falls back to empty outputTable and resets to pending", async () => {
    const { adapter, calls } = makeCancellationAdapter(
      [{ nodeId: "stale", iteration: 2, attempt: 3, startedAtMs: 1 }],
      { node: null },
    );
    await I.cancelStaleAttempts(adapter, "run");
    const insert = calls.find(([kind]) => kind === "insertNode")?.[1];
    expect(insert).toMatchObject({
      nodeId: "stale",
      iteration: 2,
      state: "pending",
      lastAttempt: 3,
      outputTable: "",
      label: null,
    });
    const update = calls.find(([kind]) => kind === "updateAttempt")?.[1];
    expect(update?.[4]).toMatchObject({ state: "cancelled" });
    expect(calls.find(([kind]) => kind === "markToolCallsUnknownForAttempt")?.[1].slice(0, 5)).toEqual([
      "run",
      "stale",
      2,
      3,
      expect.any(Number),
    ]);
  });
});

describe("engine internals: cancelInProgress boundaries", () => {
  test("no in-progress attempts means no writes and no events", async () => {
    const { adapter, calls } = makeCancellationAdapter([]);
    const events = [];
    const eventBus = { emitEventWithPersist: (event) => Effect.sync(() => events.push(event)) };
    await I.cancelInProgress(adapter, "run", eventBus);
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
  });

  test("missing node row falls back to empty outputTable while still emitting NodeCancelled", async () => {
    const { adapter, calls } = makeCancellationAdapter(
      [{ nodeId: "ghost", iteration: 0, attempt: 1, startedAtMs: 1 }],
      { node: null },
    );
    const events = [];
    const eventBus = { emitEventWithPersist: (event) => Effect.sync(() => events.push(event)) };
    await I.cancelInProgress(adapter, "run", eventBus);
    const insert = calls.find(([kind]) => kind === "insertNode")?.[1];
    expect(insert).toMatchObject({ state: "cancelled", outputTable: "", label: null });
    expect(calls.some(([kind]) => kind === "markToolCallsUnknownForAttempt")).toBe(true);
    expect(events).toMatchObject([{ type: "NodeCancelled", nodeId: "ghost", attempt: 1, reason: "unmounted" }]);
  });
});

describe("extractBalancedJson boundaries", () => {
  test("returns null for empty input and input without an opening brace", () => {
    expect(extractBalancedJson("")).toBeNull();
    expect(extractBalancedJson("no json at all")).toBeNull();
  });

  test("returns null for an unclosed object", () => {
    expect(extractBalancedJson('{"open": true')).toBeNull();
  });

  test("extracts the smallest object {}", () => {
    expect(extractBalancedJson("prefix {} suffix")).toBe("{}");
  });

  test("returns the FIRST balanced object, unlike extractLastBalancedJson", () => {
    const text = '{"first":1} noise {"second":2}';
    expect(extractBalancedJson(text)).toBe('{"first":1}');
    expect(extractLastBalancedJson(text)).toBe('{"second":2}');
  });

  test("a double backslash before a closing quote does not escape the quote", () => {
    const text = '{"path":"c:\\\\"} trailing';
    expect(extractBalancedJson(text)).toBe('{"path":"c:\\\\"}');
    expect(JSON.parse(extractBalancedJson(text))).toEqual({ path: "c:\\" });
  });

  test("a closing brace inside a string does not terminate the object", () => {
    const text = '{"a":"}"}';
    expect(extractBalancedJson(text)).toBe(text);
  });
});

describe("extractLastBalancedJson boundaries", () => {
  test("a stray closing brace before any opener is ignored (empty stack pop)", () => {
    expect(extractLastBalancedJson('} noise {"a":1}')).toBe('{"a":1}');
  });

  test("only stray closing braces yields null", () => {
    expect(extractLastBalancedJson("}}}")).toBeNull();
  });
});
