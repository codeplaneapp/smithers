import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";
import { sha256Hex } from "../src/sha256Hex.js";

function setup() {
  const sqlite = new Database(":memory:");
  ensureSmithersTables(drizzle(sqlite));
  return { sqlite, adapter: new SmithersDb(drizzle(sqlite)) };
}

async function insertAttempt(adapter, overrides = {}) {
  await adapter.insertRun({
    runId: overrides.runId ?? "run-1",
    workflowName: "test",
    status: "running",
    createdAtMs: 1,
    runtimeOwnerId: "owner-1",
  });
  await adapter.insertAttempt({
    runId: "run-1",
    nodeId: "agent",
    iteration: 0,
    attempt: 1,
    state: "in-progress",
    startedAtMs: 1,
    ...overrides,
  });
}

function checkpoint(overrides = {}) {
  return {
    runId: "run-1",
    nodeId: "agent",
    iteration: 0,
    attempt: 1,
    sequence: 0,
    checkpointJson: '{"cursor":1}',
    codec: "json",
    version: 1,
    agentId: "agent:test",
    purpose: "resume",
    createdAtMs: 2,
    runtimeOwnerId: "owner-1",
    ...overrides,
  };
}

describe("agent checkpoint persistence", () => {
  test("deduplicates immutable content and reads refs by run or scope", async () => {
    const { sqlite, adapter } = setup();
    try {
      await insertAttempt(adapter);
      const first = await adapter.putAgentCheckpoint(checkpoint());
      const second = await adapter.putAgentCheckpoint(checkpoint({ sequence: 1, createdAtMs: 3 }));
      expect(first.contentHash).toBe(second.contentHash);
      expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_agent_checkpoint_contents").get().count).toBe(1);
      expect(await adapter.getAgentCheckpoint(first.contentHash)).toMatchObject({
        contentHash: first.contentHash,
        checkpointJson: '{"cursor":1}',
        sizeBytes: 12,
      });
      expect(await adapter.listAgentCheckpointRefs("run-1")).toHaveLength(2);
      expect(await adapter.listAgentCheckpointRefs("run-1", { nodeId: "missing" })).toEqual([]);
      expect(
        await adapter.listAgentCheckpointRefs("run-1", { nodeId: "agent", attempt: 1, purpose: "resume" }),
      ).toHaveLength(2);
      expect(await adapter.listLatestAgentCheckpointRefs("run-1", "agent", 0)).toMatchObject([
        { attempt: 1, sequence: 1 },
      ]);
      expect(await adapter.listLatestAgentCheckpointRefs("run-1", "agent", 0, { limit: 2 })).toMatchObject([
        { attempt: 1, sequence: 1 },
        { attempt: 1, sequence: 0 },
      ]);
      expect(
        await adapter.listLatestAgentCheckpointRefs("run-1", "agent", 0, {
          limit: 1,
          before: { attempt: 1, sequence: 1 },
        }),
      ).toMatchObject([{ attempt: 1, sequence: 0 }]);
      expect(await adapter.getNextAgentCheckpointSequence("run-1", "agent", 0, 1)).toBe(2);
      expect(await adapter.getNextAgentCheckpointSequence("run-1", "agent", 0, 2)).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  test("full-history reference reads are bounded and composite-cursor paginated", async () => {
    const { sqlite, adapter } = setup();
    try {
      await insertAttempt(adapter);
      for (let sequence = 0; sequence < 101; sequence += 1) {
        await adapter.putAgentCheckpoint(checkpoint({ sequence, checkpointJson: `{"sequence":${sequence}}` }));
      }
      const first = await adapter.listAgentCheckpointRefs("run-1");
      expect(first).toHaveLength(100);
      expect(first.at(-1)).toMatchObject({ nodeId: "agent", iteration: 0, attempt: 1, sequence: 99 });
      expect(
        await adapter.listAgentCheckpointRefs("run-1", {
          limit: 100,
          after: { nodeId: "agent", iteration: 0, attempt: 1, sequence: 99 },
        }),
      ).toMatchObject([{ sequence: 100 }]);
      for (const limit of [0, 1001, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
        await expect(Effect.runPromise(adapter.listAgentCheckpointRefs("run-1", { limit }))).rejects.toThrow(
          /between 1 and 1000/,
        );
      }
      await expect(
        Effect.runPromise(
          adapter.listAgentCheckpointRefs("run-1", {
            after: { nodeId: "agent", iteration: -1, attempt: 1, sequence: 0 },
          }),
        ),
      ).rejects.toThrow(/after cursor is invalid/);
    } finally {
      sqlite.close();
    }
  });

  test("allocates append sequences atomically and preserves explicit idempotent refs", async () => {
    const { sqlite, adapter } = setup();
    try {
      await insertAttempt(adapter);
      const rows = await Promise.all([
        adapter.putAgentCheckpoint(checkpoint({ sequence: undefined, checkpointJson: '{"producer":1}' })),
        adapter.putAgentCheckpoint(checkpoint({ sequence: undefined, checkpointJson: '{"producer":2}' })),
      ]);
      expect(rows.map((row) => row.sequence).sort()).toEqual([0, 1]);
      expect(await adapter.listAgentCheckpointRefs("run-1")).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });

  test("latest reference lookup can jump below a reset attempt without scanning its sequences", async () => {
    const { sqlite, adapter } = setup();
    try {
      await insertAttempt(adapter);
      await adapter.putAgentCheckpoint(checkpoint());
      await insertAttempt(adapter, { attempt: 2, startedAtMs: 2 });
      await adapter.putAgentCheckpoint(checkpoint({ attempt: 2, checkpointJson: '{"cursor":2}', createdAtMs: 3 }));
      await adapter.putAgentCheckpoint(
        checkpoint({ attempt: 2, sequence: 1, checkpointJson: '{"cursor":3}', createdAtMs: 4 }),
      );
      expect(await adapter.listLatestAgentCheckpointRefs("run-1", "agent", 0)).toMatchObject([
        { attempt: 2, sequence: 1 },
      ]);
      expect(
        await adapter.listLatestAgentCheckpointRefs("run-1", "agent", 0, { beforeAttemptExclusive: 2 }),
      ).toMatchObject([{ attempt: 1, sequence: 0 }]);
      for (const limit of [0, 1001, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(
          Effect.runPromise(adapter.listLatestAgentCheckpointRefs("run-1", "agent", 0, { limit })),
        ).rejects.toThrow(/between 1 and 1000/);
      }
    } finally {
      sqlite.close();
    }
  });

  test("rejects a hash collision or corrupt content row without creating a ref", async () => {
    const { sqlite, adapter } = setup();
    try {
      await insertAttempt(adapter);
      const checkpointJson = '{"cursor":1}';
      sqlite
        .query(
          "INSERT INTO _smithers_agent_checkpoint_contents (content_hash, checkpoint_json, size_bytes, created_at_ms) VALUES (?, ?, ?, ?)",
        )
        .run(sha256Hex(checkpointJson), '{"corrupt":true}', 16, 1);
      const error = await Effect.runPromise(Effect.flip(adapter.putAgentCheckpoint(checkpoint({ checkpointJson }))));
      expect(error).toMatchObject({
        code: "AGENT_CHECKPOINT_CORRUPT",
        summary: expect.stringMatching(/collision or corruption/),
        details: { contentHash: sha256Hex(checkpointJson), failureRetryable: false },
      });
      expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_agent_checkpoints").get().count).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  test("rejects malformed or unsafe persisted checkpoint numbers", async () => {
    const { sqlite, adapter } = setup();
    try {
      await insertAttempt(adapter);
      const stored = await adapter.putAgentCheckpoint(checkpoint());
      sqlite.run("UPDATE _smithers_agent_checkpoint_contents SET size_bytes = 'malformed'");
      const contentError = await Effect.runPromise(Effect.flip(adapter.getAgentCheckpoint(stored.contentHash)));
      expect(contentError).toMatchObject({
        code: "DB_QUERY_FAILED",
        summary: expect.stringMatching(
          /Invalid persisted agent checkpoint sizeBytes: expected a nonnegative safe integer/,
        ),
      });

      sqlite.run("UPDATE _smithers_agent_checkpoints SET version = 9007199254740992");
      await expect(Effect.runPromise(adapter.listAgentCheckpointRefs("run-1"))).rejects.toThrow(
        /Invalid persisted agent checkpoint version: expected a safe integer >= 1/,
      );

      sqlite.run("UPDATE _smithers_agent_checkpoints SET version = 1, sequence = 9007199254740992");
      await expect(Effect.runPromise(adapter.getNextAgentCheckpointSequence("run-1", "agent", 0, 1))).rejects.toThrow(
        /Invalid persisted agent checkpoint nextSequence: expected a nonnegative safe integer/,
      );
    } finally {
      sqlite.close();
    }
  });

  test("attempt deletion removes refs with foreign-key enforcement disabled", async () => {
    const { sqlite, adapter } = setup();
    try {
      await insertAttempt(adapter);
      const stored = await adapter.putAgentCheckpoint(checkpoint());
      sqlite.run("PRAGMA foreign_keys = OFF");
      expect(sqlite.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
      sqlite.run(
        "DELETE FROM _smithers_attempts WHERE run_id = 'run-1' AND node_id = 'agent' AND iteration = 0 AND attempt = 1",
      );
      expect(await adapter.listAgentCheckpointRefs("run-1")).toEqual([]);
      expect(await adapter.getAgentCheckpoint(stored.contentHash)).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  test("reset cleanup is owner-fenced, marker-fenced, exact, and content-safe", async () => {
    const { sqlite, adapter } = setup();
    try {
      await insertAttempt(adapter);
      const first = await adapter.putAgentCheckpoint(checkpoint());
      await insertAttempt(adapter, { attempt: 2, startedAtMs: 2 });
      await adapter.putAgentCheckpoint(checkpoint({ attempt: 2, createdAtMs: 3 }));

      await adapter.updateAttempt("run-1", "agent", 0, 1, { state: "cancelled" });
      expect(await adapter.deleteResetAgentCheckpoints("run-1", "agent", 0, 1, "owner-1")).toBe(false);
      await adapter.updateAttempt("run-1", "agent", 0, 1, {
        metaJson: JSON.stringify({ preserved: true, resetCancelled: true }),
      });
      expect(await adapter.deleteResetAgentCheckpoints("run-1", "agent", 0, 1, "stale-owner")).toBe(false);
      expect(await adapter.listAgentCheckpointRefs("run-1", { attempt: 1 })).toHaveLength(1);

      expect(await adapter.deleteResetAgentCheckpoints("run-1", "agent", 0, 1, "owner-1")).toBe(true);
      expect(await adapter.listAgentCheckpointRefs("run-1", { attempt: 1 })).toEqual([]);
      expect(await adapter.listAgentCheckpointRefs("run-1", { attempt: 2 })).toHaveLength(1);
      expect(await adapter.getAgentCheckpoint(first.contentHash)).not.toBeNull();
      expect(await adapter.deleteResetAgentCheckpoints("run-1", "agent", 0, 1, "owner-1")).toBe(true);

      await adapter.updateAttempt("run-1", "agent", 0, 2, {
        state: "cancelled",
        metaJson: JSON.stringify({ resetCancelled: true }),
      });
      expect(await adapter.deleteResetAgentCheckpoints("run-1", "agent", 0, 2, "owner-1")).toBe(true);
      expect(await adapter.getAgentCheckpoint(first.contentHash)).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  test("retries a typed SQLite busy failure during reset checkpoint cleanup", async () => {
    const { sqlite, adapter } = setup();
    const deleteWhere = adapter.internalStorage.deleteWhere.bind(adapter.internalStorage);
    let busyFailures = 0;
    adapter.internalStorage.deleteWhere = async (table, where, params) => {
      if (table === "_smithers_agent_checkpoints" && busyFailures === 0) {
        busyFailures += 1;
        throw Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
      }
      return deleteWhere(table, where, params);
    };
    try {
      await insertAttempt(adapter);
      await adapter.putAgentCheckpoint(checkpoint());
      await adapter.updateAttempt("run-1", "agent", 0, 1, {
        state: "cancelled",
        metaJson: JSON.stringify({ resetCancelled: true }),
      });
      expect(await adapter.deleteResetAgentCheckpoints("run-1", "agent", 0, 1, "owner-1")).toBe(true);
      expect(busyFailures).toBe(1);
      expect(await adapter.listAgentCheckpointRefs("run-1")).toEqual([]);
    } finally {
      adapter.internalStorage.deleteWhere = deleteWhere;
      sqlite.close();
    }
  });

  test("reset cleanup and orphan GC remain reentrant inside an existing transaction", async () => {
    const { sqlite, adapter } = setup();
    try {
      await insertAttempt(adapter);
      await adapter.putAgentCheckpoint(checkpoint());
      await adapter.updateAttempt("run-1", "agent", 0, 1, {
        state: "cancelled",
        metaJson: JSON.stringify({ resetCancelled: true }),
      });
      const result = await adapter.withTransaction(
        "nested agent checkpoint cleanup",
        Effect.gen(function* () {
          const reset = yield* adapter.deleteResetAgentCheckpoints("run-1", "agent", 0, 1, "owner-1");
          const gc = yield* adapter.pruneOrphanedAgentCheckpointContents();
          return { reset, gc };
        }),
      );
      expect(result).toEqual({ reset: true, gc: { deletedCount: 0, nextCursor: null } });
      expect(await adapter.listAgentCheckpointRefs("run-1")).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  test("same reference is idempotent but cannot be rebound to different content", async () => {
    const { sqlite, adapter } = setup();
    try {
      await insertAttempt(adapter);
      await adapter.putAgentCheckpoint(checkpoint());
      await adapter.putAgentCheckpoint(checkpoint());
      const error = await Effect.runPromise(
        Effect.flip(adapter.putAgentCheckpoint(checkpoint({ checkpointJson: '{"cursor":2}' }))),
      );
      expect(error).toMatchObject({
        code: "AGENT_CHECKPOINT_CORRUPT",
        summary: expect.stringMatching(/reference conflict/),
        details: { failureRetryable: false },
      });
      expect(await adapter.listAgentCheckpointRefs("run-1")).toHaveLength(1);
      expect(await adapter.pruneOrphanedAgentCheckpointContents()).toEqual({ deletedCount: 0, nextCursor: null });
      expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_agent_checkpoint_contents").get().count).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  test("retries a typed SQLite busy failure while publishing checkpoint content", async () => {
    const { sqlite, adapter } = setup();
    const insertIgnore = adapter.internalStorage.insertIgnore.bind(adapter.internalStorage);
    let busyFailures = 0;
    adapter.internalStorage.insertIgnore = async (table, row) => {
      if (table === "_smithers_agent_checkpoint_contents" && busyFailures === 0) {
        busyFailures += 1;
        throw Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
      }
      return insertIgnore(table, row);
    };
    try {
      await insertAttempt(adapter);
      expect(await adapter.putAgentCheckpoint(checkpoint())).toMatchObject({ sequence: 0 });
      expect(busyFailures).toBe(1);
      expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_agent_checkpoint_contents").get()).toEqual({
        count: 1,
      });
    } finally {
      adapter.internalStorage.insertIgnore = insertIgnore;
      sqlite.close();
    }
  });

  test("orphan GC is bounded, resumable, and reports deletion counts", async () => {
    const { sqlite, adapter } = setup();
    try {
      for (const hash of ["a", "b", "c"]) {
        sqlite.query("INSERT INTO _smithers_agent_checkpoint_contents VALUES (?, '{}', 2, 1)").run(hash);
      }
      const first = await adapter.pruneOrphanedAgentCheckpointContents({ limit: 2 });
      expect(first).toEqual({ deletedCount: 2, nextCursor: "b" });
      expect(
        await adapter.pruneOrphanedAgentCheckpointContents({ limit: 2, afterContentHash: first.nextCursor }),
      ).toEqual({
        deletedCount: 1,
        nextCursor: null,
      });
    } finally {
      sqlite.close();
    }
  });

  test("retries a typed SQLite busy failure during orphan checkpoint GC", async () => {
    const { sqlite, adapter } = setup();
    const queryAll = adapter.internalStorage.queryAll.bind(adapter.internalStorage);
    let busyFailures = 0;
    adapter.internalStorage.queryAll = async (sql, params, options) => {
      if (sql.includes("SELECT content_hash FROM _smithers_agent_checkpoint_contents") && busyFailures === 0) {
        busyFailures += 1;
        throw Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
      }
      return queryAll(sql, params, options);
    };
    try {
      sqlite
        .query(
          "INSERT INTO _smithers_agent_checkpoint_contents (content_hash, checkpoint_json, size_bytes, created_at_ms) VALUES ('orphan', '{}', 2, 1)",
        )
        .run();
      expect(await adapter.pruneOrphanedAgentCheckpointContents()).toEqual({ deletedCount: 1, nextCursor: null });
      expect(busyFailures).toBe(1);
    } finally {
      adapter.internalStorage.queryAll = queryAll;
      sqlite.close();
    }
  });

  test("ownership and attempt fences reject stale checkpoint writes without orphaning content", async () => {
    const { sqlite, adapter } = setup();
    try {
      await insertAttempt(adapter);
      expect(await adapter.putAgentCheckpoint(checkpoint({ runtimeOwnerId: "stale-owner" }))).toBeNull();
      await adapter.updateRun("run-1", { runtimeOwnerId: "owner-2" });
      expect(await adapter.putAgentCheckpoint(checkpoint({ runtimeOwnerId: "owner-1" }))).toBeNull();
      const accepted = await adapter.putAgentCheckpoint(checkpoint({ runtimeOwnerId: "owner-2" }));
      expect(accepted).not.toBeNull();
      await adapter.updateAttempt("run-1", "agent", 0, 1, { state: "failed" });
      expect(
        await adapter.putAgentCheckpoint(
          checkpoint({ sequence: 1, checkpointJson: '{"cursor":2}', runtimeOwnerId: "owner-2" }),
        ),
      ).toBeNull();
      expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_agent_checkpoint_contents").get().count).toBe(1);
      expect(sqlite.query("SELECT COUNT(*) AS count FROM _smithers_agent_checkpoints").get().count).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});
