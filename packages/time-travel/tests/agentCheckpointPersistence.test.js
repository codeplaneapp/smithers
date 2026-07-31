import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import {
  AGENT_CHECKPOINT_SQLITE_BIND_BUDGET,
  deleteAgentCheckpointAttemptsByKeys,
  persistAgentCheckpointRows,
} from "../src/snapshot/agentCheckpointPersistence.js";

describe("agent checkpoint snapshot persistence", () => {
  test("chunks bulk attempts, content, references, exact replacement, and deletion below SQLite's bind budget", async () => {
    const sqlite = new Database(":memory:");
    const adapter = new SmithersDb(drizzle(sqlite));
    ensureSmithersTables(adapter.db);
    const runId = "checkpoint-bulk";
    await adapter.insertRun({
      runId,
      workflowName: "bulk",
      status: "finished",
      createdAtMs: 1,
      finishedAtMs: 2,
    });

    const observedParamCounts = [];
    const execute = adapter.internalStorage.execute.bind(adapter.internalStorage);
    const queryAll = adapter.internalStorage.queryAll.bind(adapter.internalStorage);
    adapter.internalStorage.execute = (sql, params = [], options) => {
      if (String(sql).includes("_smithers_attempts") || String(sql).includes("_smithers_agent_checkpoint")) {
        observedParamCounts.push(params.length);
      }
      return execute(sql, params, options);
    };
    adapter.internalStorage.queryAll = (sql, params = [], options) => {
      if (String(sql).includes("_smithers_agent_checkpoint")) observedParamCounts.push(params.length);
      return queryAll(sql, params, options);
    };

    const attempts = [];
    const checkpoints = [];
    for (let index = 0; index < 321; index += 1) {
      const checkpointJson = JSON.stringify({ codec: "test.bulk", version: 1, payload: { index } });
      const contentHash = createHash("sha256").update(checkpointJson).digest("hex");
      attempts.push({
        runId,
        nodeId: `node:${index}`,
        iteration: 0,
        attempt: 1,
        state: "finished",
        startedAtMs: 10,
        finishedAtMs: 20,
        heartbeatAtMs: null,
        heartbeatDataJson: null,
        errorJson: null,
        jjPointer: null,
        cached: false,
        metaJson: null,
        responseText: null,
        jjCwd: null,
      });
      checkpoints.push({
        runId,
        nodeId: `node:${index}`,
        iteration: 0,
        attempt: 1,
        sequence: 1,
        contentHash,
        codec: "test.bulk",
        version: 1,
        agentId: "bulk",
        purpose: "turn",
        createdAtMs: 15,
        checkpointJson,
        sizeBytes: Buffer.byteLength(checkpointJson, "utf8"),
        contentCreatedAtMs: 15,
      });
    }

    await adapter.withTransaction(
      "bulk checkpoint restore",
      Effect.promise(() =>
        persistAgentCheckpointRows(adapter, {
          runId,
          attempts,
          checkpoints,
          replaceCheckpointRefs: true,
        }),
      ),
    );
    expect((await adapter.listAttemptsForRun(runId)).length).toBe(321);
    expect((await adapter.listAgentCheckpointRefs(runId, { limit: 321 })).length).toBe(321);

    const sparseCheckpoints = [0, 2].map((sequence) => {
      const checkpointJson = JSON.stringify({ codec: "test.bulk", version: 1, payload: { sequence } });
      return {
        ...checkpoints[0],
        sequence,
        checkpointJson,
        contentHash: createHash("sha256").update(checkpointJson).digest("hex"),
        sizeBytes: Buffer.byteLength(checkpointJson, "utf8"),
      };
    });
    await adapter.withTransaction(
      "sparse checkpoint restore",
      Effect.promise(() =>
        persistAgentCheckpointRows(adapter, {
          runId,
          attempts: [attempts[0]],
          checkpoints: sparseCheckpoints,
          replaceCheckpointRefs: true,
        }),
      ),
    );
    expect(
      (await adapter.listAgentCheckpointRefs(runId, { nodeId: "node:0", iteration: 0, attempt: 1 })).map((row) =>
        Number(row.sequence),
      ),
    ).toEqual([0, 2]);
    expect(await adapter.getAgentCheckpoint(checkpoints[0].contentHash)).toBeNull();

    await adapter.withTransaction(
      "bulk checkpoint attempt deletion",
      Effect.promise(() =>
        deleteAgentCheckpointAttemptsByKeys(
          adapter,
          runId,
          attempts.map((row) => [row.nodeId, row.iteration, row.attempt]),
        ),
      ),
    );
    expect(await adapter.listAttemptsForRun(runId)).toEqual([]);
    expect(Math.max(...observedParamCounts)).toBeLessThanOrEqual(AGENT_CHECKPOINT_SQLITE_BIND_BUDGET);
    expect(observedParamCounts.filter((count) => count > 700).length).toBeGreaterThan(1);
    sqlite.close();
  });
});
