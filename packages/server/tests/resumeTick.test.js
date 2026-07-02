import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { runResumeTick, runServerlessTick } from "../src/resumeTick.js";

/**
 * Opens a fresh in-memory `SmithersDb` (schema-migrated), matching the
 * pattern used elsewhere in this repo's test suite (see
 * `packages/server/tests/cronTick.test.js`'s `openAdapter` and
 * `apps/cli/tests/supervisor-core.test.js`'s `createTestDb`).
 */
function openAdapter() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { adapter: new SmithersDb(db), sqlite };
}

const now = Date.parse("2026-07-01T12:00:00.000Z");

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
        heartbeatAtMs: now - 60_000,
        runtimeOwnerId: "pid:99999:owner",
        ...extra,
    };
}

/**
 * Seed a waiting-event run whose approval gate was decided while the run was
 * detached, mirroring `apps/cli/tests/supervisor-core.test.js`'s
 * `insertApprovalDecidedRun`.
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {{ heartbeatAtMs?: number | null }} [opts]
 */
async function insertApprovalDecidedRun(adapter, runId, opts = {}) {
    await adapter.insertRun(runRow(runId, {
        status: "waiting-event",
        heartbeatAtMs: opts.heartbeatAtMs ?? now - 60_000,
    }));
    await adapter.insertNode({
        runId,
        nodeId: "review",
        iteration: 0,
        state: "pending",
        lastAttempt: 1,
        updatedAtMs: now - 2_000,
        outputTable: "",
        label: "approval:review",
    });
    await adapter.insertOrUpdateApproval({
        runId,
        nodeId: "review",
        iteration: 0,
        status: "approved",
        requestedAtMs: now - 2_000,
        decidedAtMs: now - 1_000,
        note: null,
        decidedBy: "user:test",
    });
}

describe("runResumeTick", () => {
    test("resumes a stale running run", async () => {
        const { adapter, sqlite } = openAdapter();
        try {
            await adapter.insertRun(runRow("run-stale"));
            const resumeCalls = [];
            const result = await runResumeTick(adapter, {
                now,
                staleThresholdMs: 30_000,
                workerId: "test-worker",
                resumeRun: async (job) => {
                    resumeCalls.push(job.runId);
                },
            });

            expect(resumeCalls).toEqual(["run-stale"]);
            expect(result.resumedCount).toBe(1);
            expect(result.resumed[0]).toEqual({ runId: "run-stale", kind: "stale-running" });
            expect(result.errors).toHaveLength(0);
        }
        finally {
            sqlite.close();
        }
    });

    test("resumes an approval-decided suspended run", async () => {
        const { adapter, sqlite } = openAdapter();
        try {
            await insertApprovalDecidedRun(adapter, "run-approved");
            const resumeCalls = [];
            const result = await runResumeTick(adapter, {
                now,
                staleThresholdMs: 30_000,
                workerId: "test-worker",
                resumeRun: async (job) => {
                    resumeCalls.push(job.runId);
                },
            });

            expect(resumeCalls).toEqual(["run-approved"]);
            expect(result.resumedCount).toBe(1);
            expect(result.resumed[0]).toEqual({ runId: "run-approved", kind: "approval-decided-resume-required" });
        }
        finally {
            sqlite.close();
        }
    });

    test("no-op when nothing is due: no resume calls, no claim side effects", async () => {
        const { adapter, sqlite } = openAdapter();
        try {
            // Fresh heartbeat: not stale yet.
            await adapter.insertRun(runRow("run-fresh", { heartbeatAtMs: now - 1_000 }));
            const resumeCalls = [];
            const result = await runResumeTick(adapter, {
                now,
                staleThresholdMs: 30_000,
                resumeRun: async (job) => {
                    resumeCalls.push(job.runId);
                },
            });

            expect(resumeCalls).toEqual([]);
            expect(result.resumedCount).toBe(0);
            expect(result.errors).toHaveLength(0);

            const [row] = await adapter.listRuns(10, "running");
            expect(row.runtimeOwnerId).toBe("pid:99999:owner");
            expect(row.heartbeatAtMs).toBe(now - 1_000);
        }
        finally {
            sqlite.close();
        }
    });

    test("lease contention: two concurrent resume ticks only resume once", async () => {
        const { adapter, sqlite } = openAdapter();
        try {
            await adapter.insertRun(runRow("run-contended"));
            const resumeCallsA = [];
            const resumeCallsB = [];
            const [resultA, resultB] = await Promise.all([
                runResumeTick(adapter, {
                    now,
                    staleThresholdMs: 30_000,
                    workerId: "worker-a",
                    resumeRun: async (job) => {
                        resumeCallsA.push(job.runId);
                    },
                }),
                runResumeTick(adapter, {
                    now,
                    staleThresholdMs: 30_000,
                    workerId: "worker-b",
                    resumeRun: async (job) => {
                        resumeCallsB.push(job.runId);
                    },
                }),
            ]);

            const totalResumed = resultA.resumedCount + resultB.resumedCount;
            expect(totalResumed).toBe(1);
            expect(resumeCallsA.length + resumeCallsB.length).toBe(1);
        }
        finally {
            sqlite.close();
        }
    });

    test("lease expires after the staleness timeout, allowing reclaim", async () => {
        const { adapter, sqlite } = openAdapter();
        try {
            await adapter.insertRun(runRow("run-lease-expired"));
            // First tick claims the run but its resumeRun never resolves cleanly
            // (simulate a crash mid-resume by not releasing the claim): the claim
            // sticks around with the resume-tick's claimOwnerId/heartbeat.
            await adapter.claimRunForResume({
                runId: "run-lease-expired",
                expectedStatus: "running",
                expectedRuntimeOwnerId: "pid:99999:owner",
                expectedHeartbeatAtMs: now - 60_000,
                staleBeforeMs: now - 30_000,
                claimOwnerId: "resume-tick:crashed-worker",
                claimHeartbeatAtMs: now - 60_000, // claimed a while ago, itself now stale
                requireStale: true,
            });

            const resumeCalls = [];
            const result = await runResumeTick(adapter, {
                now,
                staleThresholdMs: 30_000,
                workerId: "worker-recover",
                resumeRun: async (job) => {
                    resumeCalls.push(job.runId);
                },
            });

            expect(resumeCalls).toEqual(["run-lease-expired"]);
            expect(result.resumedCount).toBe(1);
        }
        finally {
            sqlite.close();
        }
    });
});

describe("runServerlessTick", () => {
    test("runs the cron tick and the resume tick together", async () => {
        const { adapter, sqlite } = openAdapter();
        try {
            await adapter.insertRun(runRow("run-stale-for-serverless-tick"));
            const resumeCalls = [];
            const result = await runServerlessTick(adapter, {
                now,
                staleThresholdMs: 30_000,
                workerId: "serverless-tick-worker",
                startWorkflowRun: async () => {},
                resumeRun: async (job) => {
                    resumeCalls.push(job.runId);
                },
            });

            expect(result.cron.claimedCount).toBe(0);
            expect(resumeCalls).toEqual(["run-stale-for-serverless-tick"]);
            expect(result.resume.resumedCount).toBe(1);
        }
        finally {
            sqlite.close();
        }
    });
});
