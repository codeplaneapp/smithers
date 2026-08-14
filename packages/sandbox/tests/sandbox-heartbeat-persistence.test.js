import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { makeTempDirPath } from "../../testing/src/cleanup/tempDir.ts";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { withTaskRuntime } from "@smthrs/driver/task-runtime";
import { executeSandbox } from "../src/execute.js";

const RUN_ID = "sandbox-heartbeat-persistence-run";
const SANDBOX_ID = "sandbox-heartbeat-persistence";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("sandbox heartbeat persistence", () => {
  test("persists a provider heartbeat while the sandbox is still active", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    const rootDir = makeTempDirPath("smithers-sandbox-heartbeat-");
    let shippedHeartbeatAtMs;
    let persistedHeartbeatAtMs;

    const provider = {
      id: "heartbeat-provider",
      run: async (request) => {
        shippedHeartbeatAtMs = (await adapter.getSandbox(RUN_ID, SANDBOX_ID))?.heartbeatAtMs;
        await sleep(10);
        request.heartbeat({ sandboxId: SANDBOX_ID, stage: "provider-progress", progress: 50 });

        for (let attempt = 0; attempt < 20; attempt += 1) {
          persistedHeartbeatAtMs = (await adapter.getSandbox(RUN_ID, SANDBOX_ID))?.heartbeatAtMs;
          if (typeof persistedHeartbeatAtMs === "number" && persistedHeartbeatAtMs > (shippedHeartbeatAtMs ?? 0)) {
            break;
          }
          await sleep(5);
        }

        return { status: "finished", output: { ok: true } };
      },
    };
    const runtime = {
      runId: RUN_ID,
      stepId: "sandbox-step",
      attempt: 1,
      iteration: 0,
      signal: new AbortController().signal,
      db,
      heartbeat: () => {},
      lastHeartbeat: null,
    };

    try {
      const output = await withTaskRuntime(runtime, () =>
        executeSandbox({
          sandboxId: SANDBOX_ID,
          provider,
          parentWorkflow: { build: () => null },
          workflow: { build: () => null },
          input: {},
          rootDir,
          allowNetwork: false,
          maxOutputBytes: 1024,
          toolTimeoutMs: 250,
          reviewDiffs: false,
        }),
      );

      expect(output).toEqual({ ok: true });
      expect(shippedHeartbeatAtMs).toEqual(expect.any(Number));
      expect(persistedHeartbeatAtMs).toBeGreaterThan(shippedHeartbeatAtMs);
      expect(await adapter.getSandbox(RUN_ID, SANDBOX_ID)).toMatchObject({
        status: "finished",
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      sqlite.close();
    }
  });
});
