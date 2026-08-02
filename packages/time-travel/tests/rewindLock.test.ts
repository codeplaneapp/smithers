import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { acquireRewindLock, hasRewindLock, resetRewindLocksForTests } from "../src/rewindLock.js";

function setupDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

afterEach(() => {
  resetRewindLocksForTests();
});

describe("rewindLock", () => {
  test("single caller releases conditionally and a second caller proceeds", async () => {
    const { sqlite, adapter } = setupDb();
    try {
      const first = await acquireRewindLock(adapter, "run-1", { autoRenew: false });
      expect(first).not.toBeNull();
      expect(hasRewindLock("run-1")).toBe(true);

      expect(await first?.release()).toBe(true);
      expect(await first?.release()).toBe(false);
      expect(hasRewindLock("run-1")).toBe(false);

      const second = await acquireRewindLock(adapter, "run-1", { autoRenew: false });
      expect(second).not.toBeNull();
      expect(await second?.release()).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  test("same-process contenders get one durable owner", async () => {
    const { sqlite, adapter } = setupDb();
    try {
      const [first, second] = await Promise.all([
        acquireRewindLock(adapter, "run-busy", { autoRenew: false }),
        acquireRewindLock(adapter, "run-busy", { autoRenew: false }),
      ]);
      const winner = first ?? second;
      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect(await winner?.renew()).toBe(true);
      expect(await winner?.release()).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  test("fork lineage does not share the source run's lease", async () => {
    const { sqlite, adapter } = setupDb();
    try {
      await adapter.insertRun({
        runId: "source-run",
        workflowName: "source",
        status: "finished",
        createdAtMs: Date.now(),
      });
      await adapter.insertRun({
        runId: "fork-run",
        parentRunId: "source-run",
        workflowName: "fork",
        status: "finished",
        createdAtMs: Date.now(),
      });

      const sourceLease = await acquireRewindLock(adapter, "source-run", { autoRenew: false });
      const forkLease = await acquireRewindLock(adapter, "fork-run", { autoRenew: false });
      expect(sourceLease).not.toBeNull();
      expect(forkLease).not.toBeNull();

      expect(await forkLease?.release()).toBe(true);
      expect(await sourceLease?.release()).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  test("child aliases report the resolved parent lease while held", async () => {
    const { sqlite, adapter } = setupDb();
    try {
      const parentRunId = "parent-run";
      const childRunId = `${parentRunId}:child:review:0`;
      await adapter.insertRun({
        runId: parentRunId,
        workflowName: "parent",
        status: "finished",
        createdAtMs: Date.now(),
      });
      await adapter.insertRun({
        runId: childRunId,
        parentRunId,
        workflowName: "child",
        status: "finished",
        createdAtMs: Date.now(),
      });

      const lease = await acquireRewindLock(adapter, childRunId, { autoRenew: false });
      expect(lease?.runId).toBe(parentRunId);
      expect(hasRewindLock(childRunId)).toBe(true);
      expect(hasRewindLock(parentRunId)).toBe(true);

      expect(await lease?.release()).toBe(true);
      expect(hasRewindLock(childRunId)).toBe(false);
      expect(hasRewindLock(parentRunId)).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  test("explicitly named child runs share their parent's workspace lease", async () => {
    const { sqlite, adapter } = setupDb();
    try {
      const parentRunId = "parent-run";
      const childRunId = "release-validation";
      await adapter.insertRun({
        runId: parentRunId,
        workflowName: "parent",
        status: "finished",
        createdAtMs: Date.now(),
      });
      await adapter.insertRun({
        runId: childRunId,
        parentRunId,
        workflowName: "child",
        status: "finished",
        createdAtMs: Date.now(),
        configJson: JSON.stringify({ subflowWorkspaceParentRunId: parentRunId }),
      });

      const parentLease = await acquireRewindLock(adapter, parentRunId, { autoRenew: false });
      expect(parentLease).not.toBeNull();
      expect(await acquireRewindLock(adapter, childRunId, { autoRenew: false })).toBeNull();
      expect(await parentLease?.release()).toBe(true);

      const childLease = await acquireRewindLock(adapter, childRunId, { autoRenew: false });
      expect(childLease?.runId).toBe(parentRunId);
      expect(await childLease?.release()).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  test("validates lock options and storage before probing child lineage", async () => {
    const { sqlite, adapter } = setupDb();
    const originalGetRun = adapter.getRun.bind(adapter);
    try {
      adapter.getRun = (() => {
        throw new Error("lineage probe should not run");
      }) as typeof adapter.getRun;
      await expect(
        acquireRewindLock(adapter, "parent:child:review:0", {
          leaseTtlMs: 0,
          autoRenew: false,
        }),
      ).rejects.toThrow("leaseTtlMs must be a positive finite number");
      await expect(
        acquireRewindLock({ getRun: adapter.getRun } as SmithersDb, "parent:child:review:0", {
          autoRenew: false,
        }),
      ).rejects.toThrow("Rewind locking requires a SmithersDb backed by internalStorage");
    } finally {
      adapter.getRun = originalGetRun;
      sqlite.close();
    }
  });

  test("does not probe run lineage for ordinary root run ids", async () => {
    const { sqlite, adapter } = setupDb();
    const originalGetRun = adapter.getRun.bind(adapter);
    try {
      adapter.getRun = (() => {
        throw new Error("ordinary run should not be loaded");
      }) as typeof adapter.getRun;
      const lease = await acquireRewindLock(adapter, "ordinary-run", { autoRenew: false });
      expect(lease).not.toBeNull();
      expect(await lease?.release()).toBe(true);
    } finally {
      adapter.getRun = originalGetRun;
      sqlite.close();
    }
  });

  test("expired owner is replaced and cannot release the new lease", async () => {
    const { sqlite, adapter } = setupDb();
    let now = 1_000;
    try {
      const staleOwner = await acquireRewindLock(adapter, "run-stale", {
        nowMs: () => now,
        leaseTtlMs: 100,
        autoRenew: false,
      });
      expect(staleOwner).not.toBeNull();

      // Simulate a crashed process by clearing only its advisory in-memory
      // guard. The durable row remains until its lease expires.
      resetRewindLocksForTests();
      now = 1_099;
      expect(
        await acquireRewindLock(adapter, "run-stale", {
          nowMs: () => now,
          leaseTtlMs: 100,
          autoRenew: false,
        }),
      ).toBeNull();

      now = 1_100;
      const replacement = await acquireRewindLock(adapter, "run-stale", {
        nowMs: () => now,
        leaseTtlMs: 100,
        autoRenew: false,
      });
      expect(replacement).not.toBeNull();
      expect(await staleOwner?.release()).toBe(false);
      expect(await replacement?.renew()).toBe(true);
      expect(await replacement?.release()).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  test("background renewal failure trips a sticky fence and surfaces at the next check", async () => {
    const { sqlite, adapter } = setupDb();
    const originalWrite = adapter.write.bind(adapter);
    try {
      const lease = await acquireRewindLock(adapter, "run-renewal-failure", {
        leaseTtlMs: 90,
      });
      expect(lease).not.toBeNull();
      adapter.write = ((label: string, operation: () => PromiseLike<unknown>) => {
        if (label === "renew rewind lease run-renewal-failure") {
          return Promise.reject(new Error("simulated renewal write failure"));
        }
        return originalWrite(label, operation);
      }) as typeof adapter.write;

      await Bun.sleep(45);

      await expect(lease?.checkStillHeld()).rejects.toThrow(
        "Rewind lease renewal failed for run-renewal-failure: simulated renewal write failure",
      );
      await expect(lease?.renew()).rejects.toThrow("simulated renewal write failure");
      expect(await lease?.release()).toBe(true);
    } finally {
      adapter.write = originalWrite;
      sqlite.close();
    }
  });
});
