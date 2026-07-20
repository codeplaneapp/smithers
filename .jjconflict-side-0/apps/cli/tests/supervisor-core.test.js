import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { runsDueForQuotaResume } from "../../../packages/engine/src/engine.js";
import { cascadeCancelRun } from "../src/cancel-cascade.js";
import { SUPERVISOR_EVENT_RUN_ID, supervisorLoopEffect, supervisorPollEffect, } from "../src/supervisor.js";
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
        heartbeatAtMs: now - 60_000,
        runtimeOwnerId: "pid:99999:owner",
        ...extra,
    };
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function listEventTypes(adapter, runId) {
    const events = await adapter.listEvents(runId, -1, 500);
    return events.map((event) => event.type);
}
/**
 * Seed a waiting-event run whose approval gate was decided while the run was
 * detached: the gate node is already "pending" in the DB (the engine moved it
 * there on approval), but no engine is alive to execute it. The runtime owner
 * is a dead pid and the heartbeat is stale.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {{ approvalStatus?: "approved" | "denied" | "requested"; heartbeatAtMs?: number | null }} [opts]
 */
async function insertApprovalDecidedRun(adapter, runId, opts = {}) {
    const approvalStatus = opts.approvalStatus ?? "approved";
    const decided = approvalStatus === "approved" || approvalStatus === "denied";
    await adapter.insertRun(runRow(runId, {
        status: "waiting-event",
        heartbeatAtMs: opts.heartbeatAtMs ?? now - 60_000,
        runtimeOwnerId: "pid:99999:owner",
    }));
    await adapter.insertNode({
        runId,
        nodeId: "review",
        iteration: 0,
        // The gate node is "pending" after the decision was recorded; this is
        // what listDecidedApprovals joins against (n.state = 'pending').
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
        status: approvalStatus,
        requestedAtMs: now - 2_000,
        decidedAtMs: decided ? now - 1_000 : null,
        note: null,
        decidedBy: decided ? "user:test" : null,
    });
}
describe("supervisor poll core", () => {
    test("auto-resumes stale runs", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-stale"));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            maxConcurrent: 3,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 4242;
                },
            },
        }));
        expect(summary).toEqual({
            staleCount: 1,
            resumedCount: 1,
            skippedCount: 0,
            durationMs: 0,
            wouldResumeRunIds: [],
        });
        expect(resumed).toEqual(["run-stale"]);
        expect(await listEventTypes(adapter, "run-stale")).toContain("RunAutoResumed");
        sqlite.close();
    });
    test("does not resume healthy runs", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-fresh", {
            heartbeatAtMs: now - 1_000,
        }));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 111;
                },
            },
        }));
        expect(summary.staleCount).toBe(0);
        expect(summary.resumedCount).toBe(0);
        expect(resumed.length).toBe(0);
        sqlite.close();
    });
    test("resumes only due, in-scope quota parks whose owner is not alive", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-quota-due", {
            status: "waiting-quota",
            heartbeatAtMs: now - 1_000,
            runtimeOwnerId: null,
            errorJson: JSON.stringify({ resetAtMs: now - 1 }),
        }));
        await adapter.insertRun(runRow("run-quota-future", {
            status: "waiting-quota",
            runtimeOwnerId: null,
            errorJson: JSON.stringify({ resetAtMs: now + 60_000 }),
        }));
        await adapter.insertRun(runRow("run-quota-other-scope", {
            status: "waiting-quota",
            runtimeOwnerId: null,
            errorJson: JSON.stringify({ resetAtMs: now - 1 }),
        }));
        await adapter.insertRun(runRow("run-quota-owner-alive", {
            status: "waiting-quota",
            runtimeOwnerId: `pid:${process.pid}:owner`,
            errorJson: JSON.stringify({ resetAtMs: now - 1 }),
        }));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            runIds: ["run-quota-due", "run-quota-future", "run-quota-owner-alive"],
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: (pid) => pid === process.pid,
                runsDueForQuotaResume,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 7777;
                },
            },
        }));
        expect(summary.resumedCount).toBe(1);
        expect(resumed).toEqual(["run-quota-due"]);
        expect((await adapter.getRun("run-quota-future"))?.runtimeOwnerId).toBeNull();
        expect((await adapter.getRun("run-quota-other-scope"))?.runtimeOwnerId).toBeNull();
        expect(await listEventTypes(adapter, "run-quota-owner-alive")).toContain("RunAutoResumeSkipped");
        sqlite.close();
    });
    test("never wakes a due quota park after cancellation wins", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-quota-cancelled", {
            status: "waiting-quota",
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            errorJson: JSON.stringify({ resetAtMs: now - 1 }),
        }));
        await cascadeCancelRun(adapter, "run-quota-cancelled");

        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            runIds: ["run-quota-cancelled"],
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                runsDueForQuotaResume,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 7777;
                },
            },
        }));

        expect((await adapter.getRun("run-quota-cancelled"))?.status).toBe("cancelled");
        expect(summary.resumedCount).toBe(0);
        expect(resumed).toEqual([]);
        sqlite.close();
    });
    test("scoped supervisor exits after every bound run becomes terminal", async () => {
        const { adapter, sqlite } = createTestDb();
        await adapter.insertRun(runRow("run-scoped-loop", {
            heartbeatAtMs: now - 1_000,
            runtimeOwnerId: null,
        }));
        const loop = Effect.runPromise(supervisorLoopEffect({
            adapter,
            runIds: ["run-scoped-loop"],
            pollIntervalMs: 10,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: () => {
                    throw new Error("fresh run must not resume");
                },
            },
        }));
        await new Promise((resolve) => setTimeout(resolve, 25));
        await adapter.updateRun("run-scoped-loop", {
            status: "finished",
            finishedAtMs: now,
        });
        let timeout;
        const result = await Promise.race([
            loop.then(() => "exited"),
            new Promise((resolve) => {
                timeout = setTimeout(() => resolve("timed-out"), 10_000);
            }),
        ]);
        clearTimeout(timeout);
        expect(result).toBe("exited");
        sqlite.close();
    });
    test("resumes waiting-timer runs when timer is due", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-timer-due", {
            status: "waiting-timer",
            heartbeatAtMs: null,
            runtimeOwnerId: null,
        }));
        await adapter.insertNode({
            runId: "run-timer-due",
            nodeId: "cooldown",
            iteration: 0,
            state: "waiting-timer",
            lastAttempt: 1,
            updatedAtMs: now - 1_000,
            outputTable: "",
            label: "timer:cooldown",
        });
        await adapter.insertAttempt({
            runId: "run-timer-due",
            nodeId: "cooldown",
            iteration: 0,
            attempt: 1,
            state: "waiting-timer",
            startedAtMs: now - 1_000,
            finishedAtMs: null,
            errorJson: null,
            jjPointer: null,
            jjCwd: null,
            cached: false,
            metaJson: JSON.stringify({
                kind: "timer",
                timer: {
                    timerId: "cooldown",
                    timerType: "duration",
                    createdAtMs: now - 1_000,
                    firesAtMs: now - 10,
                    firedAtMs: null,
                },
            }),
            responseText: null,
        });
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 999;
                },
            },
        }));
        expect(summary.staleCount).toBe(0);
        expect(summary.resumedCount).toBe(1);
        expect(summary.skippedCount).toBe(0);
        expect(resumed).toEqual(["run-timer-due"]);
        sqlite.close();
    });
    test("skips stale run when runtime owner pid is alive", async () => {
        const { adapter, sqlite } = createTestDb();
        await adapter.insertRun(runRow("run-alive", {
            runtimeOwnerId: `pid:${process.pid}:same-process`,
        }));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => true,
                spawnResumeDetached: () => {
                    throw new Error("should not be called");
                },
            },
        }));
        expect(summary.staleCount).toBe(1);
        expect(summary.resumedCount).toBe(0);
        expect(summary.skippedCount).toBe(1);
        expect(summary.wouldResumeRunIds).toEqual([]);
        const events = await adapter.listEvents("run-alive", -1, 20);
        const skip = events.find((event) => event.type === "RunAutoResumeSkipped");
        expect(skip).toBeDefined();
        const payload = JSON.parse(skip.payloadJson);
        expect(payload.reason).toBe("pid-alive");
        sqlite.close();
    });
    test("scoped supervision only considers the named run", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-x"));
        await adapter.insertRun(runRow("run-y"));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            runIds: ["run-x"],
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 456;
                },
            },
        }));
        expect(summary.staleCount).toBe(1);
        expect(resumed).toEqual(["run-x"]);
        expect((await adapter.getRun("run-y")).runtimeOwnerId).toBe("pid:99999:owner");
        sqlite.close();
    });
    test("dry-run reports stale runs without resuming", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-dry"));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            dryRun: true,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 222;
                },
            },
        }));
        expect(summary.staleCount).toBe(1);
        expect(summary.resumedCount).toBe(0);
        expect(summary.skippedCount).toBe(1);
        expect(summary.wouldResumeRunIds).toEqual(["run-dry"]);
        expect(resumed.length).toBe(0);
        expect(await listEventTypes(adapter, "run-dry")).not.toContain("RunAutoResumed");
        sqlite.close();
    });
    test("skips stale runs whose workflow file is missing", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-missing-workflow"));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => false,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 888;
                },
            },
        }));
        expect(summary.staleCount).toBe(1);
        expect(summary.resumedCount).toBe(0);
        expect(summary.skippedCount).toBe(1);
        expect(resumed).toHaveLength(0);
        const events = await adapter.listEvents("run-missing-workflow", -1, 20);
        const skip = events.find((event) => event.type === "RunAutoResumeSkipped");
        expect(skip).toBeDefined();
        const payload = JSON.parse(skip.payloadJson);
        expect(payload.reason).toBe("missing-workflow");
        sqlite.close();
    });
    test("ignores non-running stale runs", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-failed", { status: "failed" }));
        await adapter.insertRun(runRow("run-cancelled", { status: "cancelled" }));
        await adapter.insertRun(runRow("run-running"));
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 777;
                },
            },
        }));
        expect(summary.staleCount).toBe(1);
        expect(summary.resumedCount).toBe(1);
        expect(resumed).toEqual(["run-running"]);
        sqlite.close();
    });
    test("rate-limits stale resumes per poll", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        for (let i = 0; i < 5; i++) {
            await adapter.insertRun(runRow(`run-${i}`, {
                heartbeatAtMs: now - 60_000 - i * 1_000,
            }));
        }
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            maxConcurrent: 3,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 333;
                },
            },
        }));
        expect(summary.staleCount).toBe(5);
        expect(summary.resumedCount).toBe(3);
        expect(summary.skippedCount).toBe(2);
        expect(resumed.length).toBe(3);
        let rateLimitedEvents = 0;
        for (let i = 0; i < 5; i++) {
            const events = await adapter.listEvents(`run-${i}`, -1, 50);
            for (const event of events) {
                if (event.type !== "RunAutoResumeSkipped")
                    continue;
                const payload = JSON.parse(event.payloadJson);
                if (payload.reason === "rate-limited")
                    rateLimitedEvents++;
            }
        }
        expect(rateLimitedEvents).toBe(2);
        sqlite.close();
    });
    test("poll emits SupervisorPollCompleted event", async () => {
        const { adapter, sqlite } = createTestDb();
        await adapter.insertRun(runRow("run-supervisor-event"));
        await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: () => 444,
            },
        }));
        const events = await adapter.listEvents(SUPERVISOR_EVENT_RUN_ID, -1, 20);
        const types = events.map((event) => event.type);
        expect(types).toContain("SupervisorPollCompleted");
        sqlite.close();
    });
    test("a freshly claimed run is not resumed twice across immediate polls", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-idempotent"));
        const options = {
            adapter,
            staleThresholdMs: 30_000,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 555;
                },
            },
        };
        const first = await Effect.runPromise(supervisorPollEffect(options));
        const second = await Effect.runPromise(supervisorPollEffect(options));
        expect(first.resumedCount).toBe(1);
        expect(second.resumedCount).toBe(0);
        expect(resumed).toEqual(["run-idempotent"]);
        sqlite.close();
    });
    test("resumes a waiting-event run whose approval was decided while detached", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await insertApprovalDecidedRun(adapter, "run-approval-decided");
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            maxConcurrent: 3,
            supervisorId: "approval-resume",
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 9090;
                },
            },
        }));
        expect(summary.staleCount).toBe(0);
        expect(summary.resumedCount).toBe(1);
        expect(summary.skippedCount).toBe(0);
        expect(resumed).toEqual(["run-approval-decided"]);
        expect(await listEventTypes(adapter, "run-approval-decided")).toContain("RunAutoResumed");
        const run = await adapter.getRun("run-approval-decided");
        expect(run?.runtimeOwnerId).toBe("supervisor:approval-resume");
        expect(run?.heartbeatAtMs).toBe(now);
        sqlite.close();
    });
    test("does not resume a waiting-event run whose approval is still undecided", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await insertApprovalDecidedRun(adapter, "run-approval-pending", {
            approvalStatus: "requested",
        });
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            maxConcurrent: 3,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 9091;
                },
            },
        }));
        expect(summary.staleCount).toBe(0);
        expect(summary.resumedCount).toBe(0);
        expect(resumed).toHaveLength(0);
        expect(await listEventTypes(adapter, "run-approval-pending")).not.toContain("RunAutoResumed");
        sqlite.close();
    });
    test("rate-limits an approval-decided run behind a stale run when slots are exhausted", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        await adapter.insertRun(runRow("run-stale"));
        await insertApprovalDecidedRun(adapter, "run-approval-rate-limited");
        const summary = await Effect.runPromise(supervisorPollEffect({
            adapter,
            staleThresholdMs: 30_000,
            maxConcurrent: 1,
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    resumed.push(runId);
                    return 9092;
                },
            },
        }));
        expect(summary.staleCount).toBe(1);
        expect(summary.resumedCount).toBe(1);
        expect(summary.skippedCount).toBe(1);
        expect(resumed).toEqual(["run-stale"]);
        expect(await listEventTypes(adapter, "run-approval-rate-limited")).not.toContain("RunAutoResumed");
        const skip = (await adapter.listEvents("run-approval-rate-limited", -1, 50)).find((event) => event.type === "RunAutoResumeSkipped");
        expect(skip).toBeDefined();
        expect(JSON.parse(skip.payloadJson).reason).toBe("rate-limited");
        sqlite.close();
    });
    test("releases the claim when spawn fails so the next poll retries", async () => {
        const { adapter, sqlite } = createTestDb();
        const resumed = [];
        const original = runRow("run-spawn-fail");
        await adapter.insertRun(original);
        let throwOnSpawn = true;
        const options = {
            adapter,
            staleThresholdMs: 30_000,
            maxConcurrent: 3,
            supervisorId: "spawn-fail",
            deps: {
                now: () => now,
                workflowExists: () => true,
                isPidAlive: () => false,
                spawnResumeDetached: (_workflowPath, runId) => {
                    if (throwOnSpawn) {
                        throw new Error("spawn boom");
                    }
                    resumed.push(runId);
                    return 9093;
                },
            },
        };
        const first = await Effect.runPromise(supervisorPollEffect(options));
        expect(first.staleCount).toBe(1);
        expect(first.resumedCount).toBe(0);
        expect(first.skippedCount).toBe(1);
        expect(resumed).toHaveLength(0);
        expect(await listEventTypes(adapter, "run-spawn-fail")).not.toContain("RunAutoResumed");
        // Claim must have been rolled back to the pre-claim owner/heartbeat so the
        // run still looks stale and a later poll can re-attempt it.
        const afterFail = await adapter.getRun("run-spawn-fail");
        expect(afterFail?.runtimeOwnerId).toBe(original.runtimeOwnerId);
        expect(afterFail?.heartbeatAtMs).toBe(original.heartbeatAtMs);
        // Second poll with a working spawn must succeed (run was not left stuck).
        throwOnSpawn = false;
        const second = await Effect.runPromise(supervisorPollEffect(options));
        expect(second.resumedCount).toBe(1);
        expect(resumed).toEqual(["run-spawn-fail"]);
        expect(await listEventTypes(adapter, "run-spawn-fail")).toContain("RunAutoResumed");
        sqlite.close();
    });
});
