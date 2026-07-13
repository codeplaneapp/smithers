import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createSmithers } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { integrationHarness, realDbAdapter, runScenario, scenario, step } from "@smithers-orchestrator/testing";

const paths: string[] = [];
const clients: Database[] = [];

describe("testing framework real-db admission", () => {
  afterEach(() => { for (const client of clients.splice(0)) client.close(); for (const path of paths.splice(0)) { rmSync(path, { force: true }); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true }); } });
  test("executes a live SmithersDb insert and heartbeat during admission", async () => {
    const dbPath = join(tmpdir(), `smithers-testing-framework-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); paths.push(dbPath);
    const { db } = createSmithers({ input: z.object({}), result: z.object({ value: z.number() }) }, { dbPath }); ensureSmithersTables(db);
    const client = ((db as { $client?: Database }).$client); if (!client) throw new Error("createSmithers did not expose its real sqlite client"); clients.push(client);
    const adapter = new SmithersDb(db);
    const insertRun = adapter.insertRun.bind(adapter);
    const heartbeatRun = adapter.heartbeatRun.bind(adapter);
    const productionResource = Object.assign(adapter, {
      path: dbPath,
      productionIdentity: "SmithersDb" as const,
      insertRun: (input: Record<string, unknown>) => insertRun({ runId: String(input.runId), workflowName: "testing-framework", status: "running", createdAtMs: Date.now(), startedAtMs: Date.now(), heartbeatAtMs: null, runtimeOwnerId: "testing-framework" }),
      heartbeatRun: (id: string) => heartbeatRun(id, "testing-framework", Date.now()),
      operations: { observed: () => "executed" },
      close: () => { client.close(); },
    });
    const harness = integrationHarness({ adapter: realDbAdapter({ open: async () => productionResource }) });
    const result = await runScenario(scenario("real-db", { steps: [step("observed", { run: async (_runtime, input) => input ?? "executed" })] }), { harness });
    expect(result.status).toBe("finished"); expect(result.outputs.observed).toBe("executed");
    const verify = new SmithersDb(new (await import("bun:sqlite")).Database(dbPath));
    try { const durableRows = await verify.listRuns(20, "running", "testing-framework"); expect(durableRows.some((row) => row.runId.startsWith("testing-admission-"))).toBe(true); } finally { verify.db.close(); }
  });

  test("framework adapter drives production resume CAS and heartbeat fencing", async () => {
    const dbPath = join(tmpdir(), `smithers-testing-framework-lease-${Date.now()}-${Math.random().toString(36).slice(2)}.db`); paths.push(dbPath);
    const { db } = createSmithers({ input: z.object({}), result: z.object({ value: z.number() }) }, { dbPath }); ensureSmithersTables(db);
    const client = ((db as { $client?: Database }).$client); if (!client) throw new Error("createSmithers did not expose its real sqlite client"); clients.push(client);
    const adapter = new SmithersDb(db); const runId = "testing-framework-lease"; const now = Date.now();
    await adapter.insertRun({ runId, workflowName: "testing-framework", status: "running", createdAtMs: now - 100_000, startedAtMs: now - 100_000, heartbeatAtMs: now - 100_000, runtimeOwnerId: "old-owner" });
    const resource = Object.assign(adapter, { path: dbPath, productionIdentity: "SmithersDb" as const, operations: {
      lease: async () => {
        const first = await adapter.claimRunForResume({ runId, expectedStatus: "running", expectedRuntimeOwnerId: "old-owner", expectedHeartbeatAtMs: now - 100_000, staleBeforeMs: now - 1_000, claimOwnerId: "new-owner", claimHeartbeatAtMs: now, requireStale: true });
        const second = await adapter.claimRunForResume({ runId, expectedStatus: "running", expectedRuntimeOwnerId: "old-owner", expectedHeartbeatAtMs: now - 100_000, staleBeforeMs: now - 1_000, claimOwnerId: "other-owner", claimHeartbeatAtMs: now + 1, requireStale: true });
        await adapter.heartbeatRun(runId, "old-owner", now + 2);
        return { first, second };
      },
    }, close: () => { client.close(); } });
    const result = await runScenario(scenario("real-db-lease", { steps: [step("lease", { run: () => "checked" })] }), { harness: integrationHarness({ adapter: realDbAdapter({ open: async () => resource }) }) });
    expect(result.status).toBe("finished");
    const verify = new SmithersDb(new (await import("bun:sqlite")).Database(dbPath));
    try { const row = await verify.getRun(runId); expect(row?.runtimeOwnerId).toBe("new-owner"); expect(row?.heartbeatAtMs).toBe(now); } finally { verify.db.close(); }
  });
});
