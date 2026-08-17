import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { SmithersDb } from "@smthrs/db/adapter";
import { setSmithersLogRunner } from "@smthrs/observability/logging";
import { Effect, Logger, References } from "effect";
import { approveNode, denyNode } from "../src/approvals.js";

function captureLogs() {
  const records = [];
  const layer = Logger.layer([
    Logger.make(({ logLevel, message, fiber }) => {
      records.push({
        level: logLevel,
        message: String(message),
        annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
      });
    }),
  ]);
  const run = (effect) => Effect.runSync(effect.pipe(Effect.provide(layer)));
  return {
    records,
    restore: setSmithersLogRunner({ runFork: run, runPromise: async (effect) => run(effect) }),
  };
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { adapter: new SmithersDb(db), sqlite };
}

async function seedWaitingApproval(adapter, runId, nodeId) {
  await adapter.insertRun({
    runId,
    workflowName: "test-wf",
    workflowHash: "h",
    status: "waiting-approval",
    createdAtMs: Date.now(),
  });
  await adapter.insertNode({
    runId,
    nodeId,
    iteration: 0,
    state: "waiting_approval",
    lastAttempt: null,
    updatedAtMs: Date.now(),
    outputTable: "approval_output",
    label: "Approval Gate",
  });
  await adapter.insertOrUpdateApproval({
    runId,
    nodeId,
    iteration: 0,
    status: "requested",
    requestedAtMs: Date.now() - 1000,
    decidedAtMs: null,
    note: null,
    decidedBy: null,
  });
}

// bridgeApprovalResolve derives its execution-id namespace from
// `adapter.db.$client.filename`; poisoning that access is the narrowest way to
// make the post-commit bridge step throw without touching the DB writes that
// precede it.
function poisonBridgeNamespace(adapter) {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === "db") {
        return {
          get $client() {
            throw new Error("bridge namespace boom");
          },
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("post-commit bridgeApprovalResolve failure is non-fatal", () => {
  test("approveNode still succeeds and durably commits the approval", async () => {
    const { adapter, sqlite } = createTestDb();
    const logs = captureLogs();
    try {
      await seedWaitingApproval(adapter, "run-1", "node-1");
      await Effect.runPromise(approveNode(poisonBridgeNamespace(adapter), "run-1", "node-1", 0, "ship it", "alice"));
      const approval = await adapter.getApproval("run-1", "node-1", 0);
      const node = await adapter.getNode("run-1", "node-1", 0);
      expect(approval?.status).toBe("approved");
      expect(approval?.note).toBe("ship it");
      expect(node?.state).toBe("pending");
      expect(logs.records).toHaveLength(1);
      expect(logs.records[0].message).toContain("post-commit approval bridge failed");
      expect(logs.records[0].annotations.error).toBe("bridge namespace boom");
    } finally {
      logs.restore();
      sqlite.close();
    }
  });

  test("denyNode still succeeds and durably commits the denial", async () => {
    const { adapter, sqlite } = createTestDb();
    const logs = captureLogs();
    try {
      await seedWaitingApproval(adapter, "run-2", "node-2");
      await Effect.runPromise(denyNode(poisonBridgeNamespace(adapter), "run-2", "node-2", 0, "nope", "bob"));
      const approval = await adapter.getApproval("run-2", "node-2", 0);
      const node = await adapter.getNode("run-2", "node-2", 0);
      expect(approval?.status).toBe("denied");
      expect(approval?.note).toBe("nope");
      expect(node?.state).toBe("failed");
      expect(logs.records).toHaveLength(1);
      expect(logs.records[0].message).toContain("post-commit approval bridge failed");
    } finally {
      logs.restore();
      sqlite.close();
    }
  });
});
