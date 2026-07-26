import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
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
