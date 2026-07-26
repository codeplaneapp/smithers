import { afterEach, describe, expect, test } from "bun:test";
import { __serverTestInternals } from "../src/index.js";

const { getDbIdentity, isSameDb, scheduleRunCleanup, clearRunCleanupTimer } = __serverTestInternals;
const runs = new Map();

afterEach(() => {
  runs.clear();
});

describe("getDbIdentity", () => {
  test("returns undefined for non-object inputs", () => {
    expect(getDbIdentity(null)).toBeUndefined();
    expect(getDbIdentity(undefined)).toBeUndefined();
    expect(getDbIdentity("db")).toBeUndefined();
    expect(getDbIdentity(42)).toBeUndefined();
  });

  test("returns undefined when $client is missing or not an object", () => {
    expect(getDbIdentity({})).toBeUndefined();
    expect(getDbIdentity({ $client: null })).toBeUndefined();
    expect(getDbIdentity({ $client: "sqlite" })).toBeUndefined();
  });

  test("prefers $client.filename", () => {
    expect(getDbIdentity({ $client: { filename: "/tmp/a.db", name: "n", dbname: "d" } })).toBe("/tmp/a.db");
  });

  test("falls back to $client.name when filename is absent", () => {
    expect(getDbIdentity({ $client: { name: "run.db", dbname: "d" } })).toBe("run.db");
  });

  test("falls back to $client.dbname when filename and name are absent", () => {
    expect(getDbIdentity({ $client: { dbname: "wf.db" } })).toBe("wf.db");
  });

  test("returns undefined when no identity field is a string", () => {
    expect(getDbIdentity({ $client: { filename: 1, name: 2, dbname: 3 } })).toBeUndefined();
    expect(getDbIdentity({ $client: {} })).toBeUndefined();
  });
});

describe("isSameDb", () => {
  test("returns false when serverDb is falsy", () => {
    expect(isSameDb(null, { $client: { filename: "x" } })).toBe(false);
    expect(isSameDb(undefined, {})).toBe(false);
  });

  test("returns true for identical object references", () => {
    const db = { $client: { filename: "same" } };
    expect(isSameDb(db, db)).toBe(true);
  });

  test("returns true when distinct objects share a db identity", () => {
    const serverDb = { $client: { filename: "/tmp/shared.db" } };
    const workflowDb = { $client: { filename: "/tmp/shared.db" } };
    expect(isSameDb(serverDb, workflowDb)).toBe(true);
  });

  test("returns false when identities differ", () => {
    const serverDb = { $client: { filename: "/tmp/server.db" } };
    const workflowDb = { $client: { filename: "/tmp/workflow.db" } };
    expect(isSameDb(serverDb, workflowDb)).toBe(false);
  });

  test("returns false when either identity is undefined", () => {
    const serverDb = { $client: { filename: "/tmp/server.db" } };
    const workflowDb = { $client: {} };
    expect(isSameDb(serverDb, workflowDb)).toBe(false);
  });
});

describe("scheduleRunCleanup", () => {
  test("is a no-op when the run record is unknown", () => {
    // No record registered for this id → returns before scheduling a timer.
    expect(() => scheduleRunCleanup(runs, "ghost-run")).not.toThrow();
  });

  test("evicts the record when the cleanup timer fires and it is unchanged", () => {
    const nativeSetTimeout = globalThis.setTimeout;
    let captured = null;
    globalThis.setTimeout = (fn, ms) => {
      captured = { fn, ms };
      return nativeSetTimeout(() => {}, 0);
    };
    try {
      const record = { workflow: {}, abort: new AbortController(), cleanupTimer: null };
      runs.set("run-evict", record);
      scheduleRunCleanup(runs, "run-evict");
      expect(captured).not.toBeNull();
      expect(captured.ms).toBe(60_000);
      expect(record.cleanupTimer).not.toBeNull();
      // Fire the retention timer: the record is still the one registered, so
      // it is deleted from the live map.
      captured.fn();
      expect(runs.has("run-evict")).toBe(false);
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
    }
  });

  test("keeps a replacement record when the timer fires after re-registration", () => {
    const nativeSetTimeout = globalThis.setTimeout;
    let captured = null;
    globalThis.setTimeout = (fn) => {
      captured = fn;
      return nativeSetTimeout(() => {}, 0);
    };
    try {
      const original = { workflow: {}, abort: new AbortController(), cleanupTimer: null };
      runs.set("run-replaced", original);
      scheduleRunCleanup(runs, "run-replaced");
      // A brand-new run reuses the id before the retention window elapses.
      const replacement = { workflow: {}, abort: new AbortController(), cleanupTimer: null };
      runs.set("run-replaced", replacement);
      captured();
      // The stale timer must NOT evict the live replacement record.
      expect(runs.get("run-replaced")).toBe(replacement);
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
    }
  });

  test("scheduling twice clears the previous timer", () => {
    const record = { workflow: {}, abort: new AbortController(), cleanupTimer: null };
    runs.set("run-twice", record);
    scheduleRunCleanup(runs, "run-twice");
    const firstTimer = record.cleanupTimer;
    expect(firstTimer).not.toBeNull();
    scheduleRunCleanup(runs, "run-twice");
    expect(record.cleanupTimer).not.toBe(firstTimer);
    clearRunCleanupTimer(record);
    expect(record.cleanupTimer).toBeNull();
  });
});

describe("mirror onProgress persistence-failure isolation", () => {
  test("swallows adapter failures without latching runInserted", async () => {
    const { buildMirrorOnProgress } = __serverTestInternals;
    let insertRunCalls = 0;
    const failingAdapter = {
      insertRun: () => {
        insertRunCalls += 1;
        throw new Error("db offline");
      },
    };
    const onProgress = buildMirrorOnProgress(failingAdapter, "run-x", "wf", "/wf.tsx", "{}");
    expect(typeof onProgress).toBe("function");
    // Two events: each drives ensureRun → insertRun, which throws. The tail
    // .catch must swallow the rejection (no unhandled crash) and, because
    // ensureRun never reached `runInserted = true`, the second event retries
    // insertRun rather than skipping it.
    onProgress({ type: "RunStarted", runId: "run-x", timestampMs: 1 });
    onProgress({ type: "RunStarted", runId: "run-x", timestampMs: 2 });
    // Let the serialized mirror tail drain.
    for (let i = 0; i < 20 && insertRunCalls < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(insertRunCalls).toBe(2);
  });
});
