import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Effect } from "effect";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import {
  __staticTaskBridgeInternals as I,
  canExecuteBridgeManagedStaticTask,
  executeStaticTaskBridge,
} from "../src/effect/static-task-bridge.js";

function makeEventBus() {
  const events = [];
  return {
    events,
    emitEventWithPersist: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
  };
}

function makeHarness() {
  const schema = z.object({ value: z.number() });
  const api = createTestSmithers({ out: schema });
  ensureSmithersTables(api.db);
  return {
    ...api,
    adapter: new SmithersDb(api.db),
    schema,
  };
}

function makeDesc(table, schema, overrides = {}) {
  return {
    nodeId: "static",
    ordinal: 0,
    iteration: 0,
    outputTable: table,
    outputTableName: table._?.name ?? "out",
    outputSchema: schema,
    needsApproval: false,
    skipIf: false,
    retries: 0,
    timeoutMs: null,
    heartbeatTimeoutMs: null,
    continueOnFail: false,
    staticPayload: { value: 1 },
    ...overrides,
  };
}

async function insertRun(adapter, runId) {
  await adapter.insertRun({
    runId,
    workflowName: "static-test",
    workflowHash: "static-test",
    status: "running",
    createdAtMs: Date.now(),
  });
}

describe("static task bridge helpers", () => {
  test("classifies aborts and bridge-managed static task eligibility", () => {
    expect(I.isAbortError(null)).toBe(false);
    expect(I.isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(I.isAbortError({ name: "AbortError" })).toBe(true);
    expect(I.isAbortError(new Error("operation aborted"))).toBe(true);
    expect(I.isAbortError(new Error("plain failure"))).toBe(false);
    expect(I.isAbortError("plain")).toBe(false);

    expect(canExecuteBridgeManagedStaticTask({ staticPayload: { value: 1 } }, false)).toBe(true);
    expect(canExecuteBridgeManagedStaticTask({ staticPayload: { value: 1 } }, true)).toBe(false);
    expect(canExecuteBridgeManagedStaticTask({ staticPayload: { value: 1 }, cachePolicy: {} }, false)).toBe(false);
    expect(
      canExecuteBridgeManagedStaticTask({ staticPayload: { value: 1 }, sideEffect: { idempotent: false } }, false),
    ).toBe(false);
    expect(canExecuteBridgeManagedStaticTask({ staticPayload: { value: 1 }, agent: {} }, false)).toBe(false);
    expect(canExecuteBridgeManagedStaticTask({ staticPayload: { value: 1 }, computeFn: () => ({}) }, false)).toBe(
      false,
    );
    expect(canExecuteBridgeManagedStaticTask({}, false)).toBe(false);
    expect(canExecuteBridgeManagedStaticTask({ staticPayload: { value: 1 }, worktreePath: "/tmp/wt" }, false)).toBe(
      false,
    );
    expect(canExecuteBridgeManagedStaticTask({ staticPayload: { value: 1 }, scorers: { score: {} } }, false)).toBe(
      false,
    );
  });
});

describe("static task bridge execution branches", () => {
  test("cancels when the external signal is already aborted", async () => {
    const { adapter, tables, schema, cleanup } = makeHarness();
    try {
      const eventBus = makeEventBus();
      const desc = makeDesc(tables.out, schema, { nodeId: "static-abort" });
      await insertRun(adapter, "static-abort-run");
      const controller = new AbortController();
      controller.abort(new Error("operator stop"));
      await executeStaticTaskBridge(
        adapter,
        "static-abort-run",
        desc,
        eventBus,
        { rootDir: process.cwd() },
        "static-abort",
        controller.signal,
      );
      const attempts = await adapter.listAttempts("static-abort-run", "static-abort", 0);
      expect(attempts[0]?.state).toBe("cancelled");
      expect(eventBus.events.map((event) => event.type)).toContain("NodeCancelled");
    } finally {
      cleanup();
    }
  });

  test("marks zod-only validation failures as non-retryable and emits retry for retryable failures", async () => {
    const { adapter, tables, schema, cleanup } = makeHarness();
    try {
      const invalidDesc = makeDesc(tables.out, z.object({ value: z.string() }), {
        nodeId: "static-zod-invalid",
        retries: 3,
        staticPayload: { value: 2 },
      });
      await insertRun(adapter, "static-zod-invalid-run");
      await executeStaticTaskBridge(
        adapter,
        "static-zod-invalid-run",
        invalidDesc,
        makeEventBus(),
        { rootDir: process.cwd() },
        "static-zod-invalid",
      );
      const invalidAttempts = await adapter.listAttempts("static-zod-invalid-run", "static-zod-invalid", 0);
      expect(invalidAttempts[0]?.state).toBe("failed");
      expect(JSON.parse(invalidAttempts[0]?.metaJson ?? "{}").failureRetryable).toBe(false);

      const retryDesc = makeDesc(tables.out, schema, {
        nodeId: "static-retryable",
        retries: 1,
        staticPayload: { value: 3 },
      });
      await insertRun(adapter, "static-retryable-run");
      const retryBus = makeEventBus();
      const originalInsertNode = adapter.insertNode.bind(adapter);
      adapter.insertNode = (row) => {
        if (row.runId === "static-retryable-run" && row.state === "finished") {
          throw new Error("injected finish failure");
        }
        return originalInsertNode(row);
      };
      try {
        await executeStaticTaskBridge(
          adapter,
          "static-retryable-run",
          retryDesc,
          retryBus,
          { rootDir: process.cwd() },
          "static-retryable",
        );
      } finally {
        adapter.insertNode = originalInsertNode;
      }
      const retryAttempts = await adapter.listAttempts("static-retryable-run", "static-retryable", 0);
      expect(retryAttempts[0]?.state).toBe("failed");
      expect(retryBus.events.map((event) => event.type)).toContain("NodeRetrying");
    } finally {
      cleanup();
    }
  });
});
