import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { supervisorPollEffect } from "../src/supervisor.js";

const now = Date.now();

function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    return { adapter, sqlite };
}

/**
 * @param {string} runId
 * @param {any} [extra]
 */
function runRow(runId, extra = {}) {
    return {
        runId,
        workflowName: "test-workflow",
        workflowPath: `/tmp/${runId}.tsx`,
        status: "running",
        createdAtMs: now - 120_000,
        startedAtMs: now - 120_000,
        // Stale: last heartbeat well beyond the 30s threshold.
        heartbeatAtMs: now - 60_000,
        runtimeOwnerId: "pid:99999:owner",
        ...extra,
    };
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function skipReason(adapter, runId) {
    const events = await adapter.listEvents(runId, -1, 50);
    const skip = events.find((event) => event.type === "RunAutoResumeSkipped");
    return skip ? JSON.parse(skip.payloadJson).reason : null;
}

// These tests exercise the real supervisor poll + real SmithersDb (no mocks of
// the code under test). They pin the false-orphan-under-load fix: a stale
// heartbeat alone must never trigger a resume — the owner must be verifiably
// dead. `isPidAlive` is left as the real implementation so process.pid is
// genuinely alive and a made-up pid is genuinely dead.
describe("supervisor owner-liveness resume gate", () => {
    test("does NOT resume a stale run whose owner pid is still alive (busy engine, lagging heartbeat)", async () => {
        const { adapter, sqlite } = createTestDb();
        await adapter.insertRun(runRow("run-live-owner", {
            // process.pid is this test process — genuinely alive.
            runtimeOwnerId: `pid:${process.pid}:live-driver`,
        }));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                // real isPidAlive on purpose
                spawnResumeDetached: () => {
                    throw new Error("must NOT resume a run whose owner is alive");
                },
            },
        }));
        expect(summary.staleCount).toBe(1);
        expect(summary.resumedCount).toBe(0);
        expect(summary.skippedCount).toBe(1);
        expect(await skipReason(adapter, "run-live-owner")).toBe("pid-alive");
        sqlite.close();
    });

    test("DOES resume a stale run whose owner pid is verifiably dead", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-dead-owner", {
            // pid 11111 is (essentially certainly) not a live process.
            runtimeOwnerId: "pid:11111:dead-driver",
        }));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 4242;
                },
            },
        }));
        expect(summary.staleCount).toBe(1);
        expect(summary.resumedCount).toBe(1);
        expect(resumed).toEqual(["run-dead-owner"]);
        sqlite.close();
    });

    test("DOES resume a genuinely orphaned stale run with no recorded owner", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-orphan", { runtimeOwnerId: null }));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 7777;
                },
            },
        }));
        expect(summary.staleCount).toBe(1);
        expect(summary.resumedCount).toBe(1);
        expect(resumed).toEqual(["run-orphan"]);
        sqlite.close();
    });

    test("does NOT resume a stale run whose owner is recorded but its pid cannot be locally verified (unproven)", async () => {
        const { adapter, sqlite } = createTestDb();
        await adapter.insertRun(runRow("run-unproven-owner", {
            // A recorded owner with no parseable local pid: we cannot prove the
            // driver is dead, so resuming risks a second engine racing a live one.
            runtimeOwnerId: "host-abc123:session-xyz",
        }));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                spawnResumeDetached: () => {
                    throw new Error("must NOT resume a run whose owner cannot be verified dead");
                },
            },
        }));
        expect(summary.staleCount).toBe(1);
        expect(summary.resumedCount).toBe(0);
        expect(summary.skippedCount).toBe(1);
        expect(await skipReason(adapter, "run-unproven-owner")).toBe("owner-unverified");
        sqlite.close();
    });
});
